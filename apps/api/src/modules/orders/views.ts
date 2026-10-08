import type { DiagnosticReport, Prisma, ServiceRequest, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import { transitionsFrom } from "../../platform/stateMachine.js";

export const srInclude = {
  reasons: true,
  specimens: { orderBy: { collectedAt: "desc" } },
  diagnosticReports: { orderBy: { issuedAt: "desc" } },
} satisfies Prisma.ServiceRequestInclude;

export type SrRow = Prisma.ServiceRequestGetPayload<{ include: typeof srInclude }>;

/** OrderStatus enum value -> states.yaml id (RESULTED_FINAL -> resulted-final). */
export const orderStateId = (s: ServiceRequest["status"]) => s.toLowerCase().replace(/_/g, "-");

export function reportSummary(r: DiagnosticReport) {
  return {
    id: r.id,
    patientId: r.patientId,
    code: r.loincCode,
    display: r.display,
    status: r.status,
    issuedAt: r.issuedAt,
    flag: r.flag ?? "NORMAL",
    reviewed: !!r.reviewedAt,
    released: !!r.releasedToPortalAt,
    performer: r.performerLab ?? undefined,
  };
}

export async function authorizationFor(tx: Tx, srIds: string[]) {
  if (!srIds.length) return new Map<string, unknown>();
  const auths = await tx.authorization.findMany({ where: { serviceRequestId: { in: srIds } } });
  return new Map(auths.map((a) => [a.serviceRequestId!, a]));
}

export function srView(row: SrRow, authorization?: unknown) {
  return toDto("ServiceRequestView", {
    ...row,
    reasons: row.reasons,
    specimen: row.specimens[0],
    results: row.diagnosticReports.map(reportSummary),
    authorization,
    allowedTransitions: transitionsFrom("order", orderStateId(row.status)),
  });
}

export async function srViews(tx: Tx, rows: SrRow[]) {
  const auth = await authorizationFor(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => srView(r, auth.get(r.id)));
}

export async function loadSrRow(tx: Tx, id: string) {
  return tx.serviceRequest.findUnique({ where: { id }, include: srInclude });
}
