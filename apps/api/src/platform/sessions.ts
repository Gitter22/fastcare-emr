import { prisma, type Role, type SessionSubject, type Tx } from "../db.js";
import { getRedis } from "../redis.js";
import { randomSecret, sha256 } from "./tokens.js";

/**
 * Server-side sessions (INV-SEC-04, HIPAA §164.312(a)(2)(iii)). The Session row is the record (listing, revocation,
 * absolute expiry); a Redis key with a sliding TTL equal to the idle timeout is the per-request liveness check, the
 * same pattern agile-emr's session.ts uses. Revoking deletes the key, so the next request fails immediately.
 */
export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

/** OPEN-Q13 safe default: 15 min idle, 12 h absolute; practices override via security.* settings. */
export const DEFAULT_POLICY: SessionPolicy = { idleMinutes: 15, absoluteHours: 12 };
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export interface LiveSession {
  sessionId: string;
  subject: SessionSubject;
  userId: string | null;
  portalUserId: string | null;
  practiceId: string | null;
  activeRole: Role | null;
  /** Roles held when the session started; role changes revoke sessions (setUserRoles). */
  roles: Role[];
  practitionerId: string | null;
  stepUpAt: string | null;
  absoluteExpiresAt: string;
  idleSeconds: number;
}

const key = (sid: string) => `sess:${sid}`;

export async function loadPolicy(tx: Tx, practiceId: string | null): Promise<SessionPolicy> {
  if (!practiceId) return DEFAULT_POLICY;
  const rows = await tx.practiceSetting.findMany({
    where: {
      practiceId,
      key: { in: ["security.sessionTimeoutMinutes", "security.absoluteTimeoutHours"] },
    },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const idle = Number(get("security.sessionTimeoutMinutes"));
  const abs = Number(get("security.absoluteTimeoutHours"));
  return {
    idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_POLICY.idleMinutes,
    absoluteHours: Number.isFinite(abs) && abs > 0 ? abs : DEFAULT_POLICY.absoluteHours,
  };
}

export async function createSession(
  tx: Tx,
  input: {
    subject: SessionSubject;
    userId?: string | null;
    portalUserId?: string | null;
    practiceId: string | null;
    activeRole?: Role | null;
    roles?: Role[];
    practitionerId?: string | null;
    ip: string | null;
    userAgent: string | null;
    policy: SessionPolicy;
  },
): Promise<{ session: LiveSession; refreshToken: string }> {
  const refreshToken = randomSecret();
  const now = Date.now();
  const row = await tx.session.create({
    data: {
      practiceId: input.practiceId,
      subject: input.subject,
      userId: input.userId ?? null,
      portalUserId: input.portalUserId ?? null,
      refreshTokenHash: sha256(refreshToken),
      mfaVerifiedAt: new Date(now),
      activeRole: input.activeRole ?? null,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      idleExpiresAt: new Date(now + input.policy.idleMinutes * 60_000),
      absoluteExpiresAt: new Date(now + input.policy.absoluteHours * 3_600_000),
    },
  });
  const live: LiveSession = {
    sessionId: row.id,
    subject: row.subject,
    userId: row.userId,
    portalUserId: row.portalUserId,
    practiceId: row.practiceId,
    activeRole: row.activeRole,
    roles: input.roles ?? [],
    practitionerId: input.practitionerId ?? null,
    stepUpAt: null,
    absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
    idleSeconds: input.policy.idleMinutes * 60,
  };
  await getRedis().set(key(row.id), JSON.stringify(live), "EX", live.idleSeconds);
  return { session: live, refreshToken };
}

/** Per-request check: alive, not idle, not past absolute expiry. Slides the idle window. */
export async function touchSession(sessionId: string): Promise<LiveSession | null> {
  const redis = getRedis();
  const raw = await redis.get(key(sessionId));
  if (!raw) return null;
  const live = JSON.parse(raw) as LiveSession;
  if (Date.parse(live.absoluteExpiresAt) < Date.now()) {
    await revokeSession(sessionId, "absolute-timeout");
    return null;
  }
  await redis.expire(key(sessionId), live.idleSeconds);
  // Mirror lastSeenAt/idleExpiresAt to the row at most once a minute (account-security listing).
  if (await redis.set(`sess-seen:${sessionId}`, "1", "EX", 60, "NX")) {
    void prisma.session
      .update({
        where: { id: sessionId },
        data: {
          lastSeenAt: new Date(),
          idleExpiresAt: new Date(Date.now() + live.idleSeconds * 1000),
        },
      })
      .catch(() => undefined);
  }
  return live;
}

export async function updateLiveSession(
  sessionId: string,
  patch: Partial<LiveSession>,
): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(key(sessionId));
  if (!raw) return;
  const live = { ...(JSON.parse(raw) as LiveSession), ...patch };
  await redis.set(key(sessionId), JSON.stringify(live), "EX", live.idleSeconds);
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await getRedis().del(key(sessionId));
  await prisma.session
    .updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    .catch(() => undefined);
}

export async function revokeAllForUser(
  where: { userId?: string; portalUserId?: string },
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await prisma.session.findMany({
    where: {
      ...where,
      revokedAt: null,
      ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
    },
    select: { id: true },
  });
  for (const r of rows) await revokeSession(r.id, reason);
  return rows.length;
}

/** Rotate the refresh token (cookie). Enforces idle and absolute timeouts from the row. */
export async function rotateRefresh(
  refreshToken: string,
): Promise<
  | { session: LiveSession; refreshToken: string }
  | { error: "session_expired" | "session_idle_timeout" | "unauthenticated" }
> {
  const row = await prisma.session.findUnique({
    where: { refreshTokenHash: sha256(refreshToken) },
  });
  if (!row || row.revokedAt) return { error: "unauthenticated" };
  const now = Date.now();
  if (row.absoluteExpiresAt.getTime() < now) {
    await revokeSession(row.id, "absolute-timeout");
    return { error: "session_expired" };
  }
  const live = await getRedis().get(key(row.id));
  if (!live || row.idleExpiresAt.getTime() < now - 60_000) {
    // Redis key gone means the idle window passed (or the session was revoked).
    await revokeSession(row.id, "idle-timeout");
    return { error: "session_idle_timeout" };
  }
  const next = randomSecret();
  await prisma.session.update({
    where: { id: row.id },
    data: { refreshTokenHash: sha256(next), lastSeenAt: new Date() },
  });
  const session = JSON.parse(live) as LiveSession;
  await getRedis().expire(key(row.id), session.idleSeconds);
  return { session, refreshToken: next };
}
