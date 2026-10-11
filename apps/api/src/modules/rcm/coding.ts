/**
 * Coding assistant (flow:encounter/06, rcm/02): E/M level from MDM or total time, and coding edits on charge lines.
 * Pure functions; handlers persist the result on ChargeItem.holdReasons.
 *
 * E/M follows the 2021+ office/outpatient guidelines: the level is set by 2 of the 3 MDM elements, or by total time
 * on the date of the encounter (published minimum minutes per level).
 * Edits are a curated rule set (OPEN-Q23): no licensed NCCI/MUE tables are loaded, so NCCI pair checks are limited
 * to one E/M per visit, and MUEs to the values carried on the curated procedure codes.
 */

export type Severity = "error" | "warning";
export type EditRule =
  | "modifier"
  | "dx-pointer"
  | "ncci"
  | "mue"
  | "auth"
  | "provider"
  | "pos"
  | "coverage"
  | "filing";

export interface CodingEdit {
  /** Stable per finding (rule + line), used by apply/dismiss. */
  key: string;
  rule: EditRule;
  severity: Severity;
  text: string;
  lineId?: string;
  /** What "apply" does. */
  fix?: { addModifier: string };
  dismissed?: boolean;
  reason?: string;
  invariant?: string;
}

export const RULE_LABEL: Record<EditRule, string> = {
  modifier: "Modifier",
  "dx-pointer": "Dx pointer",
  ncci: "NCCI",
  mue: "Units (MUE)",
  auth: "Prior auth",
  provider: "Provider NPI/TIN",
  pos: "Place of service",
  coverage: "Coverage",
  filing: "Timely filing",
};

// ---------------------------------------------------------------- E/M
type Level = 0 | 1 | 2 | 3; // straightforward, low, moderate, high
const LEVEL_NAME = ["Straightforward", "Low", "Moderate", "High"] as const;
const NEW = ["99202", "99203", "99204", "99205"] as const;
const EST = ["99212", "99213", "99214", "99215"] as const;
const TIME_NEW = [15, 30, 45, 60];
const TIME_EST = [10, 20, 30, 40];

export interface EmInput {
  basis: "mdm" | "time";
  totalMinutes?: number | null;
  problems?: "low" | "moderate" | "high" | null;
  data?: "minimal" | "limited" | "moderate" | "extensive" | null;
  risk?: "minimal" | "low" | "moderate" | "high" | null;
  newPatient: boolean;
}

export interface EmResult {
  code: string;
  basis: "mdm" | "time";
  rationale: string[];
  alternatives: string[];
}

const PROBLEMS: Record<string, Level> = { low: 1, moderate: 2, high: 3 };
const DATA: Record<string, Level> = { minimal: 0, limited: 1, moderate: 2, extensive: 3 };
const RISK: Record<string, Level> = { minimal: 0, low: 1, moderate: 2, high: 3 };

export function suggestEm(i: EmInput): EmResult | null {
  const codes = i.newPatient ? NEW : EST;
  const kind = i.newPatient ? "New patient" : "Established patient";
  if (i.basis === "time") {
    const mins = i.totalMinutes ?? 0;
    const table = i.newPatient ? TIME_NEW : TIME_EST;
    let idx = -1;
    table.forEach((t, n) => {
      if (mins >= t) idx = n;
    });
    if (idx < 0) return null;
    return {
      code: codes[idx]!,
      basis: "time",
      rationale: [kind, `${mins} minutes total time (${codes[idx]} needs ${table[idx]}+)`],
      alternatives: neighbours(codes, idx),
    };
  }
  const p = i.problems ? PROBLEMS[i.problems]! : 0;
  const d = i.data ? DATA[i.data]! : 0;
  const r = i.risk ? RISK[i.risk]! : 0;
  // 2 of 3 elements: the middle value of the three.
  const level = [p, d, r].sort((a, b) => b - a)[1] as Level;
  const atLevel = [p, d, r].filter((x) => x >= level).length;
  return {
    code: codes[level]!,
    basis: "mdm",
    rationale: [
      kind,
      `${atLevel} of 3 elements at ${LEVEL_NAME[level]}`,
      `Problems ${LEVEL_NAME[p]} · Data ${LEVEL_NAME[d]} · Risk ${LEVEL_NAME[r]}`,
    ],
    alternatives: neighbours(codes, level),
  };
}

const neighbours = (codes: readonly string[], idx: number) =>
  [codes[idx - 1], codes[idx + 1]].filter((c): c is string => !!c);

// ---------------------------------------------------------------- edits
export interface LineFacts {
  id: string;
  code: string;
  modifiers: string[];
  units: number;
  dxConditionIds: string[];
  /** From the procedure catalogue: em-new, em-est, preventive, admin, vaccine, lab, procedure, screening, drug. */
  category: string | null;
  mue: number | null;
}

export const isEm = (l: Pick<LineFacts, "category">) =>
  l.category === "em-new" || l.category === "em-est";

/** Same-day procedures that make a separately identifiable E/M need modifier 25. */
const NEEDS_25_WITH = new Set(["admin", "procedure", "preventive"]);

export function lineEdits(lines: LineFacts[], encounterDxIds: Set<string>): CodingEdit[] {
  const out: CodingEdit[] = [];
  const ems = lines.filter(isEm);
  for (const l of lines) {
    if (!l.dxConditionIds.length)
      out.push({
        key: `dx:${l.id}`,
        rule: "dx-pointer",
        severity: "error",
        text: `${l.code} has no diagnosis pointer.`,
        lineId: l.id,
        invariant: "INV-FIN-03",
      });
    else if (l.dxConditionIds.some((id) => !encounterDxIds.has(id)))
      out.push({
        key: `dx-stale:${l.id}`,
        rule: "dx-pointer",
        severity: "error",
        text: `${l.code} points to a diagnosis that is no longer on this visit.`,
        lineId: l.id,
        invariant: "INV-FIN-03",
      });
    if (l.dxConditionIds.length > 4)
      out.push({
        key: `dx-max:${l.id}`,
        rule: "dx-pointer",
        severity: "error",
        text: `${l.code} has more than 4 diagnosis pointers (837P allows 4 per line).`,
        lineId: l.id,
      });
    for (const m of l.modifiers)
      if (!/^[A-Z0-9]{2}$/.test(m))
        out.push({
          key: `mod-format:${l.id}:${m}`,
          rule: "modifier",
          severity: "error",
          text: `Modifier "${m}" on ${l.code} is not a 2-character modifier.`,
          lineId: l.id,
        });
    if (l.mue !== null && l.units > l.mue)
      out.push({
        key: `mue:${l.id}`,
        rule: "mue",
        severity: "error",
        text: `${l.code} is billed with ${l.units} units; the limit per day is ${l.mue}.`,
        lineId: l.id,
      });
  }
  if (ems.length > 1)
    out.push({
      key: `em-dup:${ems[1]!.id}`,
      rule: "ncci",
      severity: "error",
      text: `Only one office E/M can be billed per visit (${ems.map((e) => e.code).join(", ")}).`,
      lineId: ems[1]!.id,
    });
  const em = ems[0];
  if (em) {
    const others = lines.filter((l) => l !== em && l.category && NEEDS_25_WITH.has(l.category));
    if (others.length && !em.modifiers.includes("25")) {
      const o = others[0]!;
      out.push({
        key: `mod25:${em.id}`,
        rule: "modifier",
        severity: "warning",
        text: `Modifier 25 likely needed on ${em.code}. A separate E/M is billed on the same day as ${o.category === "admin" ? "vaccine administration" : "a procedure"} (${o.code}).`,
        lineId: em.id,
        fix: { addModifier: "25" },
      });
    }
    // flow:encounter/06 failure: modifier 25 without a separate diagnosis warns.
    if (others.length && em.modifiers.includes("25")) {
      const procDx = new Set(others.flatMap((o) => o.dxConditionIds));
      if (em.dxConditionIds.length && em.dxConditionIds.every((id) => procDx.has(id)))
        out.push({
          key: `mod25-dx:${em.id}`,
          rule: "modifier",
          severity: "warning",
          text: `Modifier 25 on ${em.code} without a separate diagnosis: every E/M pointer is also on the procedure.`,
          lineId: em.id,
        });
    }
  }
  return out;
}

/** Keeps earlier dismissals (same key) when edits are recomputed. */
export function mergeDismissals(next: CodingEdit[], prior: CodingEdit[]): CodingEdit[] {
  const dismissed = new Map(prior.filter((p) => p.dismissed).map((p) => [p.key, p]));
  return next.map((e) =>
    e.severity === "warning" && dismissed.has(e.key)
      ? { ...e, dismissed: true, reason: dismissed.get(e.key)!.reason }
      : e,
  );
}

export const activeEdits = (edits: CodingEdit[]) => edits.filter((e) => !e.dismissed);
export const blocking = (edits: CodingEdit[]) => activeEdits(edits);
