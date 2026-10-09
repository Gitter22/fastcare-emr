/**
 * Simulated formulary / real-time benefit check for the simulated e-prescribing network (dev and test only; never
 * used in production). Values are illustrative placeholders, not any payer's real formulary. Unknown drugs return
 * status "unknown" rather than an invented tier.
 */
export interface FormularyResult {
  status: "preferred" | "on-formulary" | "non-formulary" | "unknown";
  tier: number | null;
  alternatives: string[];
  priorAuthRequired: boolean | null;
  estimatedCopay: string | null;
  payerName: string | null;
}

type Entry = Omit<FormularyResult, "payerName">;

const e = (
  status: Entry["status"],
  tier: number,
  copay: string,
  alternatives: string[] = [],
  pa = false,
): Entry => ({ status, tier, estimatedCopay: copay, alternatives, priorAuthRequired: pa });

const ANTIBIOTIC_ALTERNATIVES = [
  "doxycycline hyclate 100 MG Oral Capsule",
  "azithromycin 250 MG Oral Tablet",
];

/** Keyed by lower-case ingredient name (single-ingredient products). */
const TABLE: Record<string, Entry> = {
  amoxicillin: e("preferred", 1, "5.00", ANTIBIOTIC_ALTERNATIVES),
  cephalexin: e("preferred", 1, "5.00", ANTIBIOTIC_ALTERNATIVES),
  doxycycline: e("preferred", 1, "4.00"),
  azithromycin: e("preferred", 1, "6.00"),
  clarithromycin: e("on-formulary", 2, "15.00", ["azithromycin 250 MG Oral Tablet"]),
  "sulfamethoxazole / trimethoprim": e("preferred", 1, "4.00"),
  lisinopril: e("preferred", 1, "3.00"),
  losartan: e("preferred", 1, "4.00"),
  amlodipine: e("preferred", 1, "3.00"),
  metformin: e("preferred", 1, "3.00"),
  atorvastatin: e("preferred", 1, "5.00"),
  rosuvastatin: e("on-formulary", 2, "20.00", ["atorvastatin 40 MG Oral Tablet"]),
  simvastatin: e("preferred", 1, "3.00"),
  sertraline: e("preferred", 1, "5.00"),
  ibuprofen: e("preferred", 1, "4.00"),
  naproxen: e("preferred", 1, "4.00"),
  oxycodone: e("on-formulary", 2, "12.00"),
  hydrocodone: e("on-formulary", 2, "12.00"),
  tramadol: e("on-formulary", 2, "10.00"),
  alprazolam: e("on-formulary", 2, "8.00"),
  lorazepam: e("on-formulary", 2, "8.00"),
  zolpidem: e("on-formulary", 2, "10.00"),
  warfarin: e("preferred", 1, "4.00"),
  apixaban: e("on-formulary", 3, "47.00", ["warfarin sodium 5 MG Oral Tablet"], true),
  semaglutide: e(
    "non-formulary",
    4,
    "120.00",
    ["metformin hydrochloride 1000 MG Oral Tablet"],
    true,
  ),
};

export function formularyFor(input: {
  ingredientNames: string[];
  tty: string;
  payerName: string | null;
}): FormularyResult {
  const key = input.ingredientNames.map((n) => n.toLowerCase()).join(" / ");
  const hit = TABLE[key];
  if (!hit)
    return {
      status: "unknown",
      tier: null,
      alternatives: [],
      priorAuthRequired: null,
      estimatedCopay: null,
      payerName: input.payerName,
    };
  // Branded products sit one tier above the generic.
  const brand = input.tty === "SBD" || input.tty === "BPCK";
  return {
    ...hit,
    ...(brand && hit.tier !== null
      ? { status: "on-formulary" as const, tier: Math.min(hit.tier + 2, 5) }
      : {}),
    payerName: input.payerName,
  };
}
