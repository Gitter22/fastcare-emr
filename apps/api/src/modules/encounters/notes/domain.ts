/**
 * Clinical note rules (encounter.note, encounter.sign). Pure functions: section layout, lock expiry and the sign
 * pre-flight (INV-SAFE-08, INV-DATA-02). The service gathers the facts; these functions decide.
 */

export const BASE_SECTIONS = [
  { key: "cc", title: "Chief complaint" },
  { key: "hpi", title: "History of present illness" },
  { key: "ros", title: "Review of systems" },
  { key: "exam", title: "Exam" },
  { key: "data", title: "Data reviewed" },
] as const;

/** Assessment & plan text is kept per encounter diagnosis: section key `ap:<conditionId>`. */
export const AP_PREFIX = "ap:";
export const apKey = (conditionId: string) => `${AP_PREFIX}${conditionId}`;
export const isApKey = (key: string) => key.startsWith(AP_PREFIX);

export function validSectionKey(key: string) {
  return BASE_SECTIONS.some((s) => s.key === key) || /^ap:[0-9a-f-]{36}$/.test(key);
}

/** Section order for storage and display: base sections, then A&P blocks by diagnosis rank. */
export function sectionOrdinal(key: string, diagnosisRanks: Map<string, number>): number {
  const i = BASE_SECTIONS.findIndex((s) => s.key === key);
  if (i >= 0) return i;
  return 100 + (diagnosisRanks.get(key.slice(AP_PREFIX.length)) ?? 99);
}

/** Edit lock ("locked by another user"): held while editing, renewed by saves, lapses after two idle minutes. */
export const LOCK_TTL_MS = 2 * 60 * 1000;
export const lockExpiry = (lockedAt: Date) => new Date(lockedAt.getTime() + LOCK_TTL_MS);
export const lockHeldByOther = (
  note: { lockedByUserId: string | null; lockedAt: Date | null },
  userId: string,
  now = new Date(),
) =>
  !!note.lockedByUserId &&
  note.lockedByUserId !== userId &&
  !!note.lockedAt &&
  lockExpiry(note.lockedAt) > now;

export interface PreflightFacts {
  sections: Array<{ key: string; content: string }>;
  pendingAi: Array<{ sectionKey: string }>;
  diagnoses: Array<{ id: string; icd10Code: string | null; display: string }>;
  unsignedRx: Array<{ display: string }>;
  ordersWithoutDx: Array<{ display: string }>;
  chargesWithoutPointer: Array<{ code: string }>;
  lockedBy: string | null;
  cosigner: { userId: string; name: string } | null;
  cosignRuleApplies: boolean;
  unspecified: Array<{ code: string; display: string }>;
}

export interface Preflight {
  canSign: boolean;
  blockers: Array<{ code: string; text: string; sectionKey?: string }>;
  warnings: Array<{ code: string; text: string }>;
  requiresCosign: boolean;
  cosigner?: { userId: string; name: string };
  passed: string[];
}

const SECTION_TITLE = Object.fromEntries(BASE_SECTIONS.map((s) => [s.key, s.title])) as Record<
  string,
  string
>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function computePreflight(f: PreflightFacts): Preflight {
  const blockers: Preflight["blockers"] = [];
  const warnings: Preflight["warnings"] = [];
  const passed: string[] = [];

  if (f.lockedBy)
    blockers.push({ code: "note_locked", text: `${f.lockedBy} is editing this note` });

  // INV-DATA-02: AI-drafted text must be accepted or edited before signing.
  const aiSections = [...new Set(f.pendingAi.map((a) => a.sectionKey))];
  for (const key of aiSections)
    blockers.push({
      code: "ai_text_unaccepted",
      text: `AI-drafted ${SECTION_TITLE[key] ?? "assessment and plan"} text not yet accepted`,
      sectionKey: key,
    });
  if (!aiSections.length) passed.push("No AI-drafted text waiting for review");

  // INV-SAFE-08: unsigned Rx, orders without a diagnosis, charges without a diagnosis pointer.
  if (f.unsignedRx.length)
    blockers.push({
      code: "unsigned_rx",
      text: `${plural(f.unsignedRx.length, "prescription")} not signed: ${f.unsignedRx.map((r) => r.display).join(", ")}`,
    });
  else passed.push("No unsigned prescriptions");
  for (const o of f.ordersWithoutDx)
    blockers.push({ code: "order_without_dx", text: `${o.display} has no linked diagnosis` });
  if (!f.ordersWithoutDx.length) passed.push("Every order has a linked diagnosis");
  if (f.chargesWithoutPointer.length)
    blockers.push({
      code: "charge_without_pointer",
      text: `${plural(f.chargesWithoutPointer.length, "charge")} without a diagnosis pointer: ${f.chargesWithoutPointer.map((c) => c.code).join(", ")}`,
    });
  else passed.push("Every charge has a diagnosis pointer");

  const filled = new Set(f.sections.filter((s) => s.content.trim()).map((s) => s.key));
  if (!filled.has("cc")) warnings.push({ code: "empty_cc", text: "Chief complaint is empty" });
  if (!f.diagnoses.length)
    warnings.push({ code: "no_diagnosis", text: "No diagnosis recorded for this visit" });
  const noPlan = f.diagnoses.filter((d) => !filled.has(apKey(d.id)));
  if (noPlan.length)
    warnings.push({
      code: "plan_missing",
      text: `No plan written for ${noPlan.map((d) => d.display).join(", ")}`,
    });
  for (const u of f.unspecified)
    warnings.push({
      code: "unspecified_dx",
      text: `${u.code} is unspecified; a more specific code may apply`,
    });

  if (f.cosignRuleApplies && f.cosigner)
    passed.push(`Routes to ${f.cosigner.name} for co-signature`);
  else if (f.cosignRuleApplies)
    blockers.push({
      code: "cosigner_missing",
      text: "A co-signature is required but no supervising provider is set up",
    });
  else passed.push("No co-signature required for this provider");

  return {
    canSign: blockers.length === 0,
    blockers,
    warnings,
    requiresCosign: f.cosignRuleApplies,
    ...(f.cosigner && f.cosignRuleApplies ? { cosigner: f.cosigner } : {}),
    passed,
  };
}
