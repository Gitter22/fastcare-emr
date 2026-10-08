/**
 * Clinical domain rules shared by the chart and the encounter: the vitals catalogue (LOINC + UCUM), alert ranges,
 * BMI, and questionnaire scoring. Pure functions only (no database), so they are unit-testable.
 */

import { LOINC, cToF } from "@agile-emr/shared";

export { bmi } from "@agile-emr/shared";

export { LOINC, VITAL_DISPLAY } from "@agile-emr/shared";

/** The codes the vitals grid and rooming form show, in display order. */
export const VITAL_CODES = [
  LOINC.bpPanel,
  LOINC.heartRate,
  LOINC.temperature,
  LOINC.respiratoryRate,
  LOINC.spo2,
  LOINC.height,
  LOINC.weight,
  LOINC.bmi,
  LOINC.pain,
  LOINC.headCircumference,
] as const;

/** Alert ranges (practice setting `vitals.alertRanges`; these are the defaults). Temperature is in °F. */
export interface AlertRanges {
  systolic: { low: number; high: number };
  diastolic: { low: number; high: number };
  heartRate: { low: number; high: number };
  respiratoryRate: { low: number; high: number };
  temperatureF: { low: number; high: number };
  spo2: { low: number };
}

export const DEFAULT_ALERT_RANGES: AlertRanges = {
  systolic: { low: 90, high: 160 },
  diastolic: { low: 50, high: 100 },
  heartRate: { low: 50, high: 120 },
  respiratoryRate: { low: 10, high: 24 },
  temperatureF: { low: 95, high: 100.4 },
  spo2: { low: 92 },
};

export const isAlertRanges = (v: unknown): v is AlertRanges =>
  !!v &&
  typeof v === "object" &&
  ["systolic", "diastolic", "heartRate", "respiratoryRate", "temperatureF", "spo2"].every(
    (k) => typeof (v as Record<string, unknown>)[k] === "object",
  );

export interface VitalsReading {
  systolic?: number | null;
  diastolic?: number | null;
  heartRate?: number | null;
  respiratoryRate?: number | null;
  temperature?: number | null;
  temperatureUnit?: "cel" | "degf" | null;
  spo2?: number | null;
}

export interface VitalAlert {
  code: string;
  text: string;
}

/**
 * Out-of-range checks (flow:checkin/04 failure "Out-of-range vital prompts re-measure"). Each alert names the value
 * and the range it crossed, in plain words.
 */
export function vitalAlerts(v: VitalsReading, r: AlertRanges): VitalAlert[] {
  const out: VitalAlert[] = [];
  if (v.systolic != null && v.diastolic != null) {
    const high = v.systolic >= r.systolic.high || v.diastolic >= r.diastolic.high;
    const low = v.systolic < r.systolic.low || v.diastolic < r.diastolic.low;
    if (high)
      out.push({
        code: "bp-high",
        text: `BP ${v.systolic}/${v.diastolic} is above the alert range (${r.systolic.high}/${r.diastolic.high}).`,
      });
    else if (low)
      out.push({
        code: "bp-low",
        text: `BP ${v.systolic}/${v.diastolic} is below the alert range (${r.systolic.low}/${r.diastolic.low}).`,
      });
  }
  const check = (
    value: number | null | undefined,
    range: { low?: number; high?: number },
    code: string,
    label: string,
    unit = "",
  ) => {
    if (value == null) return;
    if (range.high != null && value >= range.high)
      out.push({
        code: `${code}-high`,
        text: `${label} ${value}${unit} is above the alert range (${range.high}${unit}).`,
      });
    else if (range.low != null && value < range.low)
      out.push({
        code: `${code}-low`,
        text: `${label} ${value}${unit} is below the alert range (${range.low}${unit}).`,
      });
  };
  check(v.heartRate, r.heartRate, "hr", "Pulse");
  check(v.respiratoryRate, r.respiratoryRate, "rr", "Respiratory rate");
  check(v.spo2, r.spo2, "spo2", "SpO₂", "%");
  if (v.temperature != null) {
    const f = v.temperatureUnit === "cel" ? cToF(v.temperature) : v.temperature;
    check(f, r.temperatureF, "temp", "Temperature", " °F");
  }
  return out;
}

/** Physiologic limits: values outside are typing errors, not readings (422). */
export const PLAUSIBLE = {
  systolic: [40, 300],
  diastolic: [20, 200],
  heartRate: [20, 300],
  respiratoryRate: [4, 80],
  temperatureF: [80, 115],
  spo2: [40, 100],
  heightCm: [20, 260],
  weightKg: [0.3, 400],
  painScore: [0, 10],
  headCircumferenceCm: [20, 70],
} as const;

/**
 * Questionnaire scoring. `scoring` on a Questionnaire is {method: "sum", bands: [{min, label, positive?}]}; answers
 * are {linkId: valueCoding.code} where each answer option carries a numeric `score`.
 */
export interface QuestionItem {
  linkId: string;
  text: string;
  answerOption?: Array<{ code: string; display: string; score?: number }>;
}
export interface Scoring {
  method: "sum";
  bands: Array<{ min: number; label: string; positive?: boolean }>;
}

export function scoreResponse(
  items: QuestionItem[],
  answers: Record<string, string>,
  scoring: Scoring | null,
): { score: number | null; label: string | null; positive: boolean } {
  if (!scoring) return { score: null, label: null, positive: false };
  let score = 0;
  for (const item of items) {
    const code = answers[item.linkId];
    const opt = item.answerOption?.find((o) => o.code === code);
    score += opt?.score ?? 0;
  }
  const band = [...scoring.bands].sort((a, b) => b.min - a.min).find((b) => score >= b.min);
  return { score, label: band?.label ?? null, positive: !!band?.positive };
}
