import { fromCents, toCents, type LedgerEntry, type Payment } from "@agile-emr/shared";

/** One visit's slice of the ledger: the "By visit" card on billing.patient-account. */
export interface VisitGroup {
  key: string;
  encounterId: string | null;
  claimId: string | null;
  date: string;
  entries: LedgerEntry[];
  charged: string;
  insurancePaid: string;
  adjustments: string;
  patientResponsibility: string;
  payments: string;
  owed: string;
  insurancePending: string;
}

const sum = (rows: LedgerEntry[], pick: (e: LedgerEntry) => boolean) =>
  rows.reduce((t, e) => (pick(e) ? t + toCents(e.amount) : t), 0);

/** Group the ledger by encounter. Sums only; every balance still comes from the ledger rows (INV-FIN-02). */
export function groupByVisit(ledger: LedgerEntry[]): VisitGroup[] {
  const map = new Map<string, LedgerEntry[]>();
  for (const e of ledger) {
    const k = e.encounterId ?? "none";
    map.set(k, [...(map.get(k) ?? []), e]);
  }
  const groups = [...map.entries()].map(([key, raw]): VisitGroup => {
    const entries = [...raw].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
    const type =
      (...t: string[]) =>
      (e: LedgerEntry) =>
        t.includes(e.type);
    return {
      key,
      encounterId: key === "none" ? null : key,
      claimId: entries.find((e) => e.claimId)?.claimId ?? null,
      date: entries[0]!.postedAt,
      entries,
      charged: fromCents(sum(entries, type("CHARGE"))),
      insurancePaid: fromCents(-sum(entries, type("INSURANCE_PAYMENT", "RECOUPMENT"))),
      adjustments: fromCents(-sum(entries, type("CONTRACTUAL_ADJUSTMENT", "WRITE_OFF"))),
      patientResponsibility: fromCents(
        sum(
          entries,
          (e) =>
            e.type === "TRANSFER_TO_PATIENT" ||
            (e.type === "CHARGE" && e.responsibility === "PATIENT"),
        ),
      ),
      payments: fromCents(-sum(entries, type("PATIENT_PAYMENT", "REFUND"))),
      owed: fromCents(sum(entries, (e) => e.responsibility === "PATIENT")),
      insurancePending: fromCents(sum(entries, (e) => e.responsibility === "INSURANCE")),
    };
  });
  return groups.sort((a, b) => b.date.localeCompare(a.date));
}

/** Paid this year: this-year SUCCEEDED payments that are not refunds (spec pa-paid-ytd). */
export function paidYtd(payments: Payment[], now = new Date()): string {
  const year = now.getFullYear();
  return fromCents(
    payments
      .filter(
        (p) =>
          p.status === "SUCCEEDED" && !p.refundOfId && new Date(p.takenAt).getFullYear() === year,
      )
      .reduce((t, p) => t + toCents(p.amount), 0),
  );
}

export const LEDGER_LABEL: Record<string, string> = {
  CHARGE: "Charge",
  INSURANCE_PAYMENT: "Insurance payment",
  PATIENT_PAYMENT: "Patient payment",
  CONTRACTUAL_ADJUSTMENT: "Contractual adjustment",
  TRANSFER_TO_PATIENT: "Moved to patient",
  WRITE_OFF: "Write-off",
  REFUND: "Refund",
  RECOUPMENT: "Recoupment",
  TRANSFER_TO_INSURANCE: "Moved to insurance",
  REVERSAL: "Reversal",
};
