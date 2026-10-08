/**
 * Clinical code catalogue shared by the API and the web app: LOINC codes for vitals and screenings, the
 * point-of-care tests offered at rooming, tobacco status answers (SNOMED CT) and unit conversions. Hand-written
 * (not generated): these are clinical constants, not API contracts.
 */

export const LOINC = {
  bpPanel: "85354-9",
  systolic: "8480-6",
  diastolic: "8462-4",
  heartRate: "8867-4",
  respiratoryRate: "9279-1",
  temperature: "8310-5",
  spo2: "59408-5",
  height: "8302-2",
  weight: "29463-7",
  bmi: "39156-5",
  pain: "72514-3",
  headCircumference: "9843-4",
  tobacco: "72166-2",
  phq2: "55757-9",
  phq9: "44249-1",
  sdoh: "96777-8",
} as const;

export const VITAL_DISPLAY: Record<string, string> = {
  [LOINC.bpPanel]: "Blood pressure",
  [LOINC.heartRate]: "Heart rate",
  [LOINC.respiratoryRate]: "Respiratory rate",
  [LOINC.temperature]: "Body temperature",
  [LOINC.spo2]: "Oxygen saturation",
  [LOINC.height]: "Body height",
  [LOINC.weight]: "Body weight",
  [LOINC.bmi]: "Body mass index",
  [LOINC.pain]: "Pain severity (0-10)",
  [LOINC.headCircumference]: "Head circumference",
};

/** Point-of-care tests offered at rooming. `options` = qualitative result choices; otherwise a numeric value. */
export const POC_TESTS: ReadonlyArray<{
  loinc: string;
  display: string;
  unit?: string;
  options?: readonly string[];
}> = [
  { loinc: "2339-0", display: "Glucose, blood (POC)", unit: "mg/dL" },
  { loinc: "4548-4", display: "Hemoglobin A1c (POC)", unit: "%" },
  { loinc: "34714-6", display: "INR (POC)" },
  { loinc: "78012-2", display: "Rapid strep (group A)", options: ["Negative", "Positive"] },
  { loinc: "2106-3", display: "Pregnancy test, urine (hCG)", options: ["Negative", "Positive"] },
  { loinc: "94558-4", display: "COVID-19 antigen", options: ["Negative", "Positive"] },
  { loinc: "80382-5", display: "Influenza A antigen", options: ["Negative", "Positive"] },
  { loinc: "80383-3", display: "Influenza B antigen", options: ["Negative", "Positive"] },
  {
    loinc: "5792-7",
    display: "Urine glucose (dipstick)",
    options: ["Negative", "Trace", "1+", "2+", "3+", "4+"],
  },
];

/** Tobacco smoking status (LOINC 72166-2 answers, SNOMED CT). */
export const TOBACCO_STATUS: ReadonlyArray<{ code: string; display: string }> = [
  { code: "266919005", display: "Never smoked tobacco" },
  { code: "8517006", display: "Former smoker" },
  { code: "449868002", display: "Smokes tobacco daily" },
  { code: "428041000124106", display: "Occasional tobacco smoker" },
  { code: "266927001", display: "Tobacco smoking consumption unknown" },
];

export const kgToLb = (kg: number) => Math.round(kg * 2.20462 * 10) / 10;
export const lbToKg = (lb: number) => Math.round((lb / 2.20462) * 100) / 100;
export const cmToIn = (cm: number) => cm / 2.54;
export const inToCm = (inches: number) => Math.round(inches * 2.54 * 100) / 100;
export const cToF = (c: number) => Math.round(((c * 9) / 5 + 32) * 10) / 10;
export const fToC = (f: number) => Math.round((((f - 32) * 5) / 9) * 10) / 10;

/** 162.6 cm -> "5 ft 4 in". */
export function formatHeight(cm: number): string {
  const total = Math.round(cmToIn(cm));
  return `${Math.floor(total / 12)} ft ${total % 12} in`;
}

/** "5 ft 4 in", "5'4\"", "64 in", "64" (inches) or "162.6 cm" -> centimetres; null when unreadable. */
export function parseHeight(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const cm = /^(\d+(?:\.\d+)?)\s*cm$/.exec(t);
  if (cm) return Number(cm[1]);
  const ftIn = /^(\d+)\s*(?:ft|')\s*(\d+(?:\.\d+)?)?\s*(?:in|")?$/.exec(t);
  if (ftIn) return inToCm(Number(ftIn[1]) * 12 + Number(ftIn[2] ?? 0));
  const inches = /^(\d+(?:\.\d+)?)\s*(?:in|")?$/.exec(t);
  if (inches) return inToCm(Number(inches[1]));
  return null;
}

/** BMI from kg and cm, one decimal. */
export function bmi(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number | null {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}
