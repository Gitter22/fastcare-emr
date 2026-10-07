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
