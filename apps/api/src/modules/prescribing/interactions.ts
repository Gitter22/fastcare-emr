/**
 * Curated SEVERE drug-drug interactions, by RxNorm ingredient name (lower case). NLM retired its interaction API in
 * January 2024 and no licensed knowledge base (FDB, Medi-Span) is contracted yet (OPEN-Q2, OPEN-Q19), so this short table is
 * the whole drug-drug check: only well-established contraindicated or major pairs from FDA labeling, each
 * interruptive (INV-SAFE-06). Moderate/minor interactions are NOT checked -- a licensed DUR source replaces this
 * table. Review clinically before go-live.
 */
export interface InteractionRule {
  a: string[];
  b: string[];
  effect: string;
}

const OPIOIDS = [
  "oxycodone",
  "hydrocodone",
  "morphine",
  "codeine",
  "tramadol",
  "fentanyl",
  "hydromorphone",
  "methadone",
  "oxymorphone",
  "tapentadol",
];
const BENZODIAZEPINES = [
  "alprazolam",
  "lorazepam",
  "diazepam",
  "clonazepam",
  "temazepam",
  "chlordiazepoxide",
];
const NSAIDS = [
  "aspirin",
  "ibuprofen",
  "naproxen",
  "diclofenac",
  "meloxicam",
  "ketorolac",
  "indomethacin",
  "celecoxib",
];
const STRONG_CYP3A4_INHIBITORS = [
  "clarithromycin",
  "itraconazole",
  "ketoconazole",
  "posaconazole",
  "ritonavir",
];
const SSRIS = ["sertraline", "fluoxetine", "citalopram", "escitalopram", "paroxetine"];

export const SEVERE_INTERACTIONS: InteractionRule[] = [
  {
    a: OPIOIDS,
    b: BENZODIAZEPINES,
    effect:
      "Opioid with a benzodiazepine: profound sedation, respiratory depression, death (FDA boxed warning).",
  },
  {
    a: ["warfarin"],
    b: NSAIDS,
    effect: "Warfarin with an NSAID: major bleeding risk.",
  },
  {
    a: ["warfarin"],
    b: ["fluconazole", "metronidazole", "sulfamethoxazole"],
    effect: "Raises warfarin levels: INR increase and bleeding risk.",
  },
  {
    a: ["simvastatin", "lovastatin"],
    b: [...STRONG_CYP3A4_INHIBITORS, "erythromycin"],
    effect: "Statin with a strong CYP3A4 inhibitor: contraindicated (myopathy, rhabdomyolysis).",
  },
  {
    a: ["atorvastatin"],
    b: ["clarithromycin", "itraconazole", "ritonavir"],
    effect: "Atorvastatin with a strong CYP3A4 inhibitor: myopathy and rhabdomyolysis risk.",
  },
  {
    a: ["sildenafil", "tadalafil", "vardenafil"],
    b: ["nitroglycerin", "isosorbide mononitrate", "isosorbide dinitrate"],
    effect: "PDE-5 inhibitor with a nitrate: contraindicated (severe hypotension).",
  },
  {
    a: ["methotrexate"],
    b: ["trimethoprim", "sulfamethoxazole"],
    effect: "Methotrexate with trimethoprim/sulfamethoxazole: bone-marrow suppression.",
  },
  {
    a: ["linezolid"],
    b: SSRIS,
    effect: "Linezolid with an SSRI: serotonin syndrome.",
  },
  {
    a: ["tizanidine"],
    b: ["ciprofloxacin", "fluvoxamine"],
    effect:
      "Tizanidine with ciprofloxacin or fluvoxamine: contraindicated (severe hypotension, sedation).",
  },
  {
    a: ["colchicine"],
    b: ["clarithromycin", "ketoconazole", "itraconazole", "ritonavir"],
    effect: "Colchicine with a strong CYP3A4 inhibitor: fatal colchicine toxicity reported.",
  },
];

/** Every ingredient name the table knows (for matching uncoded medication text). */
export const KNOWN_INGREDIENTS = [
  ...new Set(SEVERE_INTERACTIONS.flatMap((r) => [...r.a, ...r.b])),
].sort((x, y) => y.length - x.length);

/** The severe rule between two ingredient sets, if any. */
export function severeInteraction(mine: string[], theirs: string[]): InteractionRule | null {
  const m = new Set(mine.map((n) => n.toLowerCase()));
  const t = new Set(theirs.map((n) => n.toLowerCase()));
  return (
    SEVERE_INTERACTIONS.find(
      (r) =>
        (r.a.some((x) => m.has(x)) && r.b.some((x) => t.has(x))) ||
        (r.b.some((x) => m.has(x)) && r.a.some((x) => t.has(x))),
    ) ?? null
  );
}

/**
 * SNOMED drug-class allergens (the pinned list in gateways/referenceData/allergens.ts) to the ingredients in the
 * class. Cross-class sensitivity (penicillin -> cephalosporin) is NOT inferred.
 */
export const ALLERGY_CLASSES: Record<string, { name: string; ingredients: string[] }> = {
  "764146007": {
    name: "penicillin",
    ingredients: [
      "penicillin g",
      "penicillin v",
      "amoxicillin",
      "ampicillin",
      "dicloxacillin",
      "nafcillin",
      "oxacillin",
      "piperacillin",
    ],
  },
  "372788003": {
    name: "sulfonamide antibacterial",
    ingredients: ["sulfamethoxazole", "sulfadiazine", "sulfisoxazole"],
  },
  "764147003": {
    name: "cephalosporin",
    ingredients: [
      "cephalexin",
      "cefadroxil",
      "cefazolin",
      "cefuroxime",
      "cefdinir",
      "cefpodoxime",
      "ceftriaxone",
      "cefprozil",
      "cefixime",
    ],
  },
  "372665008": { name: "NSAID", ingredients: NSAIDS },
};
