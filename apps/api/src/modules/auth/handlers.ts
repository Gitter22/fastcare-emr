import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { MfaFactor, Role, Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { messaging } from "../../gateways/messaging/index.js";
import { encryptToBytes } from "../../platform/crypto.js";
import {
  REFRESH_COOKIE,
  clearCookie,
  readCookie,
  refreshCookie,
} from "../../platform/http/cookies.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import {
  Problem,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthenticated,
  unprocessable,
} from "../../platform/problem.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  STEP_UP_WINDOW_MS,
  createSession,
  loadPolicy,
  revokeAllForUser,
  revokeSession,
  rotateRefresh,
  updateLiveSession,
  type LiveSession,
} from "../../platform/sessions.js";
import { randomSecret, sha256, signToken } from "../../platform/tokens.js";
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  codeMatches,
  consumeRecoveryCode,
  factorInfo,
  issueRecoveryCodes,
  newTotpSecret,
  sendCode,
  usableFactors,
  verifyTotp,
} from "./mfa.js";
import { burnPasswordCheck, checkPassword, hashPassword, verifyPassword } from "./passwords.js";
import {
  canSignFor,
  homeScreenFor,
  loadStaffProfile,
  permissionsFor,
  pickActiveRole,
} from "./staff.js";

/**
 * Staff authentication (auth.* screens). Password (argon2id) then mandatory MFA (INV-SEC-04); short access JWT plus
 * a rotating refresh cookie; lockout after repeated failures; every attempt audited (INV-SEC-01).
 */
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const ENROLL_TTL = 30 * 60;
const AUTH_COOKIE_PATH = "/api/v1/auth";

interface LoginRow {
  id: string;
  practiceId: string;
  passwordHash: string | null;
  status: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  mfaEnrolledAt: Date | null;
  passwordChangedAt: Date | null;
}

const findForLogin = (tx: Tx, email: string) =>
  tx.$queryRaw<LoginRow[]>`SELECT * FROM find_staff_users_for_login(${email})`;

async function practiceOfUser(tx: Tx, userId: string): Promise<string | null> {
  const r = await tx.$queryRaw<
    { p: string | null }[]
  >`SELECT find_staff_user_practice(${userId}::uuid) AS p`;
  return r[0]?.p ?? null;
}

function sessionTokens(ctx: Ctx, live: LiveSession, refreshToken: string) {
  ctx.setHeader(
    "Set-Cookie",
    refreshCookie(
      REFRESH_COOKIE,
      refreshToken,
      AUTH_COOKIE_PATH,
      Math.ceil((Date.parse(live.absoluteExpiresAt) - Date.now()) / 1000),
    ),
  );
  return {
    accessToken: signToken(
      { typ: "staff", sub: live.userId!, pid: live.practiceId!, sid: live.sessionId },
      ACCESS_TOKEN_TTL_SECONDS,
    ),
    tokenType: "Bearer" as const,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    idleTimeoutSeconds: live.idleSeconds,
    absoluteExpiresAt: live.absoluteExpiresAt,
  };
}

/** Starts a staff session after MFA (or first-factor enrolment). */
async function startStaffSession(ctx: Ctx, userId: string) {
  const user = await loadStaffProfile(ctx.db, userId);
  if (!user) throw unauthenticated();
  const held = user.roles.map((r) => r.role);
  const activeRole = pickActiveRole(held, user.activeRole);
  if (!activeRole)
    throw forbidden("forbidden", "Your account has no role. Ask your practice manager.");
  const policy = await loadPolicy(ctx.db, user.practiceId);
  const { session, refreshToken } = await createSession(ctx.db, {
    subject: "STAFF",
    userId: user.id,
    practiceId: user.practiceId,
    activeRole,
    roles: held,
    practitionerId: user.practitioner?.id ?? null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    policy,
  });
  await ctx.db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
  ctx.audit.actor("staff", user.id, session.sessionId);
  return sessionTokens(ctx, session, refreshToken);
}

async function openChallenge(tx: Tx, user: { id: string; email: string }, factor: MfaFactor) {
  let codeHash: string | null = null;
  if (factor.type === "SMS" && factor.phone) codeHash = await sendCode("SMS", factor.phone);
  if (factor.type === "EMAIL") codeHash = await sendCode("EMAIL", user.email);
  return tx.mfaChallenge.create({
    data: {
      userId: user.id,
      factorId: factor.id,
      type: factor.type,
      codeHash,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
}

function enrollmentToken(userId: string, practiceId: string) {
  return {
    enrollmentToken: signToken({ typ: "enroll", sub: userId, pid: practiceId }, ENROLL_TTL),
    expiresAt: new Date(Date.now() + ENROLL_TTL * 1000).toISOString(),
  };
}

/** Verifies a factor response (TOTP, SMS/email code, recovery code). */
async function verifyFactor(
  tx: Tx,
  factors: MfaFactor[],
  input: { factorId?: string; code?: string; recoveryCode?: string; webauthnAssertion?: unknown },
  challengeCodeHash: string | null,
  challengeFactorId: string | null,
): Promise<MfaFactor | "recovery" | null> {
  if (input.recoveryCode)
    return (await consumeRecoveryCode(tx, factors, input.recoveryCode)) ? "recovery" : null;
  if (input.webauthnAssertion)
    throw unprocessable(
      "webauthn_unavailable",
      "Security keys are not available yet. Use another method.",
    );
  const factor = factors.find((f) => f.id === (input.factorId ?? challengeFactorId)) ?? null;
  if (!factor || !factor.verifiedAt) return null;
  if (factor.type === "TOTP") return verifyTotp(factor.secret, input.code) ? factor : null;
  if (factor.type === "SMS" || factor.type === "EMAIL") {
    return factor.id === challengeFactorId && codeMatches(challengeCodeHash, input.code)
      ? factor
      : null;
  }
  return null;
}

export const authHandlers: HandlerMap = {
  // ------------------------------------------------------------------ sign-in
  async login(ctx) {
    const { email, password } = ctx.body;
    ctx.audit.suppressDefault();
    const candidates = await findForLogin(ctx.db, email);
    let matched: LoginRow | null = null;
    for (const c of candidates) {
      if (await verifyPassword(c.passwordHash, password)) {
        matched = c;
        break;
      }
    }
    const now = new Date();
    const recordFailure = (target: LoginRow | null, reason: string) =>
      ctx.onFailure(async (tx) => {
        await tx.loginAttempt.create({
          data: {
            practiceId: target?.practiceId ?? null,
            email: email.toLowerCase(),
            subject: "STAFF",
            success: false,
            reason,
            ip: ctx.ip,
            userAgent: ctx.userAgent?.slice(0, 300),
          },
        });
        if (!target) return;
        await tx.$executeRaw`SELECT set_config('app.practice_id', ${target.practiceId}, true)`;
        if (reason === "bad-password") {
          const count = target.failedLoginCount + 1;
          await tx.user.update({
            where: { id: target.id },
            data: {
              failedLoginCount: count,
              ...(count >= LOCK_AFTER
                ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
                : {}),
            },
          });
        }
        const { writeAuditEntries } = await import("../../platform/audit.js");
        await writeAuditEntries(
          tx,
          {
            practiceId: target.practiceId,
            actorType: "staff",
            actorId: target.id,
            actorRole: null,
            sessionId: null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          [
            {
              action: "LOGIN_FAILED",
              outcome: "FAILURE",
              operationId: "login",
              resourceType: "User",
              resourceId: target.id,
              detail: { reason },
            },
          ],
        );
      });

    if (!matched) {
      if (!candidates.length) await burnPasswordCheck(password);
      const target = candidates.length === 1 ? candidates[0]! : null;
      if (target?.lockedUntil && target.lockedUntil > now) {
        recordFailure(target, "locked");
        throw new Problem(
          423,
          "account_locked",
          "Too many attempts. Try again later or ask your practice manager to unlock your account.",
        );
      }
      recordFailure(target, "bad-password");
      throw unauthenticated("invalid_credentials", "Email or password is incorrect.");
    }
    if ((matched.lockedUntil && matched.lockedUntil > now) || matched.status === "LOCKED") {
      recordFailure(matched, "locked");
      throw new Problem(
        423,
        "account_locked",
        "Too many attempts. Try again later or ask your practice manager to unlock your account.",
      );
    }

    await ctx.bindTenant(matched.practiceId);
    ctx.audit.actor("staff", matched.id);
    await ctx.db.user.update({ where: { id: matched.id }, data: { failedLoginCount: 0 } });
    await ctx.db.loginAttempt.create({
      data: {
        practiceId: matched.practiceId,
        email: email.toLowerCase(),
        subject: "STAFF",
        success: true,
        reason: "password-ok",
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 300),
      },
    });
    ctx.audit.add({
      action: "LOGIN",
      resourceType: "User",
      resourceId: matched.id,
      detail: { step: "password" },
    });

    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: matched.id },
      include: { mfaFactors: true },
    });
    const maxAgeDays = Number(
      (
        await ctx.db.practiceSetting.findFirst({
          where: { practiceId: user.practiceId, key: "security.passwordMaxAgeDays" },
        })
      )?.value ?? 0,
    );
    const passwordExpired =
      !!maxAgeDays &&
      !!user.passwordChangedAt &&
      Date.now() - user.passwordChangedAt.getTime() > maxAgeDays * 86_400_000;
    const factors = usableFactors(user.mfaFactors);
    if (!factors.length) {
      // INV-SEC-04: no session without MFA; first sign-in goes to enrolment.
      return {
        next: "enroll" as const,
        ...enrollmentToken(user.id, user.practiceId),
        passwordExpired,
      };
    }
    const def = factors[0]!;
    const challenge = await openChallenge(ctx.db, user, def);
    return {
      next: "mfa" as const,
      challengeId: challenge.id,
      factors: factors.map((f) => factorInfo(f, def.id)),
      defaultFactorId: def.id,
      passwordExpired,
    };
  },

  async verifyMfa(ctx) {
    ctx.audit.suppressDefault();
    const challenge = await ctx.db.mfaChallenge.findUnique({ where: { id: ctx.body.challengeId } });
    if (!challenge?.userId || challenge.consumedAt || challenge.expiresAt < new Date()) {
      throw unauthenticated("challenge_expired", "This sign-in attempt expired. Sign in again.");
    }
    if (challenge.attempts >= MAX_ATTEMPTS)
      throw new Problem(429, "too_many_attempts", "Too many wrong codes. Sign in again.");
    const practiceId = await practiceOfUser(ctx.db, challenge.userId);
    if (!practiceId) throw unauthenticated();
    await ctx.bindTenant(practiceId);
    ctx.audit.actor("staff", challenge.userId);
    const factors = await ctx.db.mfaFactor.findMany({ where: { userId: challenge.userId } });
    const ok = await verifyFactor(
      ctx.db,
      factors,
      ctx.body,
      challenge.codeHash,
      challenge.factorId,
    );
    if (!ok) {
      ctx.onFailure(async (tx) => {
        await tx.mfaChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`;
        const { writeAuditEntries } = await import("../../platform/audit.js");
        await writeAuditEntries(
          tx,
          {
            practiceId,
            actorType: "staff",
            actorId: challenge.userId,
            actorRole: null,
            sessionId: null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          [
            {
              action: "MFA",
              outcome: "FAILURE",
              operationId: "verifyMfa",
              resourceType: "User",
              resourceId: challenge.userId,
            },
          ],
        );
      });
      throw unauthenticated("wrong_code", "That code didn't work. Check it and try again.");
    }
    await ctx.db.mfaChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    if (ok !== "recovery")
      await ctx.db.mfaFactor.update({ where: { id: ok.id }, data: { lastUsedAt: new Date() } });
    const tokens = await startStaffSession(ctx, challenge.userId);
    ctx.audit.add({
      action: "MFA",
      resourceType: "User",
      resourceId: challenge.userId,
      detail: { method: ok === "recovery" ? "recovery-code" : ok.type },
    });
    ctx.audit.add({
      action: "LOGIN",
      resourceType: "User",
      resourceId: challenge.userId,
      detail: { step: "session" },
    });
    return tokens;
  },

  async resendMfaCode(ctx) {
    const challenge = await ctx.db.mfaChallenge.findUnique({ where: { id: ctx.body.challengeId } });
    if (!challenge?.userId || challenge.consumedAt || challenge.expiresAt < new Date()) {
      throw unauthenticated("challenge_expired", "This sign-in attempt expired. Sign in again.");
    }
    const practiceId = await practiceOfUser(ctx.db, challenge.userId);
    if (!practiceId) throw unauthenticated();
    await ctx.bindTenant(practiceId);
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: challenge.userId },
      include: { mfaFactors: true },
    });
    const factor = usableFactors(user.mfaFactors).find(
      (f) => f.id === (ctx.body.factorId ?? challenge.factorId),
    );
    if (!factor || (factor.type !== "SMS" && factor.type !== "EMAIL" && factor.type !== "TOTP"))
      throw badRequest("bad_request", "Choose a text or email method.");
    let codeHash: string | null = null;
    if (factor.type === "SMS" && factor.phone) codeHash = await sendCode("SMS", factor.phone);
    if (factor.type === "EMAIL") codeHash = await sendCode("EMAIL", user.email);
    await ctx.db.mfaChallenge.update({
      where: { id: challenge.id },
      data: {
        factorId: factor.id,
        type: factor.type,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
  },

  async getWebAuthnAssertionOptions() {
    // OPEN-Q16: WebAuthn is specified but not built yet. The UI hides security keys.
    throw unprocessable(
      "webauthn_unavailable",
      "Security keys are not available yet. Use another method.",
    );
  },

  // ------------------------------------------------------------------ enrolment
  async startMfaEnrollment(ctx) {
    const who = ctx.principal;
    if (!who || (who.kind !== "staff" && who.kind !== "enrollment")) throw unauthenticated();
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: who.userId } });
    const { type } = ctx.body;
    // Unconfirmed attempts are replaced, never accumulated.
    await ctx.db.mfaFactor.deleteMany({ where: { userId: user.id, verifiedAt: null } });
    if (type === "TOTP") {
      const { secret, otpauthUri } = newTotpSecret(user.email);
      const f = await ctx.db.mfaFactor.create({
        data: {
          userId: user.id,
          practiceId: user.practiceId,
          type: "TOTP",
          label: ctx.body.label ?? "Authenticator app",
          secret: encryptToBytes(secret),
        },
      });
      ctx.audit.resource("MfaFactor", f.id);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 });
      return { factorId: f.id, type: "TOTP", otpauthUri, secretBase32: secret, qrCodeDataUrl };
    }
    if (type === "SMS" || type === "EMAIL") {
      const target = type === "SMS" ? ctx.body.phone : user.email;
      if (!target)
        throw unprocessable("validation_failed", "Enter a mobile number.", {
          errors: [{ field: "phone", code: "required", message: "Enter a mobile number." }],
        });
      const f = await ctx.db.mfaFactor.create({
        data: {
          userId: user.id,
          practiceId: user.practiceId,
          type,
          label: ctx.body.label ?? (type === "SMS" ? "Text message" : "Email"),
          phone: type === "SMS" ? target : null,
        },
      });
      const codeHash = await sendCode(type, target);
      await ctx.db.mfaChallenge.create({
        data: {
          userId: user.id,
          factorId: f.id,
          type,
          codeHash,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
      ctx.audit.resource("MfaFactor", f.id);
      return { factorId: f.id, type, codeSentTo: factorInfo(f, null).maskedTarget ?? "your email" };
    }
    throw unprocessable("factor_unavailable", "Use an authenticator app or text message.");
  },

  async confirmMfaEnrollment(ctx) {
    const who = ctx.principal;
    if (!who || (who.kind !== "staff" && who.kind !== "enrollment")) throw unauthenticated();
    const factor = await ctx.db.mfaFactor.findFirst({
      where: { id: ctx.params.factorId, userId: who.userId },
    });
    if (!factor) throw notFound();
    if (factor.verifiedAt) throw conflict("already_confirmed", "This method is already set up.");
    let ok = false;
    if (factor.type === "TOTP") ok = verifyTotp(factor.secret, ctx.body.code);
    else {
      const ch = await ctx.db.mfaChallenge.findFirst({
        where: {
          userId: who.userId,
          factorId: factor.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      ok = !!ch && ch.attempts < MAX_ATTEMPTS && codeMatches(ch.codeHash, ctx.body.code);
      if (ch)
        await ctx.db.mfaChallenge.update({
          where: { id: ch.id },
          data: ok ? { consumedAt: new Date() } : { attempts: { increment: 1 } },
        });
    }
    if (!ok) throw unprocessable("wrong_code", "That code didn't work. Check it and try again.");
    const verified = await ctx.db.mfaFactor.update({
      where: { id: factor.id },
      data: { verifiedAt: new Date() },
    });
    ctx.audit.resource("MfaFactor", factor.id);
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: who.userId } });
    const first = !user.mfaEnrolledAt;
    let recoveryCodes: string[] | undefined;
    let session: Awaited<ReturnType<typeof startStaffSession>> | undefined;
    if (first) {
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          mfaEnrolledAt: new Date(),
          status: user.status === "INVITED" ? "ACTIVE" : user.status,
        },
      });
      recoveryCodes = await issueRecoveryCodes(ctx.db, {
        userId: user.id,
        practiceId: user.practiceId,
      });
      if (who.kind === "enrollment") session = await startStaffSession(ctx, user.id);
    }
    return {
      factor: factorInfo(verified, null),
      ...(recoveryCodes ? { recoveryCodes } : {}),
      ...(session ? { session } : {}),
    };
  },

  async deleteMfaFactor(ctx) {
    const me = ctx.staff();
    const factors = usableFactors(
      await ctx.db.mfaFactor.findMany({ where: { userId: me.userId } }),
    );
    const f = factors.find((x) => x.id === ctx.params.factorId);
    if (!f) throw notFound();
    if (factors.length <= 1)
      throw conflict(
        "last_factor",
        "Keep at least one sign-in method. Add another before removing this one.",
      );
    await ctx.db.mfaFactor.delete({ where: { id: f.id } });
    ctx.audit.resource("MfaFactor", f.id);
  },

  async regenerateRecoveryCodes(ctx) {
    const me = ctx.staff();
    const codes = await issueRecoveryCodes(ctx.db, {
      userId: me.userId,
      practiceId: me.practiceId,
    });
    ctx.audit.resource("User", me.userId);
    return { codes, generatedAt: new Date().toISOString() };
  },

  // ------------------------------------------------------------------ session
  async refreshSession(ctx) {
    const token = readCookie(ctx.headers.cookie, REFRESH_COOKIE);
    if (!token) throw unauthenticated();
    const r = await rotateRefresh(token);
    if ("error" in r) {
      ctx.setHeader("Set-Cookie", clearCookie(REFRESH_COOKIE, AUTH_COOKIE_PATH));
      throw unauthenticated(r.error, "Your session ended. Sign in again.");
    }
    if (r.session.subject !== "STAFF") throw unauthenticated();
    return sessionTokens(ctx, r.session, r.refreshToken);
  },

  async logout(ctx) {
    const me = ctx.staff();
    ctx.audit.resource("Session", me.sessionId);
    ctx.afterCommit(() => revokeSession(me.sessionId, "logout"));
    ctx.setHeader("Set-Cookie", clearCookie(REFRESH_COOKIE, AUTH_COOKIE_PATH));
  },

  async getMe(ctx) {
    const me = ctx.staff();
    const user = await loadStaffProfile(ctx.db, me.userId);
    if (!user) throw unauthenticated();
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: me.practiceId } });
    const locations = user.locations.length
      ? await ctx.db.location.findMany({
          where: { id: { in: user.locations.map((l) => l.locationId) }, active: true },
          orderBy: { name: "asc" },
        })
      : await ctx.db.location.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const { getRedis } = await import("../../redis.js");
    const liveRaw = await getRedis().get(`sess:${me.sessionId}`);
    const live = liveRaw
      ? (JSON.parse(liveRaw) as LiveSession & { activeLocationId?: string })
      : null;
    const stepUpUntil = me.stepUpAt ? new Date(me.stepUpAt.getTime() + STEP_UP_WINDOW_MS) : null;
    return {
      user: {
        id: user.id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        ...(user.practitioner ? { practitionerId: user.practitioner.id } : {}),
      },
      practice: { id: practice.id, name: practice.legalName, timezone: practice.timezone },
      roles: user.roles.map((r) => r.role),
      activeRole: me.role.toUpperCase() as Role,
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
      ...(live?.activeLocationId
        ? { activeLocationId: live.activeLocationId }
        : locations[0]
          ? { activeLocationId: locations[0].id }
          : {}),
      permissions: permissionsFor(me.role),
      canSign: canSignFor(me.role, !!user.practitioner?.epcsEnabled),
      session: {
        idleTimeoutSeconds: live?.idleSeconds ?? 900,
        absoluteExpiresAt: live?.absoluteExpiresAt ?? new Date().toISOString(),
        ...(stepUpUntil && stepUpUntil > new Date()
          ? { stepUpValidUntil: stepUpUntil.toISOString() }
          : {}),
      },
      homeScreen: homeScreenFor(me.role),
    };
  },

  async switchActiveRole(ctx) {
    const me = ctx.staff();
    const user = await loadStaffProfile(ctx.db, me.userId);
    if (!user) throw unauthenticated();
    const held = user.roles.map((r) => r.role);
    if (!held.includes(ctx.body.role)) throw forbidden("forbidden", "You don't hold that role.");
    if (ctx.body.locationId) {
      const allowed = user.locations.length
        ? user.locations.some((l) => l.locationId === ctx.body.locationId)
        : !!(await ctx.db.location.findFirst({ where: { id: ctx.body.locationId } }));
      if (!allowed) throw forbidden("forbidden", "You don't work at that location.");
    }
    await ctx.db.user.update({ where: { id: me.userId }, data: { activeRole: ctx.body.role } });
    await ctx.db.session.update({
      where: { id: me.sessionId },
      data: { activeRole: ctx.body.role },
    });
    await updateLiveSession(me.sessionId, {
      activeRole: ctx.body.role,
      ...(ctx.body.locationId ? ({ activeLocationId: ctx.body.locationId } as object) : {}),
    });
    ctx.audit.resource("User", me.userId);
    ctx.audit.detail({ activeRole: ctx.body.role });
    // Answer as the new role.
    (ctx.principal as { role: string }).role = ctx.body.role.toLowerCase();
    return authHandlers.getMe!(ctx as never) as never;
  },

  async stepUp(ctx) {
    const me = ctx.staff();
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: me.userId },
      include: { mfaFactors: true },
    });
    ctx.audit.resource("User", me.userId);
    ctx.audit.detail({ purpose: ctx.body.purpose.slice(0, 60) });
    if (!(await verifyPassword(user.passwordHash, ctx.body.password))) {
      throw unauthenticated("invalid_credentials", "Password is incorrect.");
    }
    const factors = usableFactors(user.mfaFactors);
    const factor = factors.find((f) => f.id === ctx.body.factorId) ?? factors[0];
    if (!factor) throw forbidden("mfa_required", "Set up a sign-in method first.");
    let ok = false;
    if (factor.type === "TOTP") ok = verifyTotp(factor.secret, ctx.body.code);
    else if (factor.type === "SMS" || factor.type === "EMAIL") {
      const open = await ctx.db.mfaChallenge.findFirst({
        where: {
          userId: me.userId,
          factorId: factor.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!ctx.body.code || !open) {
        // The 422 rolls the request back, so the challenge is stored by the failure hook (it must survive).
        const id = randomUUID();
        const codeHash = await sendCode(
          factor.type,
          factor.type === "SMS" ? factor.phone! : user.email,
        );
        ctx.onFailure(async (tx) => {
          await tx.mfaChallenge.create({
            data: {
              id,
              userId: me.userId,
              factorId: factor.id,
              type: factor.type,
              codeHash,
              expiresAt: new Date(Date.now() + CODE_TTL_MS),
            },
          });
        });
        throw new Problem(
          422,
          "mfa_code_sent",
          `We sent a code to ${factorInfo(factor, null).maskedTarget ?? "you"}.`,
          { challengeId: id, factorId: factor.id },
        );
      }
      ok = codeMatches(open.codeHash, ctx.body.code);
      if (ok)
        await ctx.db.mfaChallenge.update({
          where: { id: open.id },
          data: { consumedAt: new Date() },
        });
    }
    if (!ok) throw unauthenticated("wrong_code", "That code didn't work. Check it and try again.");
    const at = new Date();
    await ctx.db.session.update({ where: { id: me.sessionId }, data: { stepUpAt: at } });
    await updateLiveSession(me.sessionId, { stepUpAt: at.toISOString() });
    return {
      validUntil: new Date(at.getTime() + STEP_UP_WINDOW_MS).toISOString(),
      purpose: ctx.body.purpose,
    };
  },

  // ------------------------------------------------------------------ passwords and invitations
  async forgotPassword(ctx) {
    const candidates = await findForLogin(ctx.db, ctx.body.email);
    for (const c of candidates) {
      if (c.status === "DEACTIVATED") continue;
      const token = randomSecret();
      await ctx.db.accountToken.create({
        data: {
          purpose: "password-reset",
          userId: c.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const link = `${getEnv().WEB_BASE_URL}/reset-password/${token}`;
      ctx.afterCommit(async () => {
        await messaging.send("EMAIL", ctx.body.email, "password-reset", { link });
      });
    }
    // Same answer whether or not the account exists.
    return { requestId: ctx.requestId, status: "accepted" };
  },

  async checkPassword(ctx) {
    return checkPassword(ctx.body.password, { email: ctx.body.email });
  },

  async resetPassword(ctx) {
    const t = await ctx.db.accountToken.findUnique({
      where: { tokenHash: sha256(ctx.body.token) },
    });
    if (!t || t.purpose !== "password-reset" || t.usedAt || t.expiresAt < new Date() || !t.userId) {
      throw unprocessable(
        "invalid_token",
        "This link has expired or was already used. Request a new one.",
      );
    }
    const practiceId = await practiceOfUser(ctx.db, t.userId);
    if (!practiceId)
      throw unprocessable(
        "invalid_token",
        "This link has expired or was already used. Request a new one.",
      );
    await ctx.bindTenant(practiceId);
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: t.userId } });
    ctx.audit.actor("staff", user.id);
    ctx.audit.resource("User", user.id);
    await setNewPassword(ctx.db, user, ctx.body.newPassword);
    await ctx.db.accountToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
    ctx.afterCommit(
      async () => void (await revokeAllForUser({ userId: user.id }, "password-reset")),
    );
  },

  async changePassword(ctx) {
    const me = ctx.staff();
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: me.userId } });
    if (!(await verifyPassword(user.passwordHash, ctx.body.currentPassword))) {
      throw unprocessable("validation_failed", "Current password is incorrect.", {
        errors: [
          {
            field: "currentPassword",
            code: "incorrect",
            message: "Current password is incorrect.",
          },
        ],
      });
    }
    await setNewPassword(ctx.db, user, ctx.body.newPassword);
    ctx.audit.resource("User", me.userId);
    ctx.afterCommit(
      async () =>
        void (await revokeAllForUser({ userId: me.userId }, "password-change", me.sessionId)),
    );
  },

  async getInvitation(ctx) {
    const { token, user } = await invitation(ctx, ctx.params.token);
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: user.practiceId } });
    return {
      practiceName: practice.legalName,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      roles: user.roles.map((r) => r.role),
      expiresAt: token.expiresAt.toISOString(),
    };
  },

  async acceptInvitation(ctx) {
    if (!ctx.body.acceptTerms)
      throw unprocessable("validation_failed", "Accept the terms to continue.", {
        errors: [
          { field: "acceptTerms", code: "required", message: "Accept the terms to continue." },
        ],
      });
    const { token, user } = await invitation(ctx, ctx.params.token);
    ctx.audit.actor("staff", user.id);
    ctx.audit.resource("User", user.id);
    await setNewPassword(ctx.db, user, ctx.body.password);
    await ctx.db.accountToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return enrollmentToken(user.id, user.practiceId);
  },

  async listMySessions(ctx) {
    const me = ctx.staff();
    const rows = await ctx.db.session.findMany({
      where: {
        userId: me.userId,
        revokedAt: null,
        absoluteExpiresAt: { gt: new Date() },
        idleExpiresAt: { gt: new Date(Date.now() - 60_000) },
      },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map((s) => ({
      id: s.id,
      current: s.id === me.sessionId,
      ...(s.userAgent ? { userAgent: s.userAgent, deviceName: deviceName(s.userAgent) } : {}),
      ...(s.ip ? { ipAddress: s.ip } : {}),
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
    }));
  },

  async revokeSession(ctx) {
    const me = ctx.staff();
    const s = await ctx.db.session.findFirst({
      where: { id: ctx.params.sessionId, userId: me.userId },
    });
    if (!s) throw notFound();
    ctx.audit.resource("Session", s.id);
    ctx.afterCommit(() => revokeSession(s.id, "user-revoked"));
  },

  async revokeOtherSessions(ctx) {
    const me = ctx.staff();
    ctx.audit.resource("User", me.userId);
    ctx.afterCommit(
      async () =>
        void (await revokeAllForUser({ userId: me.userId }, "user-revoked-others", me.sessionId)),
    );
  },

  async listMySecurityEvents(ctx) {
    const me = ctx.staff();
    const limit = Math.min(Number((ctx.query as { limit?: number }).limit ?? 50), 200);
    const cursor = (ctx.query as { cursor?: string }).cursor;
    const rows = await ctx.db.auditEvent.findMany({
      where: {
        actorId: me.userId,
        action: { in: ["LOGIN", "LOGOUT", "LOGIN_FAILED", "MFA"] },
        at: { gte: new Date(Date.now() - 30 * 86_400_000) },
        ...(cursor ? { id: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((e) => ({
        id: e.id.toString(),
        at: e.at.toISOString(),
        action: e.action,
        outcome: e.outcome,
        actor: { userId: e.actorId ?? undefined, ...(e.actorRole ? { role: e.actorRole } : {}) },
        ...(e.resourceType ? { entityType: e.resourceType } : {}),
        ...(e.resourceId ? { entityId: e.resourceId } : {}),
        ...(e.ip ? { ipAddress: e.ip } : {}),
        ...(e.userAgent ? { userAgent: e.userAgent } : {}),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id.toString() : null,
      hasMore: rows.length > limit,
    };
  },
};

async function setNewPassword(
  tx: Tx,
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    passwordHash: string | null;
  },
  password: string,
) {
  const check = checkPassword(password, {
    email: user.email,
    names: [user.firstName, user.lastName],
  });
  if (user.passwordHash && (await verifyPassword(user.passwordHash, password)))
    check.failures.push("reused");
  if (check.failures.length) {
    throw unprocessable("validation_failed", "Choose a stronger password.", {
      errors: check.failures.map((f) => ({
        field: "password",
        code: f,
        message: passwordMessage(f),
      })),
    });
  }
  await tx.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
}

const passwordMessage = (f: string) =>
  ({
    minLength: "Use at least 12 characters.",
    breached: "This password appears in known data breaches. Choose another.",
    containsName: "Don't include your name or email.",
    reused: "Choose a password you haven't used here before.",
  })[f] ?? "Choose another password.";

async function invitation(ctx: Ctx, raw: string) {
  const token = await ctx.db.accountToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (
    !token ||
    token.purpose !== "invite" ||
    token.usedAt ||
    token.expiresAt < new Date() ||
    !token.userId
  ) {
    throw notFound(
      "This invitation has expired or was already used. Ask your practice manager for a new one.",
    );
  }
  const practiceId = await practiceOfUser(ctx.db, token.userId);
  if (!practiceId) throw notFound();
  await ctx.bindTenant(practiceId);
  const user = await ctx.db.user.findUniqueOrThrow({
    where: { id: token.userId },
    include: { roles: true },
  });
  if (user.status === "DEACTIVATED") throw notFound();
  return { token, user };
}

function deviceName(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}
