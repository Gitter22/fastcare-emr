import type { CodeHit } from "@agile-emr/shared";
import type { CodeSystem, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";

/**
 * Billing reference lookups: CMS place-of-service codes, procedure codes (CPT/HCPCS) and adjustment codes
 * (CARC/RARC). CPT and CARC/RARC are curated subsets until the licensed/full lists are imported (OPEN-Q23).
 */

async function codeSearch(
  tx: Tx,
  systems: CodeSystem[],
  q: string | undefined,
  limit = 25,
): Promise<CodeHit[]> {
  const raw = (q ?? "").trim();
  const rows = await tx.codeConcept.findMany({
    where: {
      system: { in: systems },
      active: true,
      ...(raw
        ? {
            OR: [
              { code: { startsWith: raw.toUpperCase() } },
              ...raw
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t.length > 1)
                .slice(0, 1)
                .map((t) => ({ display: { contains: t, mode: "insensitive" as const } })),
            ],
          }
        : {}),
    },
    orderBy: [{ system: "asc" }, { code: "asc" }],
    take: limit,
  });
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return rows
    .filter(
      (r) =>
        !tokens.length ||
        r.code.startsWith(raw.toUpperCase()) ||
        tokens.every((t) => r.display.toLowerCase().includes(t)),
    )
    .map((r) => {
      const a = (r.attributes ?? {}) as { category?: string };
      return {
        system: r.system,
        code: r.code,
        display: r.display,
        ...(r.billable !== null ? { billable: r.billable } : {}),
        version: r.sourceVersion,
        ...(a.category ? { category: a.category } : {}),
      };
    });
}

export const billingReferenceHandlers: HandlerMap = {
  async listPlaceOfServiceCodes(ctx) {
    return codeSearch(ctx.db, ["POS"], undefined, 200);
  },
  async searchProcedureCodes(ctx) {
    const sys = ctx.query.system as CodeSystem | undefined;
    return codeSearch(
      ctx.db,
      sys === "CPT" || sys === "HCPCS" ? [sys] : ["CPT", "HCPCS"],
      ctx.query.q,
    );
  },
  async searchAdjustmentCodes(ctx) {
    const sys = ctx.query.system as CodeSystem | undefined;
    return codeSearch(
      ctx.db,
      sys === "CARC" || sys === "RARC" ? [sys] : ["CARC", "RARC"],
      ctx.query.q,
      50,
    );
  },
  async listFeeSchedules(ctx) {
    const rows = await ctx.db.feeSchedule.findMany({
      orderBy: [{ isContract: "asc" }, { name: "asc" }],
    });
    return rows.map((r) => toDto("FeeSchedule", r));
  },
};
