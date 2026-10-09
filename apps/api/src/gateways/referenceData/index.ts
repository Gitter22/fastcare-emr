import type { CodeHit, DrugConcept } from "@agile-emr/shared";
import type { Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { getRedis } from "../../redis.js";
import {
  type AllergenConcept,
  AllergenTerminologyUnavailableError,
  expandSnomed,
  searchPinned,
} from "./allergens.js";
import {
  type DrugConceptData,
  DrugTerminologyUnavailableError,
  drugTerminologyProvider,
} from "./rxnav.js";

/**
 * ReferenceDataGateway (ADR-005): drug terminology (NLM RxNav) and SNOMED CT allergen subsets (terminology server).
 * ICD-10-CM, LOINC, CVX and POS are local CodeConcept tables (prisma/reference-data) and are queried directly.
 * Results are cached in Redis; a cache failure never fails a search, and partial or failed results are not cached.
 */
export { AllergenTerminologyUnavailableError, DrugTerminologyUnavailableError };

const PRODUCTS_FOR_TOP = 3;

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* best-effort */
  }
  const value = await load();
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* best-effort */
  }
  return value;
}

/** Drug search: ingredient/brand candidates, each with its prescribable products (top hits only). */
export async function searchDrugs(term: string): Promise<DrugConcept[]> {
  const q = term.trim().toLowerCase();
  if (q.length < 2) return [];
  return cached(`rxnav:search:v1:${q}`, 6 * 3600, async () => {
    const candidates = await drugTerminologyProvider.search(q);
    const out: DrugConcept[] = [];
    let expanded = 0;
    for (const c of candidates) {
      const products =
        expanded < PRODUCTS_FOR_TOP ? await drugTerminologyProvider.listProducts(c.rxcui) : [];
      // A candidate that is itself a product lists only itself; an ingredient or brand lists its products.
      const isProduct = products.length === 1 && products[0]!.rxcui === c.rxcui;
      if (products.length) expanded++;
      out.push({
        rxcui: c.rxcui,
        name: c.name,
        tty: isProduct ? products[0]!.tty : products.length ? "IN" : "UNKNOWN",
        ingredients: [],
        ...(products.length && !isProduct
          ? {
              related: products
                .slice(0, 15)
                .map((p) => ({ rxcui: p.rxcui, name: p.name, tty: p.tty })),
            }
          : {}),
      });
    }
    return out;
  });
}

/** RxNorm ingredients for an allergy (allergies are tracked against the active ingredient). */
export async function searchDrugIngredients(term: string): Promise<DrugConcept[]> {
  const q = term.trim().toLowerCase();
  if (q.length < 2) return [];
  return cached(`rxnav:ingredients:v1:${q}`, 6 * 3600, async () =>
    (await drugTerminologyProvider.searchIngredients(q)).map((c) => ({
      rxcui: c.rxcui,
      name: c.name,
      tty: "IN",
      ingredients: [c.name],
    })),
  );
}

const toHit = (c: AllergenConcept): CodeHit => ({
  system: c.system,
  code: c.code,
  display: c.display,
  category: c.category,
  ...(c.version ? { version: c.version } : {}),
});

/**
 * SNOMED allergen concepts (drug classes, foods, environmental). Pinned list for a short query; pinned matches
 * first, then the live expansion. If every live source fails the pinned matches are returned on their own.
 */
export async function searchSnomedAllergens(term: string): Promise<CodeHit[]> {
  const q = term.trim().toLowerCase();
  const pinned = searchPinned(q, ["DRUG_CLASS", "FOOD", "ENVIRONMENT"]);
  if (q.length < 3) return pinned.map(toHit);
  const key = `snomed:allergen:v1:${q}`;
  const redis = getRedis();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as CodeHit[];
  } catch {
    /* best-effort */
  }
  const settled = await Promise.allSettled(
    (["DRUG_CLASS", "FOOD", "ENVIRONMENT"] as const).map((c) => expandSnomed(c, q)),
  );
  const live = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const seen = new Set<string>();
  const merged = [...pinned, ...live].filter((c) => {
    const k = `${c.system}:${c.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const result = merged.map(toHit);
  if (settled.every((r) => r.status === "fulfilled")) {
    try {
      await redis.set(
        key,
        JSON.stringify(result),
        "EX",
        getEnv().ALLERGEN_SEARCH_CACHE_TTL_SECONDS,
      );
    } catch {
      /* best-effort */
    }
  }
  return result;
}

/**
 * Ingredient RXCUIs per concept, cached in RxNormConcept (reference data, no PHI). Concepts RxNav can't resolve right
 * now are left out, so callers degrade to "no duplicate found" instead of failing.
 */
export async function ingredientsOf(tx: Tx, rxcuis: string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(rxcuis)];
  const out = new Map<string, string[]>();
  if (!unique.length) return out;
  const cached = await tx.rxNormConcept.findMany({ where: { rxcui: { in: unique } } });
  for (const c of cached) if (c.ingredients.length) out.set(c.rxcui, c.ingredients);
  for (const rxcui of unique.filter((r) => !out.has(r))) {
    try {
      const r = await drugTerminologyProvider.ingredientRxcuis(rxcui);
      if (!r?.ingredients.length) continue;
      out.set(rxcui, r.ingredients);
      await tx.rxNormConcept.upsert({
        where: { rxcui },
        create: { rxcui, name: r.name, tty: r.tty, ndcs: [], ingredients: r.ingredients },
        update: { ingredients: r.ingredients, fetchedAt: new Date() },
      });
    } catch {
      /* RxNav down: no ingredient data for this concept */
    }
  }
  return out;
}

/**
 * A prescribable product with ingredients and DEA schedule (encounter.rx, DUR, EPCS). Cached for 6 hours; never
 * served stale past that: a drug whose schedule can't be verified now can't be prescribed (fail closed, as in
 * agile-emr). Ingredients are also stored in RxNormConcept for ingredientsOf. null = not a prescribable product.
 */
export async function getDrugConcept(tx: Tx, rxcui: string): Promise<DrugConceptData | null> {
  const concept = await cached(`rxnav:concept:v1:${rxcui}`, 6 * 3600, () =>
    drugTerminologyProvider.getConcept(rxcui),
  );
  if (concept)
    await tx.rxNormConcept.upsert({
      where: { rxcui },
      create: {
        rxcui,
        name: concept.name,
        tty: concept.tty,
        deaSchedule: concept.deaSchedule,
        ndcs: [],
        ingredients: concept.ingredientRxcuis,
      },
      update: { deaSchedule: concept.deaSchedule, ingredients: concept.ingredientRxcuis },
    });
  return concept;
}

/** Controlled when scheduled, or when RxNorm carries no schedule at all (fail closed). */
export const isControlledConcept = (c: Pick<DrugConceptData, "deaSchedule" | "scheduleKnown">) =>
  !c.scheduleKnown || c.deaSchedule !== null;
