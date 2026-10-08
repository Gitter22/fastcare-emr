import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { reconcileStaged, recordProvenance, stagingFilter } from "./provenance.js";

/**
 * Allergies (chart.allergies, encounter.rooming). The banner reads the active list, so every write here changes what
 * the banner shows (INV-ID-01 keeps it pinned). "No known allergies" is a reviewed statement on the patient, cleared
 * automatically when an allergy is recorded.
 */

const SEVERITIES = ["mild", "moderate", "severe"];

function validReactions(v: unknown) {
  if (v == null) return true;
  const list = (v as { items?: unknown }).items ?? v;
  return (
    Array.isArray(list) &&
    list.every(
      (r) =>
        r &&
        typeof r === "object" &&
        typeof (r as { manifestation?: unknown }).manifestation === "string" &&
        (!(r as { severity?: unknown }).severity ||
          SEVERITIES.includes((r as { severity: string }).severity)),
    )
  );
}

async function loadAllergy(ctx: Ctx, id: string) {
  const a = await ctx.db.allergyIntolerance.findUnique({ where: { id } });
  if (!a) throw notFound();
  await requirePatient(ctx, a.patientId);
  return a;
}

export const allergyHandlers: HandlerMap = {
  async listAllergies(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.allergyIntolerance.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...stagingFilter(ctx.query),
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
      orderBy: [{ clinicalStatus: "asc" }, { createdAt: "asc" }],
    });
    ctx.audit.detail({ rows: rows.length });
    return toDtos("AllergyIntolerance", rows);
  },

  async createAllergy(ctx) {
    const b = ctx.body;
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The allergy must be for this patient.");
    if (b.substanceSystem !== "RXNORM" && b.substanceSystem !== "SNOMEDCT")
      throw unprocessable("validation_failed", "Choose the substance from the search list.", {
        errors: [
          {
            field: "substanceCode",
            code: "invalid",
            message: "Choose the substance from the search list.",
          },
        ],
      });
    if (!validReactions(b.reactions))
      throw unprocessable(
        "validation_failed",
        "Each reaction needs a description and a severity of mild, moderate or severe.",
      );
    const dup = await ctx.db.allergyIntolerance.findFirst({
      where: {
        patientId: patient.id,
        substanceSystem: b.substanceSystem,
        substanceCode: b.substanceCode,
        clinicalStatus: "ACTIVE",
        stagingStatus: "ACTIVE",
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
    });
    if (dup)
      throw conflict(
        "duplicate_allergy",
        `${dup.substanceDisplay} is already on the allergy list.`,
      );
    const me = ctx.staff();
    const row = await ctx.db.allergyIntolerance.create({
      data: {
        practiceId: patient.practiceId,
        patientId: patient.id,
        substanceSystem: b.substanceSystem,
        substanceCode: b.substanceCode,
        substanceDisplay: b.substanceDisplay,
        category: b.category,
        criticality: b.criticality ?? null,
        clinicalStatus: b.clinicalStatus ?? "ACTIVE",
        verificationStatus: b.verificationStatus ?? "CONFIRMED",
        reactions: (b.reactions ?? undefined) as object | undefined,
        onsetDate: b.onsetDate ? new Date(b.onsetDate) : null,
        recordedById: me.userId,
      },
    });
    await ctx.db.patient.update({
      where: { id: patient.id },
      data: { noKnownAllergies: false, allergiesReviewedAt: new Date() },
    });
    ctx.audit.resource("AllergyIntolerance", row.id);
    await writeVersion(ctx.db, row.practiceId, "AllergyIntolerance", row, me.userId);
    await recordProvenance(ctx.db, row.practiceId, {
      targetType: "AllergyIntolerance",
      targetId: row.id,
      source: "ENTERED",
      activity: "create",
      agentId: me.userId,
    });
    return toDto("AllergyIntolerance", row);
  },

  async updateAllergy(ctx) {
    const a = await loadAllergy(ctx, ctx.params.allergyId);
    ctx.checkVersion(a.version, ctx.ifMatch());
    const b = ctx.body;
    if (b.reactions !== undefined && !validReactions(b.reactions))
      throw unprocessable(
        "validation_failed",
        "Each reaction needs a description and a severity of mild, moderate or severe.",
      );
    const row = await ctx.db.allergyIntolerance.update({
      where: { id: a.id },
      data: {
        ...(b.substanceSystem ? { substanceSystem: b.substanceSystem } : {}),
        ...(b.substanceCode ? { substanceCode: b.substanceCode } : {}),
        ...(b.substanceDisplay ? { substanceDisplay: b.substanceDisplay } : {}),
        ...(b.category ? { category: b.category } : {}),
        ...(b.criticality !== undefined ? { criticality: b.criticality } : {}),
        ...(b.clinicalStatus ? { clinicalStatus: b.clinicalStatus } : {}),
        ...(b.verificationStatus ? { verificationStatus: b.verificationStatus } : {}),
        ...(b.reactions !== undefined
          ? { reactions: (b.reactions ?? undefined) as object | undefined }
          : {}),
        ...(b.onsetDate !== undefined
          ? { onsetDate: b.onsetDate ? new Date(b.onsetDate) : null }
          : {}),
        version: { increment: 1 },
      },
    });
    ctx.audit.resource("AllergyIntolerance", row.id);
    await writeVersion(ctx.db, row.practiceId, "AllergyIntolerance", row, ctx.staff().userId);
    return toDto("AllergyIntolerance", row);
  },

  async reconcileAllergy(ctx) {
    await loadAllergy(ctx, ctx.params.allergyId);
    await reconcileStaged(ctx, "allergyIntolerance", ctx.params.allergyId, ctx.body);
    ctx.audit.resource("AllergyIntolerance", ctx.params.allergyId);
    return toDto(
      "AllergyIntolerance",
      await ctx.db.allergyIntolerance.findUniqueOrThrow({ where: { id: ctx.params.allergyId } }),
    );
  },

  async recordAllergyReview(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (ctx.body.noKnownAllergies) {
      const active = await ctx.db.allergyIntolerance.count({
        where: {
          patientId: patient.id,
          clinicalStatus: "ACTIVE",
          stagingStatus: "ACTIVE",
          verificationStatus: { not: "ENTERED_IN_ERROR" },
        },
      });
      if (active)
        throw conflict(
          "has_active_allergies",
          "This patient has active allergies. Mark them inactive first if they no longer apply.",
        );
    }
    await ctx.db.patient.update({
      where: { id: patient.id },
      data: {
        allergiesReviewedAt: new Date(ctx.body.reviewedAt ?? Date.now()),
        ...(ctx.body.noKnownAllergies !== undefined
          ? { noKnownAllergies: ctx.body.noKnownAllergies }
          : {}),
      },
    });
    ctx.audit.detail({ noKnownAllergies: ctx.body.noKnownAllergies ?? null });
  },
};
