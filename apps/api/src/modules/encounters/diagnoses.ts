import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { conflict, notFound, validationFailed } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { assertEncounterOpen } from "../clinical/conditions.js";
import { recordProvenance } from "../clinical/provenance.js";
import { requireIcd10 } from "../clinical/reference.js";
import { loadEncounter } from "./access.js";
import { registerEncounterSections } from "./views.js";

/**
 * Encounter diagnoses (encounter.dx-coding, flow:encounter/03): ordered Condition rows of category
 * ENCOUNTER_DIAGNOSIS. Rank is the claim pointer order. Addressing a problem-list item copies its code; "add to
 * problem list" creates the problem as well. Removing before signing marks the row entered-in-error (kept for audit).
 */

const activeDx = (encounterId: string) => ({
  encounterId,
  category: "ENCOUNTER_DIAGNOSIS" as const,
  verificationStatus: { not: "ENTERED_IN_ERROR" as const },
});

async function renumber(ctx: Ctx, encounterId: string, moveId?: string, toRank?: number) {
  const rows = await ctx.db.condition.findMany({
    where: activeDx(encounterId),
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
  });
  const order = rows.map((r) => r.id).filter((id) => id !== moveId);
  if (moveId)
    order.splice(Math.max(0, Math.min((toRank ?? order.length + 1) - 1, order.length)), 0, moveId);
  for (const [i, id] of order.entries()) {
    const r = rows.find((x) => x.id === id)!;
    if (r.rank !== i + 1) await ctx.db.condition.update({ where: { id }, data: { rank: i + 1 } });
  }
}

registerEncounterSections(async (tx, encounterId) => ({
  diagnoses: toDtos(
    "Condition",
    await tx.condition.findMany({ where: activeDx(encounterId), orderBy: { rank: "asc" } }),
  ),
}));

export const diagnosisHandlers: HandlerMap = {
  async listEncounterDiagnoses(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const rows = await ctx.db.condition.findMany({
      where: activeDx(enc.id),
      orderBy: { rank: "asc" },
    });
    return toDtos("Condition", rows);
  },

  async addEncounterDiagnosis(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const b = ctx.body;
    let source = null;
    if (b.conditionId) {
      source = await ctx.db.condition.findUnique({ where: { id: b.conditionId } });
      if (
        !source ||
        source.patientId !== enc.patientId ||
        source.category === "ENCOUNTER_DIAGNOSIS"
      )
        throw validationFailed([
          {
            field: "conditionId",
            code: "invalid",
            message: "Choose a problem from this patient's list.",
          },
        ]);
    }
    const code = await requireIcd10(ctx.db, b.icd10Code ?? source?.icd10Code ?? "");
    const dup = await ctx.db.condition.findFirst({
      where: { ...activeDx(enc.id), icd10Code: code.code },
    });
    if (dup)
      throw conflict("duplicate_diagnosis", `${code.code} is already a diagnosis for this visit.`);
    const count = await ctx.db.condition.count({ where: activeDx(enc.id) });
    const me = ctx.staff();
    const row = await ctx.db.condition.create({
      data: {
        practiceId: enc.practiceId,
        patientId: enc.patientId,
        encounterId: enc.id,
        category: "ENCOUNTER_DIAGNOSIS",
        icd10Code: code.code,
        snomedCode: source?.snomedCode ?? null,
        display:
          b.display?.trim() ||
          (source && source.icd10Code === code.code ? source.display : code.display),
        rank: count + 1,
        recordedById: me.userId,
        securityLabels: source?.securityLabels ?? [],
      },
    });
    if (b.rank && b.rank !== count + 1) await renumber(ctx, enc.id, row.id, b.rank);
    await writeVersion(ctx.db, row.practiceId, "Condition", row, me.userId);
    await recordProvenance(ctx.db, row.practiceId, {
      targetType: "Condition",
      targetId: row.id,
      source: "ENTERED",
      activity: "create",
      agentId: me.userId,
    });
    if (b.addToProblemList && !source) {
      const existing = await ctx.db.condition.findFirst({
        where: {
          patientId: enc.patientId,
          category: "PROBLEM_LIST_ITEM",
          icd10Code: code.code,
          stagingStatus: "ACTIVE",
          verificationStatus: { not: "ENTERED_IN_ERROR" },
          clinicalStatus: { notIn: ["RESOLVED", "INACTIVE"] },
        },
      });
      if (!existing) {
        const problem = await ctx.db.condition.create({
          data: {
            practiceId: enc.practiceId,
            patientId: enc.patientId,
            category: "PROBLEM_LIST_ITEM",
            icd10Code: code.code,
            display: row.display,
            onsetDate: new Date(),
            lastAddressedAt: new Date(),
            recordedById: me.userId,
          },
        });
        await writeVersion(ctx.db, problem.practiceId, "Condition", problem, me.userId);
      }
    }
    ctx.audit.resource("Condition", row.id);
    return toDto("Condition", await ctx.db.condition.findUniqueOrThrow({ where: { id: row.id } }));
  },

  async updateEncounterDiagnosis(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const c = await ctx.db.condition.findFirst({
      where: { id: ctx.params.conditionId, ...activeDx(enc.id) },
    });
    if (!c) throw notFound();
    ctx.checkVersion(c.version, ctx.body.version);
    const code = ctx.body.icd10Code ? await requireIcd10(ctx.db, ctx.body.icd10Code) : null;
    if (code && code.code !== c.icd10Code) {
      const dup = await ctx.db.condition.findFirst({
        where: { ...activeDx(enc.id), icd10Code: code.code },
      });
      if (dup)
        throw conflict(
          "duplicate_diagnosis",
          `${code.code} is already a diagnosis for this visit.`,
        );
    }
    let row = await ctx.db.condition.update({
      where: { id: c.id },
      data: {
        ...(code ? { icd10Code: code.code, display: code.display } : {}),
        version: { increment: 1 },
      },
    });
    if (ctx.body.rank) {
      await renumber(ctx, enc.id, c.id, ctx.body.rank);
      row = await ctx.db.condition.findUniqueOrThrow({ where: { id: c.id } });
    }
    await writeVersion(ctx.db, row.practiceId, "Condition", row, ctx.staff().userId);
    ctx.audit.resource("Condition", row.id);
    return toDto("Condition", row);
  },

  async removeEncounterDiagnosis(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const c = await ctx.db.condition.findFirst({
      where: { id: ctx.params.conditionId, ...activeDx(enc.id) },
    });
    if (!c) throw notFound();
    const linked = await ctx.db.serviceRequestReason.count({ where: { conditionId: c.id } });
    if (linked)
      throw conflict("diagnosis_in_use", "Orders are linked to this diagnosis. Relink them first.");
    const row = await ctx.db.condition.update({
      where: { id: c.id },
      data: { verificationStatus: "ENTERED_IN_ERROR", rank: null, version: { increment: 1 } },
    });
    await writeVersion(
      ctx.db,
      row.practiceId,
      "Condition",
      row,
      ctx.staff().userId,
      "removed from visit",
    );
    await renumber(ctx, enc.id);
    ctx.audit.resource("Condition", row.id);
  },
};
