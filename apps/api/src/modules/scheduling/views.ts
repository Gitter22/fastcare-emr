import { stateId, type AppointmentView } from "@agile-emr/shared";
import type { Appointment, Tx } from "../../db.js";
import { centsToMoney } from "../../platform/ledger.js";
import { displayName } from "../patients/domain.js";
import { toSummary } from "../patients/service.js";
import { transitionsFrom } from "../../platform/stateMachine.js";

/** Consents every visit needs on file (front desk "forms" column). OPEN-Q18: practice-configurable list. */
export const REQUIRED_CONSENTS = ["NOTICE_OF_PRIVACY_PRACTICES", "FINANCIAL_POLICY"] as const;

/**
 * AppointmentView rows in one batch (calendar, day lists, boards). Balance is derived from the ledger
 * (INV-FIN-02); copay due comes from the latest eligibility on the primary coverage unless already collected today.
 */
export async function appointmentViews(tx: Tx, appts: Appointment[]): Promise<AppointmentView[]> {
  if (!appts.length) return [];
  const patientIds = [...new Set(appts.map((a) => a.patientId))];
  const [
    patients,
    practitioners,
    locations,
    rooms,
    visitTypes,
    coverages,
    consents,
    checkins,
    events,
    balances,
    paidToday,
  ] = await Promise.all([
    tx.patient.findMany({ where: { id: { in: patientIds } }, include: { contactPoints: true } }),
    tx.practitioner.findMany({
      where: { id: { in: [...new Set(appts.map((a) => a.practitionerId))] } },
    }),
    tx.location.findMany({ where: { id: { in: [...new Set(appts.map((a) => a.locationId))] } } }),
    tx.room.findMany({
      where: { id: { in: appts.map((a) => a.roomId).filter((x): x is string => !!x) } },
    }),
    tx.visitType.findMany({ where: { id: { in: [...new Set(appts.map((a) => a.visitTypeId))] } } }),
    tx.coverage.findMany({
      where: { patientId: { in: patientIds }, status: "active" },
      orderBy: { order: "asc" },
      include: { eligibilityChecks: { orderBy: { requestedAt: "desc" }, take: 1 } },
    }),
    tx.consent.findMany({
      where: {
        patientId: { in: patientIds },
        status: "ACTIVE",
        revokedAt: null,
        type: { in: [...REQUIRED_CONSENTS] },
      },
    }),
    tx.checkinSession.findMany({ where: { appointmentId: { in: appts.map((a) => a.id) } } }),
    tx.appointmentStatusEvent.findMany({
      where: { appointmentId: { in: appts.map((a) => a.id) } },
      orderBy: { at: "desc" },
    }),
    tx.$queryRaw<{ patientId: string; c: bigint }[]>`
      SELECT coalesce(p."mergedIntoId", p.id) AS "patientId", round(sum(l.amount) * 100)::bigint AS c
      FROM "LedgerEntry" l JOIN "Patient" p ON p.id = l."patientId"
      WHERE l.responsibility = 'PATIENT' AND coalesce(p."mergedIntoId", p.id) = ANY(${patientIds}::uuid[])
      GROUP BY 1`,
    tx.payment.findMany({
      where: {
        patientId: { in: patientIds },
        status: "SUCCEEDED",
        takenAt: { gte: new Date(Date.now() - 18 * 3_600_000) },
      },
      select: { patientId: true },
    }),
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const P = by(patients),
    PR = by(practitioners),
    L = by(locations),
    R = by(rooms),
    V = by(visitTypes);
  const bal = new Map(balances.map((b) => [b.patientId, Number(b.c)]));
  const paid = new Set(paidToday.map((p) => p.patientId));
  return appts.map((a) => {
    const p = P.get(a.patientId)!;
    const pr = PR.get(a.practitionerId);
    const cov = coverages.find((c) => c.patientId === a.patientId);
    const elig = cov?.eligibilityChecks[0];
    const missing = REQUIRED_CONSENTS.filter(
      (t) => !consents.some((c) => c.patientId === a.patientId && c.type === t),
    ).length;
    const lastEvent = events.find((e) => e.appointmentId === a.id);
    const balance = bal.get(a.patientId) ?? 0;
    const room = a.roomId ? R.get(a.roomId) : undefined;
    const vt = V.get(a.visitTypeId)!;
    const checkin = checkins.find((c) => c.appointmentId === a.id);
    return {
      id: a.id,
      status: a.status,
      start: a.start.toISOString(),
      end: a.end.toISOString(),
      modality: a.modality,
      visitType: { id: vt.id, name: vt.name, ...(vt.color ? { color: vt.color } : {}) },
      practitioner: { id: a.practitionerId, name: pr ? practitionerName(pr) : "Provider" },
      location: { id: a.locationId, name: L.get(a.locationId)?.name ?? "" },
      ...(room ? { room: { id: room.id, name: room.name } } : {}),
      patient: toSummary(p),
      ...(a.reason ? { reason: a.reason } : {}),
      // No coverage = self-pay (field absent); coverage never checked = UNKNOWN, never shown as self-pay.
      ...(cov ? { eligibility: elig?.status ?? "UNKNOWN" } : {}),
      ...(elig?.copay &&
      !paid.has(a.patientId) &&
      ["BOOKED", "CONFIRMED", "ARRIVED"].includes(a.status)
        ? { copayDue: centsToMoney(Math.round(elig.copay.toNumber() * 100)) }
        : {}),
      ...(balance ? { balanceDue: centsToMoney(balance) } : {}),
      ...(checkin ? { checkinStatus: checkin.status } : {}),
      formsOutstanding: missing,
      minutesInStatus: Math.max(
        0,
        Math.round((Date.now() - (lastEvent?.at ?? a.updatedAt).getTime()) / 60_000),
      ),
      version: a.version,
    };
  });
}

export const practitionerName = (p: {
  firstName: string;
  lastName: string;
  credential: string | null;
}) =>
  p.credential === "MD" || p.credential === "DO"
    ? `Dr. ${p.firstName} ${p.lastName}`
    : `${p.firstName} ${p.lastName}${p.credential ? `, ${p.credential}` : ""}`;

export function allowedTransitions(a: Appointment): string[] {
  return transitionsFrom("appointment", stateId("appointment", a.status));
}

export { displayName };
