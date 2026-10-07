import type { Tx } from "../db.js";
import { displayName } from "../modules/patients/domain.js";

/** AuditEventEntry pages for admin.audit-log, chart.access-log and account security (INV-SEC-01). */
export interface AuditRow {
  id: bigint;
  at: Date;
  action: string;
  outcome: string;
  actorId: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  patientId: string | null;
  operationId: string | null;
  ip: string | null;
  userAgent: string | null;
  emergencyAccessId: string | null;
  purposeOfUse: string | null;
}

export async function auditPage(tx: Tx, rows: AuditRow[], limit: number) {
  const slice = rows.slice(0, limit);
  const userIds = [...new Set(slice.map((r) => r.actorId).filter((x): x is string => !!x))];
  const patientIds = [...new Set(slice.map((r) => r.patientId).filter((x): x is string => !!x))];
  const [users, patients] = await Promise.all([
    tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
    tx.patient.findMany({
      where: { id: { in: patientIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        middleName: true,
        suffix: true,
        mrn: true,
      },
    }),
  ]);
  const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  const pById = new Map(patients.map((p) => [p.id, p]));
  return {
    data: slice.map((e) => {
      const p = e.patientId ? pById.get(e.patientId) : undefined;
      return {
        id: e.id.toString(),
        at: e.at.toISOString(),
        action: e.action as never,
        outcome: e.outcome as never,
        actor: {
          ...(e.actorId ? { userId: e.actorId } : {}),
          ...(e.actorId && names.get(e.actorId) ? { name: names.get(e.actorId) } : {}),
          ...(e.actorRole ? { role: e.actorRole as never } : {}),
        },
        ...(e.resourceType ? { entityType: e.resourceType } : {}),
        ...(e.resourceId ? { entityId: e.resourceId } : {}),
        ...(e.patientId ? { patientId: e.patientId } : {}),
        ...(p ? { patientName: displayName(p), patientMrn: p.mrn } : {}),
        ...(e.operationId ? { operation: e.operationId } : {}),
        ...(e.ip ? { ipAddress: e.ip } : {}),
        ...(e.userAgent ? { userAgent: e.userAgent } : {}),
        ...(e.purposeOfUse ? { reason: e.purposeOfUse } : {}),
        ...(e.emergencyAccessId ? { emergencyAccessGrantId: e.emergencyAccessId } : {}),
      };
    }),
    nextCursor: rows.length > limit && slice.length ? slice[slice.length - 1]!.id.toString() : null,
    hasMore: rows.length > limit,
  };
}
