import type { Patient, Tx } from "../db.js";
import { getRedis } from "../redis.js";
import type { Ctx } from "./http/context.js";
import { Problem, forbidden, notFound } from "./problem.js";

/**
 * Patient-level access checks shared by every patient-context operation.
 *   - Tenancy: RLS already hides other practices' patients, so a foreign id is simply 404 (INV-SEC-02).
 *   - Merged records answer 409 `merged` with the survivor id, so the UI can reopen the right chart (INV-ID-04).
 *   - Restricted records (INV-SEC-03): patient-level labels need an active EmergencyAccessGrant for this user. The
 *     identity banner still renders (INV-ID-01); clinical detail does not. OPEN-Q17: which consents also grant access.
 */
export const RESTRICTED_LABELS = ["R", "VIP", "42CFRPart2", "confidential", "restricted"];

export async function activeGrant(
  tx: Tx,
  userId: string,
  patientId: string,
  grantId?: string | null,
) {
  return tx.emergencyAccessGrant.findFirst({
    where: {
      userId,
      patientId,
      expiresAt: { gt: new Date() },
      ...(grantId ? { id: grantId } : {}),
    },
    orderBy: { grantedAt: "desc" },
  });
}

export interface AccessOptions {
  /** Identity-only reads (banner, search rows) that must work even for restricted charts. */
  identityOnly?: boolean;
}

export async function requirePatient(
  ctx: Ctx,
  patientId: string,
  opts: AccessOptions = {},
): Promise<Patient> {
  const p = await ctx.db.patient.findUnique({ where: { id: patientId } });
  if (!p) throw notFound();
  ctx.audit.patient(p.id);
  if (p.mergedIntoId) {
    throw new Problem(409, "merged", "This record was merged into another chart.", {
      survivorId: p.mergedIntoId,
    });
  }
  if (!opts.identityOnly && p.securityLabels.some((l) => RESTRICTED_LABELS.includes(l))) {
    const staff = ctx.principal?.kind === "staff" ? ctx.principal : null;
    if (!staff) throw forbidden("restricted_record", "This record is restricted.");
    const grant = await activeGrant(
      ctx.db,
      staff.userId,
      p.id,
      ctx.headers["x-emergency-access"] ?? null,
    );
    if (!grant)
      throw forbidden(
        "restricted_record",
        "This record is restricted. Request access with a reason.",
      );
    // Break-the-glass reads are tagged so the privacy review can find them.
    ctx.audit.purpose("ETREAT", grant.id);
  }
  return p;
}

/** Whether the current user may see rows carrying these labels (restricted notes, Part 2 data). */
export async function canSeeLabels(
  ctx: Ctx,
  patientId: string,
  labels: string[],
): Promise<boolean> {
  if (!labels.some((l) => RESTRICTED_LABELS.includes(l))) return true;
  const staff = ctx.principal?.kind === "staff" ? ctx.principal : null;
  if (!staff) return false;
  const grant = await activeGrant(ctx.db, staff.userId, patientId);
  return (
    !!grant &&
    labels
      .filter((l) => RESTRICTED_LABELS.includes(l))
      .every((l) => grant.scope.includes(l) || grant.scope.includes("*"))
  );
}

/** Command bar and patients.search "recent" list. */
export async function rememberRecentPatient(userId: string, patientId: string): Promise<void> {
  const key = `recent-patients:${userId}`;
  const r = getRedis();
  await r.lrem(key, 0, patientId);
  await r.lpush(key, patientId);
  await r.ltrim(key, 0, 19);
  await r.expire(key, 30 * 86_400);
}

export async function recentPatientIds(userId: string): Promise<string[]> {
  return getRedis().lrange(`recent-patients:${userId}`, 0, 19);
}
