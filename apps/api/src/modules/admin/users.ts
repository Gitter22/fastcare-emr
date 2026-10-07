import { roleFromEnum } from "@agile-emr/shared";
import type { Prisma, Role, Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { messaging } from "../../gateways/messaging/index.js";
import { limitOf } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { revokeAllForUser } from "../../platform/sessions.js";
import { randomSecret, sha256 } from "../../platform/tokens.js";
import { writeVersion } from "../../platform/versioning.js";
import { canSignFor } from "../auth/staff.js";

/** admin.users-roles: least-privilege access, MFA status, provider linkage (HIPAA workforce controls). */
const INVITE_DAYS = 7;

const userInclude = { roles: true, locations: true, practitioner: true, mfaFactors: true } as const;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

async function userView(tx: Tx, u: UserRow) {
  const locs = u.locations.length
    ? await tx.location.findMany({
        where: { id: { in: u.locations.map((l) => l.locationId) } },
        orderBy: { name: "asc" },
      })
    : [];
  const verified = u.mfaFactors.filter((f) => f.verifiedAt && f.type !== "RECOVERY_CODE");
  const roles = u.roles.map((r) => r.role);
  const sign = roles.map((r) => canSignFor(roleFromEnum(r), !!u.practitioner?.epcsEnabled));
  return {
    id: u.id,
    name: `${u.firstName} ${u.lastName}`,
    email: u.email,
    status:
      u.lockedUntil && u.lockedUntil > new Date() && u.status === "ACTIVE"
        ? ("LOCKED" as const)
        : u.status,
    roles,
    locations: locs.map((l) => ({ id: l.id, name: l.name })),
    ...(u.practitioner ? { practitionerId: u.practitioner.id } : {}),
    mfaEnrolled: !!u.mfaEnrolledAt && verified.length > 0,
    mfaTypes: [...new Set(verified.map((f) => f.type))],
    ...(u.lastLoginAt ? { lastSignInAt: u.lastLoginAt.toISOString() } : {}),
    ...(u.lockedUntil && u.lockedUntil > new Date()
      ? { lockedUntil: u.lockedUntil.toISOString() }
      : {}),
    canSign: {
      notes: sign.some((s) => s.notes),
      orders: sign.some((s) => s.orders),
      prescriptions: sign.some((s) => s.prescriptions),
      controlledSubstances: sign.some((s) => s.controlledSubstances),
    },
  };
}

async function loadUser(ctx: Ctx, id: string): Promise<UserRow> {
  const u = await ctx.db.user.findUnique({ where: { id }, include: userInclude });
  if (!u) throw notFound();
  ctx.audit.resource("User", u.id);
  return u;
}

async function assertNotLastManager(tx: Tx, userId: string, nextRoles: Role[] | null) {
  if (nextRoles?.includes("MANAGER")) return;
  const managers = await tx.userRole.findMany({
    where: { role: "MANAGER", user: { status: { not: "DEACTIVATED" } } },
    select: { userId: true },
  });
  if (managers.length === 1 && managers[0]!.userId === userId) {
    throw conflict(
      "last_manager",
      "The practice needs at least one practice manager. Give someone else the role first.",
    );
  }
}

export const userHandlers: HandlerMap = {
  async listUsers(ctx) {
    const q = ctx.query;
    const term = q.q?.trim();
    const rows = await ctx.db.user.findMany({
      where: {
        ...(term
          ? {
              OR: [
                { firstName: { contains: term, mode: "insensitive" } },
                { lastName: { contains: term, mode: "insensitive" } },
                { email: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(q.role ? { roles: { some: { role: q.role } } } : {}),
        ...(q.status?.length ? { status: { in: q.status as never } } : {}),
      },
      include: userInclude,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: limitOf(q, 500, 200),
    });
    return {
      data: await Promise.all(rows.map((u) => userView(ctx.db, u))),
      nextCursor: null,
      hasMore: false,
    };
  },

  async getUser(ctx) {
    return userView(ctx.db, await loadUser(ctx, ctx.params.userId));
  },

  async inviteUser(ctx) {
    const b = ctx.body;
    const practiceId = ctx.practiceId!;
    const email = b.email.trim().toLowerCase();
    if (await ctx.db.user.findFirst({ where: { email } }))
      throw conflict("duplicate", "Someone in this practice already uses that email.");
    if (!b.roles.length)
      throw unprocessable("validation_failed", "Choose at least one role.", {
        errors: [{ field: "roles", code: "minItems", message: "Choose at least one role." }],
      });
    const [firstName, ...rest] = b.name.trim().split(/\s+/);
    const locations = b.locationIds.length
      ? await ctx.db.location.findMany({ where: { id: { in: b.locationIds } } })
      : [];
    if (locations.length !== b.locationIds.length)
      throw unprocessable("validation_failed", "One of the locations no longer exists.");
    const me = ctx.staff();
    const u = await ctx.db.user.create({
      data: {
        practiceId,
        email,
        firstName: firstName ?? b.name,
        lastName: rest.join(" ") || "",
        phone: b.phone ?? null,
        status: "INVITED",
        activeRole: b.roles[0],
        roles: { create: b.roles.map((role) => ({ practiceId, role, grantedById: me.userId })) },
        locations: { create: locations.map((l) => ({ practiceId, locationId: l.id })) },
      },
    });
    if (b.practitionerId) {
      const p = await ctx.db.practitioner.findUnique({ where: { id: b.practitionerId } });
      if (!p) throw unprocessable("validation_failed", "That provider record no longer exists.");
      if (p.userId)
        throw conflict("duplicate", "That provider record is already linked to a user.");
      await ctx.db.practitioner.update({ where: { id: p.id }, data: { userId: u.id } });
    }
    const token = randomSecret();
    await ctx.db.accountToken.create({
      data: {
        purpose: "invite",
        userId: u.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        createdById: me.userId,
      },
    });
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: practiceId } });
    const link = `${getEnv().WEB_BASE_URL}/accept-invite?token=${token}`;
    ctx.afterCommit(
      async () =>
        void (await messaging.send("EMAIL", email, "staff-invite", {
          practiceName: practice.legalName,
          link,
        })),
    );
    ctx.audit.resource("User", u.id);
    ctx.audit.detail({ roles: b.roles });
    ctx.setHeader("Location", `/api/v1/users/${u.id}`);
    return userView(
      ctx.db,
      await ctx.db.user.findUniqueOrThrow({ where: { id: u.id }, include: userInclude }),
    );
  },

  async updateUser(ctx) {
    const u = await loadUser(ctx, ctx.params.userId);
    const b = ctx.body;
    if (b.activeRole && !u.roles.some((r) => r.role === b.activeRole))
      throw unprocessable("validation_failed", "The user doesn't hold that role.");
    if (
      b.email &&
      b.email.toLowerCase() !== u.email &&
      (await ctx.db.user.findFirst({ where: { email: b.email.toLowerCase(), id: { not: u.id } } }))
    ) {
      throw conflict("duplicate", "Someone in this practice already uses that email.");
    }
    await ctx.db.user.update({
      where: { id: u.id },
      data: {
        ...(b.email ? { email: b.email.toLowerCase() } : {}),
        ...(b.firstName ? { firstName: b.firstName } : {}),
        ...(b.lastName ? { lastName: b.lastName } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.activeRole !== undefined ? { activeRole: b.activeRole } : {}),
        version: { increment: 1 },
      },
    });
    ctx.audit.detail({ fields: Object.keys(b) });
    return userView(ctx.db, await loadUser(ctx, u.id));
  },

  async setUserRoles(ctx) {
    const u = await loadUser(ctx, ctx.params.userId);
    const roles = [...new Set(ctx.body.roles)];
    if (!roles.length) throw unprocessable("validation_failed", "Choose at least one role.");
    if (!ctx.body.reason?.trim())
      throw unprocessable("validation_failed", "Record why access is changing.", {
        errors: [{ field: "reason", code: "required", message: "Required." }],
      });
    await assertNotLastManager(ctx.db, u.id, roles);
    const before = u.roles.map((r) => r.role);
    const me = ctx.staff();
    await ctx.db.userRole.deleteMany({ where: { userId: u.id, role: { notIn: roles } } });
    for (const role of roles.filter((r) => !before.includes(r))) {
      await ctx.db.userRole.create({
        data: { practiceId: ctx.practiceId!, userId: u.id, role, grantedById: me.userId },
      });
    }
    await ctx.db.user.update({
      where: { id: u.id },
      data: {
        activeRole: roles.includes(u.activeRole as Role) ? u.activeRole : roles[0],
        version: { increment: 1 },
      },
    });
    await writeVersion(
      ctx.db,
      ctx.practiceId!,
      "UserRole",
      { id: u.id, version: u.version + 1, roles, before } as never,
      me.userId,
      ctx.body.reason,
    );
    ctx.audit.detail({ before, after: roles });
    // Least privilege takes effect now: the user's sessions end and they sign in with the new roles.
    if (u.id !== me.userId)
      ctx.afterCommit(async () => void (await revokeAllForUser({ userId: u.id }, "roles-changed")));
    return userView(ctx.db, await loadUser(ctx, u.id));
  },

  async unlockUser(ctx) {
    const u = await loadUser(ctx, ctx.params.userId);
    await ctx.db.user.update({
      where: { id: u.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(u.status === "LOCKED" ? { status: "ACTIVE" } : {}),
      },
    });
    return userView(ctx.db, await loadUser(ctx, u.id));
  },

  async resetUserMfa(ctx) {
    const u = await loadUser(ctx, ctx.params.userId);
    await ctx.db.mfaFactor.deleteMany({ where: { userId: u.id } });
    await ctx.db.user.update({ where: { id: u.id }, data: { mfaEnrolledAt: null } });
    ctx.afterCommit(async () => void (await revokeAllForUser({ userId: u.id }, "mfa-reset")));
    return userView(ctx.db, await loadUser(ctx, u.id));
  },

  async deactivateUser(ctx) {
    const u = await loadUser(ctx, ctx.params.userId);
    if (u.id === ctx.staff().userId)
      throw conflict("forbidden_self", "You can't deactivate your own account.");
    if (u.status === "DEACTIVATED")
      throw conflict("invalid_transition", "This user is already deactivated.");
    await assertNotLastManager(ctx.db, u.id, null);
    await ctx.db.user.update({
      where: { id: u.id },
      data: { status: "DEACTIVATED", deactivatedAt: new Date(), version: { increment: 1 } },
    });
    await ctx.db.accountToken.updateMany({
      where: { userId: u.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    ctx.audit.detail({ reason: "recorded" });
    // Termination procedure: every session ends at once; history is kept.
    ctx.afterCommit(async () => void (await revokeAllForUser({ userId: u.id }, "deactivated")));
    return userView(ctx.db, await loadUser(ctx, u.id));
  },
};
