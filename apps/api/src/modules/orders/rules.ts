import type { OrderCategory, OrderPriority, Tx } from "../../db.js";
import { addDays } from "../../platform/time.js";
import { aoeQuestionsOf, staticItem } from "./catalog.js";
import type { SrRow } from "./views.js";

/**
 * Order-entry rules (encounter.orders): every order gets an expected-by date (INV-SAFE-07), needs a linked
 * diagnosis before signing (INV-SAFE-08), required AOE answers, and an ABN when Medicare is unlikely to cover it.
 */

/** Days until a result is expected, by category and priority. */
export function defaultExpectedBy(
  category: OrderCategory,
  priority: OrderPriority,
  today: string,
): string {
  const urgent = priority === "STAT" ? 1 : priority === "ASAP" || priority === "URGENT" ? 3 : null;
  const days =
    category === "LAB"
      ? (urgent ?? 14)
      : category === "IMAGING" || category === "PROCEDURE"
        ? (urgent ?? 30)
        : category === "REFERRAL"
          ? urgent
            ? 14
            : 45
          : 30;
  return addDays(today, days);
}

/**
 * Tests Medicare covers only for specific diagnoses or at limited frequency (NCD-limited). Ordered with screening
 * (Z) diagnoses only, they need a signed ABN before the order goes out.
 */
const NCD_LIMITED = new Set([
  "1989-3",
  "2857-1",
  "57698-3",
  "4548-4",
  "3016-3",
  "2132-9",
  "2284-8",
]);

export interface OrderIssue {
  serviceRequestId: string;
  severity: "error" | "warning";
  code: "missing-dx" | "medical-necessity" | "aoe" | "duplicate" | "auth-required" | "abn";
  text: string;
}

export async function isMedicarePrimary(tx: Tx, patientId: string) {
  const cov = await tx.coverage.findFirst({
    where: { patientId, status: "active" },
    orderBy: { order: "asc" },
    include: { payer: true },
  });
  return !!cov && /medicare/i.test(cov.payer.name);
}

/** Issues for a set of an encounter's open orders. Errors block signing; warnings need acknowledging. */
export async function validateOrders(
  tx: Tx,
  patientId: string,
  orders: SrRow[],
): Promise<OrderIssue[]> {
  const issues: OrderIssue[] = [];
  const open = orders.filter((o) => o.status === "PENDED");
  if (!open.length) return issues;
  const [compendium, conditions, active, medicare] = await Promise.all([
    tx.labCompendiumItem.findMany({
      where: { id: { in: open.map((o) => o.labCompendiumItemId).filter((x): x is string => !!x) } },
    }),
    tx.condition.findMany({
      where: { id: { in: open.flatMap((o) => o.reasons.map((r) => r.conditionId)) } },
      select: { id: true, icd10Code: true },
    }),
    tx.serviceRequest.findMany({
      where: {
        patientId,
        id: { notIn: open.map((o) => o.id) },
        status: { in: ["PENDED", "SIGNED", "SENT", "COLLECTED", "RESULTED_PRELIM"] },
      },
      select: { code: true, display: true, status: true },
    }),
    isMedicarePrimary(tx, patientId),
  ]);
  const compById = new Map(compendium.map((c) => [c.id, c]));
  const dxById = new Map(conditions.map((c) => [c.id, c.icd10Code ?? ""]));

  for (const o of open) {
    if (!o.reasons.length)
      issues.push({
        serviceRequestId: o.id,
        severity: "error",
        code: "missing-dx",
        text: `${o.display} needs a linked diagnosis.`,
      });
    const answers = (o.aoeAnswers ?? {}) as Record<string, unknown>;
    const missing = aoeQuestionsOf(compById.get(o.labCompendiumItemId ?? "") ?? null).filter(
      (q) => q.required && (answers[q.code] === undefined || answers[q.code] === ""),
    );
    if (missing.length)
      issues.push({
        serviceRequestId: o.id,
        severity: "error",
        code: "aoe",
        text: `${o.display}: answer ${missing.map((m) => `"${m.text}"`).join(", ")}.`,
      });
    const dup =
      active.find((a) => a.code === o.code) ??
      open.find((p) => p.id !== o.id && p.code === o.code && p.createdAt < o.createdAt);
    if (dup)
      issues.push({
        serviceRequestId: o.id,
        severity: "warning",
        code: "duplicate",
        text: `${o.display} is already ordered and not yet resulted.`,
      });
    if (o.category !== "LAB" && staticItem(o.code)?.requiresAuth)
      issues.push({
        serviceRequestId: o.id,
        severity: "warning",
        code: "auth-required",
        text: `${o.display} usually needs prior authorization; a task goes to the referrals team after signing.`,
      });
    const dx = o.reasons.map((r) => dxById.get(r.conditionId) ?? "");
    if (medicare && NCD_LIMITED.has(o.code) && dx.length && dx.every((c) => c.startsWith("Z")))
      issues.push({
        serviceRequestId: o.id,
        severity: "error",
        code: "abn",
        text: `Medicare may not cover ${o.display} for a screening diagnosis. Have the patient sign an ABN.`,
      });
  }
  return issues;
}
