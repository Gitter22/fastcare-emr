import type { Tx } from "../db.js";

/**
 * Balances are derived, never stored (INV-FIN-02, ADR-008): sum of LedgerEntry.amount for the patient (and any
 * records merged into it, whose append-only ledger rows stay on the merged id; INV-ID-04).
 */
export async function patientBalanceCents(
  tx: Tx,
  patientId: string,
  responsibility: "PATIENT" | "INSURANCE" = "PATIENT",
): Promise<number> {
  const r = await tx.$queryRaw<{ c: bigint | null }[]>`
    SELECT round(coalesce(sum(l.amount), 0) * 100)::bigint AS c
    FROM "LedgerEntry" l
    WHERE l.responsibility = ${responsibility}::"Responsibility"
      AND (l."patientId" = ${patientId}::uuid
           OR l."patientId" IN (SELECT id FROM "Patient" WHERE "mergedIntoId" = ${patientId}::uuid))`;
  return Number(r[0]?.c ?? 0);
}

export const centsToMoney = (c: number) => {
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

/** Insurance balance still open on one claim (charges less insurance payments, adjustments and transfers). */
export async function claimInsuranceBalanceCents(tx: Tx, claimId: string): Promise<number> {
  const r = await tx.$queryRaw<{ c: bigint | null }[]>`
    SELECT round(coalesce(sum(amount), 0) * 100)::bigint AS c
    FROM "LedgerEntry" WHERE "claimId" = ${claimId}::uuid AND responsibility = 'INSURANCE'::"Responsibility"`;
  return Number(r[0]?.c ?? 0);
}

/** Insurance balances for many claims at once (lists). */
export async function claimBalancesCents(tx: Tx, claimIds: string[]): Promise<Map<string, number>> {
  if (!claimIds.length) return new Map();
  const rows = await tx.$queryRaw<{ id: string; c: bigint | null }[]>`
    SELECT "claimId"::text AS id, round(coalesce(sum(amount), 0) * 100)::bigint AS c
    FROM "LedgerEntry" WHERE "claimId" = ANY(${claimIds}::uuid[]) AND responsibility = 'INSURANCE'::"Responsibility"
    GROUP BY "claimId"`;
  return new Map(rows.map((r) => [r.id, Number(r.c ?? 0)]));
}

export interface LedgerLine {
  practiceId: string;
  patientId: string;
  type:
    | "CHARGE"
    | "INSURANCE_PAYMENT"
    | "PATIENT_PAYMENT"
    | "CONTRACTUAL_ADJUSTMENT"
    | "TRANSFER_TO_PATIENT"
    | "TRANSFER_TO_INSURANCE"
    | "WRITE_OFF"
    | "REFUND"
    | "RECOUPMENT"
    | "REVERSAL";
  responsibility: "PATIENT" | "INSURANCE";
  /** Signed cents: positive increases what is owed, negative reduces it. */
  cents: number;
  encounterId?: string | null;
  chargeItemId?: string | null;
  claimId?: string | null;
  paymentId?: string | null;
  remittanceId?: string | null;
  carc?: string | null;
  memo?: string | null;
  postedById?: string | null;
}

/** Appends ledger rows (INV-FIN-01: inserts only; corrections are new reversing rows). Zero amounts are skipped. */
export async function postLedger(tx: Tx, lines: LedgerLine[]): Promise<void> {
  const rows = lines.filter((l) => l.cents !== 0);
  if (!rows.length) return;
  await tx.ledgerEntry.createMany({
    data: rows.map((l) => ({
      practiceId: l.practiceId,
      patientId: l.patientId,
      type: l.type,
      responsibility: l.responsibility,
      amount: centsToMoney(l.cents),
      encounterId: l.encounterId ?? null,
      chargeItemId: l.chargeItemId ?? null,
      claimId: l.claimId ?? null,
      paymentId: l.paymentId ?? null,
      remittanceId: l.remittanceId ?? null,
      carc: l.carc ?? null,
      memo: l.memo ?? null,
      postedById: l.postedById ?? null,
    })),
  });
}

/** Moves an insurance amount to the patient: two rows that net to zero across responsibilities. */
export function transferToPatient(
  base: Omit<LedgerLine, "type" | "responsibility" | "cents">,
  cents: number,
): LedgerLine[] {
  return [
    { ...base, type: "TRANSFER_TO_PATIENT", responsibility: "INSURANCE", cents: -cents },
    { ...base, type: "TRANSFER_TO_PATIENT", responsibility: "PATIENT", cents },
  ];
}

export const toCentsDec = (v: { toString(): string } | number | string) =>
  Math.round(Number(typeof v === "object" ? v.toString() : v) * 100);
