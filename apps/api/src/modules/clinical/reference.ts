import type { CodeHit } from "@agile-emr/shared";
import type { Tx } from "../../db.js";
import {
  DrugTerminologyUnavailableError,
  searchDrugs,
  searchSnomedAllergens,
} from "../../gateways/referenceData/index.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { integrationUnavailable, unprocessable } from "../../platform/problem.js";

/**
 * Reference lookups (ReferenceDataGateway). ICD-10-CM and CVX are local CodeConcept tables; drugs and SNOMED
 * allergens go through the gateway. Search terms are not patient data and are not audited (x-audit: none).
 */

/** Plain-language words clinicians type, mapped to the ICD-10-CM wording. Applied before token matching. */
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bhigh blood pressure\b|\bhtn\b/g, "hypertension"],
  [/\bsugar\b|\bdm\b/g, "diabetes"],
  [/\bt2dm\b|\btype ii diabetes\b/g, "type 2 diabetes"],
  [/\bheart attack\b|\bmi\b/g, "myocardial infarction"],
  [/\bsinus infection\b/g, "sinusitis"],
  [/\buti\b/g, "urinary tract infection"],
  [/\bhigh cholesterol\b|\bcholesterol\b/g, "hyperlipidemia"],
  [/\bflu\b/g, "influenza"],
  [/\bcopd\b/g, "chronic obstructive pulmonary"],
  [/\bchf\b/g, "heart failure"],
  [/\bckd\b/g, "chronic kidney disease"],
  [/\bafib\b|\ba-fib\b/g, "atrial fibrillation"],
  [/\bgerd\b|\breflux\b/g, "gastro-esophageal reflux"],
  [/\bobese\b/g, "obesity"],
  [/\bdepressed\b/g, "depressive"],
  [/\banxious\b/g, "anxiety"],
  [/\bphysical\b|\bwell visit\b|\bcheckup\b/g, "general adult medical examination"],
];

const CODE_LIKE = /^[a-tv-z]\d[0-9a-z](\.[0-9a-z]{0,4})?$/i;

export async function icd10Search(
  tx: Tx,
  q: string,
  billableOnly = false,
  limit = 25,
): Promise<CodeHit[]> {
  const raw = q.trim();
  if (raw.length < 2) return [];
  let where;
  if (CODE_LIKE.test(raw) || /^[a-tv-z]\d{1,2}$/i.test(raw)) {
    where = { system: "ICD10CM" as const, active: true, code: { startsWith: raw.toUpperCase() } };
  } else {
    let text = raw.toLowerCase();
    for (const [re, to] of SYNONYMS) text = text.replace(re, to);
    const tokens = text
      .split(/[^a-z0-9-]+/)
      .filter((t) => t.length > 1)
      .slice(0, 6);
    if (!tokens.length) return [];
    where = {
      system: "ICD10CM" as const,
      active: true,
      AND: tokens.map((t) => ({ display: { contains: t, mode: "insensitive" as const } })),
    };
  }
  const rows = await tx.codeConcept.findMany({
    where: { ...where, ...(billableOnly ? { billable: true } : {}) },
    take: 400,
    orderBy: { code: "asc" },
  });
  const lower = raw.toLowerCase();
  const rank = (r: { code: string; display: string }) =>
    (r.code.toLowerCase() === lower ? 0 : 1000) +
    (r.display.toLowerCase().startsWith(lower) ? 0 : 200) +
    // Shorter codes and descriptions first: the common, general code before the rare combination code.
    r.code.length * 10 +
    Math.min(r.display.length, 150);
  return rows
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit)
    .map((r) => ({
      system: "ICD10CM",
      code: r.code,
      display: r.display,
      billable: r.billable ?? false,
      version: r.sourceVersion,
    }));
}

/** An active ICD-10-CM concept, or 422 so the caller fixes the code. */
export async function requireIcd10(tx: Tx, code: string) {
  const c = await tx.codeConcept.findFirst({
    where: { system: "ICD10CM", code: code.toUpperCase(), active: true },
  });
  if (!c)
    throw unprocessable("validation_failed", `${code} isn't a current ICD-10-CM code.`, {
      errors: [
        { field: "icd10Code", code: "invalid", message: "Choose a current ICD-10-CM code." },
      ],
    });
  if (c.billable === false)
    throw unprocessable(
      "validation_failed",
      `${c.code} is a category. Choose a more specific code.`,
      {
        errors: [
          { field: "icd10Code", code: "not_billable", message: "Choose a more specific code." },
        ],
      },
    );
  return c;
}

/** "Unspecified" leaf codes are valid but prompt for specificity (flow:encounter/03, soft). */
export const isUnspecified = (display: string) => /\bunspecified\b/i.test(display);

export const referenceHandlers: HandlerMap = {
  async searchIcd10(ctx) {
    return icd10Search(ctx.db, ctx.query.q ?? "", ctx.query.billableOnly === true);
  },

  async searchSnomed(ctx) {
    return searchSnomedAllergens(ctx.query.q ?? "");
  },

  async searchDrugs(ctx) {
    try {
      return await searchDrugs(ctx.query.q ?? "");
    } catch (e) {
      if (e instanceof DrugTerminologyUnavailableError)
        throw integrationUnavailable("Drug search isn't responding. Try again in a moment.");
      throw e;
    }
  },

  async searchCvx(ctx) {
    const q = (ctx.query.q ?? "").trim();
    const rows = await ctx.db.codeConcept.findMany({
      where: {
        system: "CVX",
        active: true,
        ...(q
          ? /^\d+$/.test(q)
            ? { code: q }
            : {
                OR: [
                  { display: { contains: q, mode: "insensitive" } },
                  { shortDisplay: { contains: q, mode: "insensitive" } },
                ],
              }
          : {}),
      },
      take: 30,
      orderBy: { code: "asc" },
    });
    return rows.map((r) => ({
      system: "CVX" as const,
      code: r.code,
      display: r.shortDisplay ?? r.display,
      version: r.sourceVersion,
    }));
  },
};
