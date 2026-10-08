import type { ConditionClinicalStatus, Prisma } from "../../db.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { reconcileStaged, recordProvenance, stagingFilter } from "./provenance.js";
import { requireIcd10 } from "./reference.js";

/** Problem list (chart.problems, chart.summary, encounter.dx-coding). Encounter diagnoses live in encounters/diagnoses. */

const CLOSED: ConditionClinicalStatus[] = ["RESOLVED", "INACTIVE", "REMISSION"];

async function loadCondition(ctx: Ctx, id: string) {
  const c = await ctx.db.condition.findUnique({ where: { id } });
  if (!c || c.verificationStatus === "ENTERED_IN_ERROR") throw notFound();
  await requirePatient(ctx, c.patientId);
  return c;
}

/** Encounter diagnoses are frozen once the visit's note is signed (INV-SAFE-02). */
export async function assertEncounterOpen(ctx: Ctx, encounterId: string | null) {
  if (!encounterId) return;
  const signed = await ctx.db.clinicalNote.findFirst({
    where: { encounterId, status: { in: ["SIGNED", "ADDENDED", "PENDING_COSIGN"] } },
  });
  if (signed)
    throw conflict("note_signed", "This visit's note is signed. Add an addendum instead.");
}

export const conditionHandlers: HandlerMap = {
  async listConditions(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    const where: Prisma.ConditionWhereInput = {
      patientId: ctx.params.patientId,
      ...stagingFilter(q),
      verificationStatus: { not: "ENTERED_IN_ERROR" },
      ...(q.category ? { category: q.category as Prisma.ConditionWhereInput["category"] } : {}),
      ...(q.clinicalStatus
        ? { clinicalStatus: q.clinicalStatus as ConditionClinicalStatus }
        : q.includeResolved
          ? {}
          : { clinicalStatus: { notIn: CLOSED } }),
    };
    const rows = await ctx.db.condition.findMany({
      where,
      orderBy: [{ rank: "asc" }, { onsetDate: "asc" }, { createdAt: "asc" }],
      take: 500,
    });
    ctx.audit.detail({ rows: rows.length });
    return toDtos("Condition", rows);
  },

  async createCondition(ctx) {
    const b = ctx.body;
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The problem must be for this patient.");
    if (b.category === "ENCOUNTER_DIAGNOSIS")
      throw unprocessable("validation_failed", "Add visit diagnoses from Dx & coding.");
    const code = b.icd10Code ? await requireIcd10(ctx.db, b.icd10Code) : null;
    if (!code && !b.display?.trim())
      throw unprocessable("validation_failed", "Choose a problem.", {
        errors: [{ field: "icd10Code", code: "required", message: "Choose a problem." }],
      });
    if (code) {
      const dup = await ctx.db.condition.findFirst({
        where: {
          patientId: patient.id,
          category: b.category,
          icd10Code: code.code,
          stagingStatus: "ACTIVE",
          verificationStatus: { not: "ENTERED_IN_ERROR" },
          clinicalStatus: { notIn: CLOSED },
        },
      });
      if (dup)
        throw conflict("duplicate_problem", `${dup.display} is already on the problem list.`);
    }
    const me = ctx.staff();
    const row = await ctx.db.condition.create({
      data: {
        practiceId: patient.practiceId,
        patientId: patient.id,
        category: b.category,
        icd10Code: code?.code ?? null,
        snomedCode: b.snomedCode ?? null,
        display: b.display?.trim() || code!.display,
        clinicalStatus: b.clinicalStatus ?? "ACTIVE",
        verificationStatus: b.verificationStatus ?? "CONFIRMED",
        onsetDate: b.onsetDate ? new Date(b.onsetDate) : null,
        abatementDate: b.abatementDate ? new Date(b.abatementDate) : null,
        note: b.note ?? null,
        securityLabels: b.securityLabels ?? [],
        recordedById: me.userId,
      },
    });
    ctx.audit.resource("Condition", row.id);
    await writeVersion(ctx.db, row.practiceId, "Condition", row, me.userId);
    await recordProvenance(ctx.db, row.practiceId, {
      targetType: "Condition",
      targetId: row.id,
      source: "ENTERED",
      activity: "create",
      agentId: me.userId,
    });
    return toDto("Condition", row);
  },

  async updateCondition(ctx) {
    const c = await loadCondition(ctx, ctx.params.conditionId);
    ctx.checkVersion(c.version, ctx.ifMatch());
    if (c.category === "ENCOUNTER_DIAGNOSIS") await assertEncounterOpen(ctx, c.encounterId);
    const b = ctx.body;
    const code = b.icd10Code ? await requireIcd10(ctx.db, b.icd10Code) : null;
    const resolving = b.clinicalStatus === "RESOLVED" && c.clinicalStatus !== "RESOLVED";
    const row = await ctx.db.condition.update({
      where: { id: c.id },
      data: {
        ...(b.category && b.category !== "ENCOUNTER_DIAGNOSIS" ? { category: b.category } : {}),
        ...(code ? { icd10Code: code.code, display: b.display?.trim() || code.display } : {}),
        ...(!code && b.display ? { display: b.display.trim() } : {}),
        ...(b.snomedCode !== undefined ? { snomedCode: b.snomedCode } : {}),
        ...(b.clinicalStatus ? { clinicalStatus: b.clinicalStatus } : {}),
        ...(b.verificationStatus ? { verificationStatus: b.verificationStatus } : {}),
        ...(b.onsetDate !== undefined
          ? { onsetDate: b.onsetDate ? new Date(b.onsetDate) : null }
          : {}),
        ...(b.abatementDate !== undefined
          ? { abatementDate: b.abatementDate ? new Date(b.abatementDate) : null }
          : resolving
            ? { abatementDate: new Date() }
            : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(b.securityLabels ? { securityLabels: b.securityLabels } : {}),
        version: { increment: 1 },
      },
    });
    ctx.audit.resource("Condition", row.id);
    await writeVersion(ctx.db, row.practiceId, "Condition", row, ctx.staff().userId);
    return toDto("Condition", row);
  },

  async reconcileCondition(ctx) {
    await loadCondition(ctx, ctx.params.conditionId);
    await reconcileStaged(ctx, "condition", ctx.params.conditionId, ctx.body);
    ctx.audit.resource("Condition", ctx.params.conditionId);
    return toDto(
      "Condition",
      await ctx.db.condition.findUniqueOrThrow({ where: { id: ctx.params.conditionId } }),
    );
  },
};
