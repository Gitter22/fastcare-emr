/**
 * Copied from agile-emr providers/drugTerminologyProvider.ts (ReferenceDataGateway, ADR-005).
 * Drug terminology lookups against NLM RxNav (RxNorm + its attributes).
 * Replaces the old static 20-row DrugReference stub. Same vendor-stub
 * pattern as the other providers: call sites depend on the interface, the
 * concrete class is swapped here (e.g. a self-hosted RxNav-in-a-Box via
 * RXNAV_BASE_URL, or a commercial drug database).
 *
 * Search is a three-step, user-driven flow and each step is one cheap call:
 *   1. search(term)           -- typeahead; ingredient/brand-level concepts
 *   2. listProducts(rxcui)    -- prescribable products (SCD/SBD/packs) of it
 *   3. getConcept(rxcui)      -- full detail of the chosen product, once per
 *                                selection (routes/drugs.ts upserts it into
 *                                DrugConcept)
 *
 * There is deliberately NO fallback list when RxNav is unreachable: callers
 * get DrugTerminologyUnavailableError and surface "try again".
 *
 * Nothing in this module logs search terms or responses. (Fastify's request
 * log does record the request URL incl. `?q=`; a drug name is not a patient
 * identifier, and no patient data is ever sent to NLM.)
 */
import { getEnv } from "../../env.js";

export const PRESCRIBABLE_TTYS = ["SCD", "SBD", "GPCK", "BPCK"] as const;

export interface DrugCandidate {
  rxcui: string;
  name: string;
}

export interface DrugProduct {
  rxcui: string;
  name: string;
  tty: string;
}

export type ScheduleSource = "RXNORM_ATTRIBUTE" | "OVERRIDE" | "UNRESOLVED";

export interface DrugConceptData {
  rxcui: string;
  name: string;
  tty: string;
  ingredientRxcuis: string[];
  ingredientNames: string[];
  strengthText: string | null;
  doseForm: string | null;
  route: string | null;
  brandName: string | null;
  /** Roman numeral "I".."V", or null (not controlled, or unknown -- see scheduleKnown). */
  deaSchedule: string | null;
  /** false = RxNorm carries no schedule for this product; callers must treat it as controlled. */
  scheduleKnown: boolean;
  scheduleSource: ScheduleSource;
  prescribable: boolean;
  rxnormVersion: string;
}

export interface DrugTerminologyProvider {
  search(term: string): Promise<DrugCandidate[]>;
  listProducts(rxcui: string): Promise<DrugProduct[]>;
  /** null when the RxCUI doesn't exist or isn't a prescribable product. */
  getConcept(rxcui: string): Promise<DrugConceptData | null>;
  /**
   * Allergen lookup: ingredient-level (TTY IN) concepts only. Brands, products
   * and precise/multiple ingredients are resolved to their ingredient(s),
   * because an allergy is tracked against the active ingredient.
   */
  searchIngredients(term: string): Promise<DrugCandidate[]>;
  /** Current RxNorm release label, stored with a coded allergy. */
  getRxnormVersion(): Promise<string>;
  /** Ingredient RXCUIs of a concept (an ingredient returns itself); null when the RXCUI is unknown. */
  ingredientRxcuis(
    rxcui: string,
  ): Promise<{ name: string; tty: string; ingredients: string[] } | null>;
}

export class DrugTerminologyUnavailableError extends Error {
  constructor(message = "Drug terminology service unavailable") {
    super(message);
    this.name = "DrugTerminologyUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Schedule derivation (pure -- unit-testable)
// ---------------------------------------------------------------------------

const ROMAN: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V" };
const ROMAN_RANK: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

/**
 * Minimum federal schedule for ingredients whose RxNorm products are known to
 * lack (or mis-state) a SCHEDULE attribute -- seen live: testosterone
 * transdermal carries none although testosterone is CIII. An override can only
 * make a product MORE restricted, never less.
 */
const INGREDIENT_MIN_SCHEDULE: Record<string, string> = {
  testosterone: "III",
  nandrolone: "III",
  oxandrolone: "III",
  ketamine: "III",
  buprenorphine: "III",
};

export function deriveSchedule(
  scheduleAttribute: string | undefined,
  ingredientNames: string[],
): Pick<DrugConceptData, "deaSchedule" | "scheduleKnown" | "scheduleSource"> {
  let fromAttribute: string | null | undefined; // undefined = attribute absent
  if (scheduleAttribute !== undefined) {
    fromAttribute = scheduleAttribute === "0" ? null : (ROMAN[scheduleAttribute] ?? undefined);
  }

  let override: string | null = null;
  for (const n of ingredientNames) {
    const min = INGREDIENT_MIN_SCHEDULE[n.trim().toLowerCase()];
    if (min && (!override || ROMAN_RANK[min]! < ROMAN_RANK[override]!)) override = min;
  }

  if (override && (!fromAttribute || ROMAN_RANK[override]! < ROMAN_RANK[fromAttribute]!)) {
    return { deaSchedule: override, scheduleKnown: true, scheduleSource: "OVERRIDE" };
  }
  if (fromAttribute === undefined) {
    return { deaSchedule: null, scheduleKnown: false, scheduleSource: "UNRESOLVED" };
  }
  return { deaSchedule: fromAttribute, scheduleKnown: true, scheduleSource: "RXNORM_ATTRIBUTE" };
}

// ---------------------------------------------------------------------------
// RxNav implementation
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 5000;
const MAX_SEARCH_CANDIDATES = 10;
const MAX_ALLERGEN_CANDIDATES = 6;
const VERSION_TTL_MS = 60 * 60 * 1000;

interface ApproxCandidate {
  rxcui: string;
  name?: string;
  source?: string;
}
interface ConceptProps {
  rxcui: string;
  name: string;
  tty: string;
}
interface RelatedGroup {
  tty: string;
  conceptProperties?: ConceptProps[];
}

export class RxNavDrugTerminologyProvider implements DrugTerminologyProvider {
  private versionMemo: { value: string; at: number } | null = null;

  private get baseUrl(): string {
    return getEnv().RXNAV_BASE_URL.replace(/\/+$/, "");
  }

  private async getJson<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`RxNav HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new DrugTerminologyUnavailableError(`RxNav HTTP ${res.status}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        if (err instanceof DrugTerminologyUnavailableError) throw err;
        lastError = err;
      }
    }
    throw new DrugTerminologyUnavailableError(
      lastError instanceof Error ? lastError.name : "RxNav request failed",
    );
  }

  private async properties(rxcui: string): Promise<ConceptProps | null> {
    const d = await this.getJson<{ properties?: ConceptProps }>(
      `/rxcui/${encodeURIComponent(rxcui)}/properties.json`,
    );
    return d.properties?.rxcui ? d.properties : null;
  }

  private async related(rxcui: string, ttys: string[]): Promise<RelatedGroup[]> {
    const d = await this.getJson<{ relatedGroup?: { conceptGroup?: RelatedGroup[] } }>(
      `/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${ttys.join("+")}`,
    );
    return d.relatedGroup?.conceptGroup ?? [];
  }

  private async rxnormVersion(): Promise<string> {
    const now = Date.now();
    if (this.versionMemo && now - this.versionMemo.at < VERSION_TTL_MS)
      return this.versionMemo.value;
    const d = await this.getJson<{ version?: string }>("/version.json");
    const value = d.version ?? "unknown";
    this.versionMemo = { value, at: now };
    return value;
  }

  async search(term: string): Promise<DrugCandidate[]> {
    const d = await this.getJson<{ approximateGroup?: { candidate?: ApproxCandidate[] } }>(
      `/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=20`,
    );
    const rows = d.approximateGroup?.candidate ?? [];
    // One row per source per RxCUI, in rank order. Keep RxCUI order, prefer
    // the RXNORM-source name.
    const order: string[] = [];
    const names = new Map<string, string | undefined>();
    for (const r of rows) {
      if (!names.has(r.rxcui)) {
        order.push(r.rxcui);
        names.set(r.rxcui, undefined);
      }
      if (r.source === "RXNORM" && r.name && !names.get(r.rxcui)) names.set(r.rxcui, r.name);
    }
    const top = order.slice(0, MAX_SEARCH_CANDIDATES);
    const out = await Promise.all(
      top.map(async (rxcui): Promise<DrugCandidate | null> => {
        const known = names.get(rxcui);
        if (known) return { rxcui, name: known };
        const p = await this.properties(rxcui);
        return p ? { rxcui, name: p.name } : null;
      }),
    );
    return out.filter((c): c is DrugCandidate => c !== null);
  }

  async searchIngredients(term: string): Promise<DrugCandidate[]> {
    const candidates = (await this.search(term)).slice(0, MAX_ALLERGEN_CANDIDATES);
    const resolved = await Promise.all(
      candidates.map(async (c): Promise<DrugCandidate[]> => {
        const p = await this.properties(c.rxcui);
        if (!p) return [];
        if (p.tty === "IN") return [{ rxcui: p.rxcui, name: p.name }];
        const groups = await this.related(c.rxcui, ["IN"]);
        return groups
          .flatMap((g) => g.conceptProperties ?? [])
          .filter((i) => i.tty === "IN")
          .map((i) => ({ rxcui: i.rxcui, name: i.name }));
      }),
    );
    const seen = new Set<string>();
    const out: DrugCandidate[] = [];
    for (const c of resolved.flat()) {
      if (seen.has(c.rxcui)) continue;
      seen.add(c.rxcui);
      out.push(c);
    }
    return out;
  }

  /** Ingredient RXCUIs of any concept (an ingredient returns itself). Used to spot brand/generic duplicates. */
  async ingredientRxcuis(
    rxcui: string,
  ): Promise<{ name: string; tty: string; ingredients: string[] } | null> {
    const p = await this.properties(rxcui);
    if (!p) return null;
    if (p.tty === "IN") return { name: p.name, tty: p.tty, ingredients: [p.rxcui] };
    const groups = await this.related(rxcui, ["IN"]);
    return {
      name: p.name,
      tty: p.tty,
      ingredients: groups
        .flatMap((g) => g.conceptProperties ?? [])
        .filter((i) => i.tty === "IN")
        .map((i) => i.rxcui),
    };
  }

  getRxnormVersion(): Promise<string> {
    return this.rxnormVersion();
  }

  async listProducts(rxcui: string): Promise<DrugProduct[]> {
    const p = await this.properties(rxcui);
    if (!p) return [];
    if ((PRESCRIBABLE_TTYS as readonly string[]).includes(p.tty)) {
      return [{ rxcui: p.rxcui, name: p.name, tty: p.tty }];
    }
    let groups: RelatedGroup[];
    if (["IN", "PIN", "MIN", "BN"].includes(p.tty)) {
      // Name lookup is the fast path (~250 ms vs 1-2 s for related on a
      // common ingredient) and returns the same prescribable products.
      const d = await this.getJson<{ drugGroup?: { conceptGroup?: RelatedGroup[] } }>(
        `/drugs.json?name=${encodeURIComponent(p.name)}`,
      );
      groups = d.drugGroup?.conceptGroup ?? [];
    } else {
      groups = await this.related(rxcui, [...PRESCRIBABLE_TTYS]);
    }
    const seen = new Set<string>();
    const products: DrugProduct[] = [];
    for (const g of groups) {
      if (!(PRESCRIBABLE_TTYS as readonly string[]).includes(g.tty)) continue;
      for (const c of g.conceptProperties ?? []) {
        if (seen.has(c.rxcui)) continue;
        seen.add(c.rxcui);
        products.push({ rxcui: c.rxcui, name: c.name, tty: g.tty });
      }
    }
    return products.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getConcept(rxcui: string): Promise<DrugConceptData | null> {
    const [props, attrs, rel, version] = await Promise.all([
      this.properties(rxcui),
      this.getJson<{
        propConceptGroup?: { propConcept?: { propName: string; propValue: string }[] };
      }>(`/rxcui/${encodeURIComponent(rxcui)}/allProperties.json?prop=attributes`),
      this.related(rxcui, ["IN", "PIN", "DF", "BN"]),
      this.rxnormVersion(),
    ]);
    if (!props || !(PRESCRIBABLE_TTYS as readonly string[]).includes(props.tty)) return null;

    const attr = new Map<string, string[]>();
    for (const a of attrs.propConceptGroup?.propConcept ?? []) {
      attr.set(a.propName, [...(attr.get(a.propName) ?? []), a.propValue]);
    }
    if (attr.get("PRESCRIBABLE")?.[0] === "N") return null;

    const byTty = (tty: string) => rel.find((g) => g.tty === tty)?.conceptProperties ?? [];
    const ingredients = byTty("IN").length > 0 ? byTty("IN") : byTty("PIN");
    const ingredientNames = ingredients.map((i) => i.name);

    return {
      rxcui: props.rxcui,
      name: props.name,
      tty: props.tty,
      ingredientRxcuis: ingredients.map((i) => i.rxcui),
      ingredientNames,
      strengthText: attr.get("AVAILABLE_STRENGTH")?.join("; ") ?? null,
      doseForm: byTty("DF")[0]?.name ?? null,
      route: null,
      // A generic (SCD/GPCK) is related to every brand of it; only a branded
      // product (SBD/BPCK) has "a" brand.
      brandName:
        props.tty === "SBD" || props.tty === "BPCK" ? (byTty("BN")[0]?.name ?? null) : null,
      ...deriveSchedule(attr.get("SCHEDULE")?.[0], ingredientNames),
      prescribable: true,
      rxnormVersion: version,
    };
  }
}

export const drugTerminologyProvider: DrugTerminologyProvider = new RxNavDrugTerminologyProvider();
