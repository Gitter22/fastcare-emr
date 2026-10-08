import type { Observation } from "@agile-emr/shared";
import { LOINC, cToF, formatHeight, kgToLb } from "@agile-emr/shared";

/**
 * Display of vitals in US clinic units (lb, ft/in, °F); the API stores UCUM canonical units (kg, cm, Cel or [degF]).
 * Values are numbers on the wire as decimal strings; nothing here rounds a value the clinician typed.
 */

const num = (v: string | null | undefined) => (v == null ? null : Number(v));

export const VITAL_LABEL: Record<string, string> = {
  [LOINC.bpPanel]: "BP",
  [LOINC.heartRate]: "Pulse",
  [LOINC.temperature]: "Temp",
  [LOINC.respiratoryRate]: "Resp",
  [LOINC.spo2]: "SpO₂",
  [LOINC.height]: "Height",
  [LOINC.weight]: "Weight",
  [LOINC.bmi]: "BMI",
  [LOINC.pain]: "Pain",
  [LOINC.headCircumference]: "Head circ.",
};

/** One observation's value as shown in the chart ("168/102", "99.1 °F", "182 lb", "5 ft 4 in"). */
export function vitalText(o: Observation, withUnit = true): string {
  const q = num(o.valueQuantity);
  switch (o.loincCode) {
    case LOINC.bpPanel: {
      const c = (o.components ?? {}) as { systolic?: number; diastolic?: number };
      return c.systolic != null ? `${c.systolic}/${c.diastolic}` : (o.valueString ?? "—");
    }
    case LOINC.temperature:
      return q == null ? "—" : `${o.valueUnit === "Cel" ? cToF(q) : q}${withUnit ? " °F" : ""}`;
    case LOINC.weight:
      return q == null ? "—" : `${kgToLb(q)}${withUnit ? " lb" : ""}`;
    case LOINC.height:
      return q == null ? "—" : formatHeight(q);
    case LOINC.spo2:
      return q == null ? "—" : `${q}${withUnit ? " %" : ""}`;
    case LOINC.headCircumference:
      return q == null ? "—" : `${q}${withUnit ? " cm" : ""}`;
    default:
      return q == null ? (o.valueString ?? "—") : String(q);
  }
}

/** Latest observation per LOINC code (input in any order). */
export function latestByCode(obs: Observation[]): Map<string, Observation> {
  const out = new Map<string, Observation>();
  for (const o of [...obs].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt)))
    out.set(o.loincCode, o);
  return out;
}

/** Every reading per code, oldest first (repeat readings are kept and shown). */
export function readingsByCode(obs: Observation[]): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const o of [...obs].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt)))
    out.set(o.loincCode, [...(out.get(o.loincCode) ?? []), o]);
  return out;
}

export const isAbnormal = (o: Observation | undefined) =>
  o?.flag === "ABNORMAL" || o?.flag === "CRITICAL";

/** "H" / "L" marker for a flagged reading (paired with a word in tooltips; never colour alone). */
export const flagMark = (o: Observation | undefined) =>
  !isAbnormal(o) ? null : o!.interpretation === "L" || o!.interpretation === "LL" ? "L" : "H";
