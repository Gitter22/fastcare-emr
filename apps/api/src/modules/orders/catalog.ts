import type { LabCompendiumItem } from "../../db.js";
import { limitOf, page, toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";

/**
 * Order catalog (encounter.orders search). Labs come from the practice's lab compendium (LOINC-mapped, with AOE
 * questions); imaging, procedures and referrals are a fixed reference list until admin.order-catalog exists (S8).
 */

export interface AoeQuestion {
  code: string;
  text: string;
  type: "boolean" | "text" | "choice";
  options?: string[];
  required: boolean;
}

export const aoeQuestionsOf = (item: Pick<LabCompendiumItem, "aoeQuestions"> | null) =>
  ((item?.aoeQuestions as { items?: AoeQuestion[] } | null)?.items ?? []) as AoeQuestion[];

type StaticItem = {
  kind: "imaging" | "procedure" | "referral";
  codeSystem: "CPT" | "SNOMEDCT";
  code: string;
  display: string;
  requiresAuth?: boolean;
  synonyms?: string[];
};

export const STATIC_CATALOG: StaticItem[] = [
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "71046",
    display: "X-ray chest, 2 views",
    synonyms: ["cxr"],
  },
  { kind: "imaging", codeSystem: "CPT", code: "73030", display: "X-ray shoulder, 2+ views" },
  { kind: "imaging", codeSystem: "CPT", code: "72100", display: "X-ray lumbar spine, 2-3 views" },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "77067",
    display: "Screening mammogram, bilateral",
    synonyms: ["mammo"],
  },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "77080",
    display: "DEXA bone density, axial",
    synonyms: ["dexa", "osteoporosis"],
  },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "76700",
    display: "Ultrasound abdomen, complete",
    synonyms: ["us"],
  },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "70450",
    display: "CT head without contrast",
    requiresAuth: true,
  },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "72148",
    display: "MRI lumbar spine without contrast",
    requiresAuth: true,
  },
  {
    kind: "imaging",
    codeSystem: "CPT",
    code: "93306",
    display: "Echocardiogram, complete with Doppler",
    synonyms: ["echo"],
    requiresAuth: true,
  },
  {
    kind: "procedure",
    codeSystem: "CPT",
    code: "93000",
    display: "Electrocardiogram, 12-lead",
    synonyms: ["ecg", "ekg"],
  },
  { kind: "procedure", codeSystem: "CPT", code: "94010", display: "Spirometry", synonyms: ["pft"] },
  {
    kind: "procedure",
    codeSystem: "CPT",
    code: "92250",
    display: "Fundus photography (diabetic retinal screening)",
    synonyms: ["eye"],
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183519002",
    display: "Referral to cardiology",
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183531003",
    display: "Referral to endocrinology",
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183543006",
    display: "Referral to ophthalmology",
    synonyms: ["diabetic eye exam"],
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183534006",
    display: "Referral to gastroenterology",
    synonyms: ["colonoscopy"],
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183545004",
    display: "Referral to orthopedics",
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183516009",
    display: "Referral to dermatology",
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183555007",
    display: "Referral to physical therapy",
    synonyms: ["pt"],
  },
  {
    kind: "referral",
    codeSystem: "SNOMEDCT",
    code: "183524004",
    display: "Referral to psychiatry",
    synonyms: ["behavioral health"],
  },
];

/** Static ids are stable per code so the catalog can be bookmarked as favourites. */
const staticId = (code: string) =>
  `00000000-0000-4000-8000-${code.replace(/\D/g, "").padStart(12, "0").slice(-12)}`;

export const staticItem = (code: string) => STATIC_CATALOG.find((s) => s.code === code);

const matches = (q: string, ...texts: Array<string | null | undefined>) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
};

export const catalogHandlers: HandlerMap = {
  async searchOrderCatalog(ctx) {
    const q = (ctx.query.q ?? "").trim();
    const category = ctx.query.category as string | undefined;
    const out: unknown[] = [];
    if (!category || category === "lab") {
      const labs = await ctx.db.labCompendiumItem.findMany({
        where: {
          active: true,
          ...(ctx.query.lab ? { lab: ctx.query.lab } : {}),
          ...(q
            ? {
                OR: [
                  { display: { contains: q, mode: "insensitive" } },
                  { testCode: { startsWith: q } },
                  { loincCode: { startsWith: q } },
                ],
              }
            : {}),
        },
        orderBy: [{ display: "asc" }, { lab: "asc" }],
        take: 40,
      });
      for (const l of labs)
        out.push({
          id: l.id,
          kind: "lab",
          code: l.loincCode ?? l.testCode,
          display: l.display,
          lab: l.lab,
          ...(l.specimenType ? { specimen: l.specimenType } : {}),
          aoe: aoeQuestionsOf(l).map((a) => a.text),
        });
    }
    for (const s of STATIC_CATALOG) {
      if (category && category !== s.kind) continue;
      if (q && !matches(q, s.display, s.code, ...(s.synonyms ?? []))) continue;
      out.push({
        id: staticId(s.code),
        kind: s.kind,
        code: s.code,
        display: s.display,
        aoe: [],
        ...(s.requiresAuth ? { requiresAuth: true } : {}),
      });
    }
    if (!category || category === "order-set") {
      const sets = await ctx.db.orderSet.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
      });
      for (const s of sets)
        if (!q || matches(q, s.name))
          out.push({ id: s.id, kind: "order-set", code: s.id, display: s.name, aoe: [] });
    }
    return toDtos("OrderCatalogItem", out.slice(0, 60));
  },

  async listLabCompendium(ctx) {
    const limit = limitOf(ctx.query);
    const q = ctx.query.q?.trim();
    const rows = await ctx.db.labCompendiumItem.findMany({
      where: {
        active: true,
        ...(ctx.query.lab ? { lab: ctx.query.lab } : {}),
        ...(q ? { display: { contains: q, mode: "insensitive" } } : {}),
        ...(ctx.query.cursor ? { id: { gt: ctx.query.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    return page(
      rows,
      limit,
      (r) => toDto("LabCompendiumItem", r),
      (r) => r.id,
    );
  },

  async listOrderSets(ctx) {
    const rows = await ctx.db.orderSet.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });
    return toDtos("OrderSet", rows);
  },
};
