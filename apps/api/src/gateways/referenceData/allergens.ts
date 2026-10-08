/**
 * Allergen terminology (ReferenceDataGateway, ADR-005). Ported from agile-emr providers/allergenTerminologyProvider.ts:
 *  - drug classes, foods and environmental agents: a FHIR terminology server's `ValueSet/$expand` (production target
 *    NLM VSAC with UMLS_API_KEY; the default is tx.fhir.org with interim SNOMED hierarchy value sets),
 *  - drugs: RxNorm ingredients from RxNav (rxnav.ts) -- drugs are never taken from SNOMED.
 * A pinned list answers an empty query and is the offline fallback, so allergy entry never depends on a live server.
 * Only the search term (an allergen name, never patient data) leaves the system, and it is not logged here.
 */
import { getEnv } from "../../env.js";

export type AllergenCategory = "MEDICATION" | "DRUG_CLASS" | "FOOD" | "ENVIRONMENT";

export interface AllergenConcept {
  system: "SNOMEDCT" | "RXNORM";
  code: string;
  display: string;
  category: AllergenCategory;
  version?: string;
}

export class AllergenTerminologyUnavailableError extends Error {
  constructor(message = "Allergen terminology service unavailable") {
    super(message);
    this.name = "AllergenTerminologyUnavailableError";
  }
}

const sct = (code: string, display: string, category: AllergenCategory): AllergenConcept => ({
  system: "SNOMEDCT",
  code,
  display,
  category,
});
const rx = (code: string, display: string): AllergenConcept => ({
  system: "RXNORM",
  code,
  display,
  category: "MEDICATION",
});

/** "No known allergy" statements. The server, not the client, supplies the code. */
export const NO_KNOWN_ALLERGY = sct("716186003", "No known allergy", "ENVIRONMENT");

// Every code below was looked up live on 2026-10-05 for agile-emr (SNOMED: tx.fhir.org International Edition
// 20250201, all active; RxNorm: RxNav, all TTY IN). Re-verify against the production server at go-live.
export const PINNED_ALLERGENS: AllergenConcept[] = [
  rx("7980", "penicillin G"),
  rx("723", "amoxicillin"),
  rx("10180", "sulfamethoxazole"),
  rx("2231", "cephalexin"),
  rx("4053", "erythromycin"),
  rx("1191", "aspirin"),
  rx("5640", "ibuprofen"),
  rx("2670", "codeine"),
  rx("7052", "morphine"),
  sct("764146007", "Penicillin", "DRUG_CLASS"),
  sct("372788003", "Sulfonamide antibacterial", "DRUG_CLASS"),
  sct("764147003", "Cephalosporin", "DRUG_CLASS"),
  sct("372665008", "Non-steroidal anti-inflammatory agent", "DRUG_CLASS"),
  sct("762952008", "Peanut", "FOOD"),
  sct("442571000124108", "Tree nut", "FOOD"),
  sct("735029006", "Shellfish", "FOOD"),
  sct("735971005", "Fish", "FOOD"),
  sct("102263004", "Eggs (edible)", "FOOD"),
  sct("70813002", "Milk", "FOOD"),
  sct("256355007", "Soyabean", "FOOD"),
  sct("412071004", "Wheat", "FOOD"),
  sct("260167008", "Sesame seed", "FOOD"),
  sct("111088007", "Latex", "ENVIRONMENT"),
  sct("256259004", "Pollen", "ENVIRONMENT"),
  sct("720687003", "Dust mite protein", "ENVIRONMENT"),
  sct("260152009", "Cat dander", "ENVIRONMENT"),
  sct("288328004", "Bee venom", "ENVIRONMENT"),
];

export function searchPinned(term: string, categories?: AllergenCategory[]): AllergenConcept[] {
  const t = term.trim().toLowerCase();
  return PINNED_ALLERGENS.filter(
    (c) =>
      (!categories || categories.includes(c.category)) &&
      (!t || c.display.toLowerCase().includes(t)),
  );
}

const REQUEST_TIMEOUT_MS = 8000;
const PER_SOURCE_LIMIT = 8;
const SCT_URI = "http://snomed.info/sct";

type SnomedCategory = Exclude<AllergenCategory, "MEDICATION">;

/**
 * Interim environmental value set: all substances except drugs and foods, sent inline as a POST $expand (standard
 * FHIR). Replaced by a curated set through ALLERGEN_VALUESET_ENVIRONMENT.
 */
const INTERIM_ENVIRONMENT_VALUE_SET = {
  resourceType: "ValueSet",
  compose: {
    include: [
      { system: SCT_URI, filter: [{ property: "concept", op: "is-a", value: "105590001" }] },
    ],
    exclude: [
      { system: SCT_URI, filter: [{ property: "concept", op: "is-a", value: "410942007" }] },
      { system: SCT_URI, filter: [{ property: "concept", op: "is-a", value: "255620007" }] },
    ],
  },
};

interface ValueSetResponse {
  expansion?: {
    parameter?: { name: string; valueUri?: string }[];
    contains?: { system?: string; code?: string; display?: string }[];
  };
}

/** Pure: a FHIR $expand response as concepts. RxNorm rows in a medication value set stay medications. */
export function parseExpansion(
  body: ValueSetResponse,
  category: SnomedCategory,
): AllergenConcept[] {
  let version: string | undefined;
  for (const p of body.expansion?.parameter ?? [])
    if (p.name === "used-codesystem" && p.valueUri?.startsWith(`${SCT_URI}|`))
      version = p.valueUri.split("|", 2)[1];
  const out: AllergenConcept[] = [];
  for (const c of body.expansion?.contains ?? []) {
    if (!c.code || !c.display) continue;
    if (c.system === SCT_URI)
      out.push({ ...sct(c.code, c.display, category), ...(version ? { version } : {}) });
    else if (c.system === "http://www.nlm.nih.gov/research/umls/rxnorm")
      out.push(rx(c.code, c.display));
  }
  return out;
}

function valueSet(category: SnomedCategory): { url: string } | { inline: object } | null {
  const env = getEnv();
  if (category === "FOOD") return { url: env.ALLERGEN_VALUESET_FOOD };
  if (category === "DRUG_CLASS")
    return env.ALLERGEN_VALUESET_DRUG_CLASS ? { url: env.ALLERGEN_VALUESET_DRUG_CLASS } : null;
  return env.ALLERGEN_VALUESET_ENVIRONMENT
    ? { url: env.ALLERGEN_VALUESET_ENVIRONMENT }
    : { inline: INTERIM_ENVIRONMENT_VALUE_SET };
}

/** One SNOMED category from the terminology server (pinned classes when no live drug-class set is configured). */
export async function expandSnomed(
  category: SnomedCategory,
  term: string,
): Promise<AllergenConcept[]> {
  const spec = valueSet(category);
  if (!spec) return searchPinned(term, [category]);
  const env = getEnv();
  const base = env.ALLERGEN_TERMINOLOGY_BASE_URL.replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/fhir+json" };
  if (env.UMLS_API_KEY)
    headers.Authorization = `Basic ${Buffer.from(`apikey:${env.UMLS_API_KEY}`).toString("base64")}`;
  const request =
    "url" in spec
      ? {
          url: `${base}/ValueSet/$expand?${new URLSearchParams({ url: spec.url, filter: term, count: String(PER_SOURCE_LIMIT) })}`,
          init: { headers } as RequestInit,
        }
      : {
          url: `${base}/ValueSet/$expand`,
          init: {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/fhir+json" },
            body: JSON.stringify({
              resourceType: "Parameters",
              parameter: [
                { name: "filter", valueString: term },
                { name: "count", valueInteger: PER_SOURCE_LIMIT },
                { name: "valueSet", resource: spec.inline },
              ],
            }),
          } as RequestInit,
        };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new AllergenTerminologyUnavailableError(`HTTP ${res.status}`);
      return parseExpansion((await res.json()) as ValueSetResponse, category);
    } catch (err) {
      if (err instanceof AllergenTerminologyUnavailableError) throw err;
      lastError = err;
    }
  }
  throw new AllergenTerminologyUnavailableError(
    lastError instanceof Error ? lastError.name : "request failed",
  );
}
