import type { RoomingView } from "@agile-emr/shared";
import type { Encounter } from "../../db.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, unprocessable, validationFailed } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { assertEncounterOpen } from "../clinical/conditions.js";
import { LOINC, VITAL_CODES } from "../clinical/domain.js";
import { patientForecast } from "../clinical/immunizations.js";
import { latestByCode } from "../clinical/observations.js";
import { timelineSince } from "../clinical/summary.js";
import { buildBanner } from "../patients/banner.js";
import { summaries } from "../patients/service.js";
import { loadEncounter } from "./access.js";
import { ensureNote, noteSummaries } from "./notes/service.js";
import { encounterDetail, registerEncounterSections } from "./views.js";

/**
 * Encounter workspace reads and writes (encounter.prechart, encounter.rooming, encounter header). The appointment
 * carries the visit's status (states.yaml#appointment); the encounter carries its clinical content.
 */

const YEAR_MS = 365 * 86_400_000;

registerEncounterSections(async (tx, encounterId) => {
  const note = await tx.clinicalNote.findFirst({
    where: { encounterId },
    orderBy: { createdAt: "asc" },
  });
  if (!note) return {};
  const [summary] = await noteSummaries(tx, [note]);
  return { note: summary! };
});

async function roomingChecklist(ctx: Ctx, enc: Encounter) {
  const since = enc.periodStart ?? enc.createdAt;
  const yearAgo = new Date(Date.now() - YEAR_MS);
  const [patient, vitals, responses, tobacco] = await Promise.all([
    ctx.db.patient.findUniqueOrThrow({ where: { id: enc.patientId } }),
    ctx.db.observation.count({ where: { encounterId: enc.id, category: "VITAL_SIGNS" } }),
    ctx.db.questionnaireResponse.findMany({
      where: { patientId: enc.patientId, status: "completed", authoredAt: { gte: yearAgo } },
      include: { questionnaire: true },
      orderBy: { authoredAt: "desc" },
    }),
    ctx.db.observation.findFirst({
      where: { patientId: enc.patientId, loincCode: LOINC.tobacco, effectiveAt: { gte: yearAgo } },
    }),
  ]);
  const has = (loinc: string) => responses.some((r) => r.questionnaire.loincCode === loinc);
  return {
    patient,
    responses,
    checklist: [
      { key: "vitals", label: "Vitals", done: vitals > 0 },
      {
        key: "allergies",
        label: "Allergies reviewed",
        done: !!patient.allergiesReviewedAt && patient.allergiesReviewedAt >= since,
      },
      {
        key: "medications",
        label: "Medication reconciliation",
        done: !!patient.medsReconciledAt && patient.medsReconciledAt >= since,
      },
      {
        key: "depression",
        label: "Depression screening (PHQ-2/9)",
        done: has(LOINC.phq2) || has(LOINC.phq9),
      },
      { key: "tobacco", label: "Tobacco use", done: !!tobacco },
      { key: "sdoh", label: "SDOH screening", done: has(LOINC.sdoh) },
    ],
  };
}

export const encounterHandlers: HandlerMap = {
  async createEncounter(ctx) {
    const b = ctx.body;
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The encounter must be for this patient.");
    const practitioner = await ctx.db.practitioner.findUnique({ where: { id: b.practitionerId } });
    if (!practitioner || !practitioner.active)
      throw validationFailed([
        { field: "practitionerId", code: "invalid", message: "Choose a provider." },
      ]);
    const me = ctx.staff();
    let enc: Encounter;
    if (b.appointmentId) {
      const a = await ctx.db.appointment.findUnique({ where: { id: b.appointmentId } });
      if (!a || a.patientId !== patient.id)
        throw validationFailed([
          {
            field: "appointmentId",
            code: "invalid",
            message: "That appointment is for another patient.",
          },
        ]);
      if (["CANCELLED", "NO_SHOW"].includes(a.status))
        throw conflict("appointment_closed", "That appointment was cancelled or missed.");
      // One encounter per appointment: pre-charting and rooming share it. Serialised so two first opens agree.
      await ctx.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`encounter:${a.id}`}))`;
      enc =
        (await ctx.db.encounter.findUnique({ where: { appointmentId: a.id } })) ??
        (await ctx.db.encounter.create({
          data: {
            practiceId: patient.practiceId,
            patientId: patient.id,
            appointmentId: a.id,
            practitionerId: a.practitionerId,
            locationId: a.locationId,
            class: a.modality === "VIDEO" ? "VR" : a.modality === "PHONE" ? "PHONE" : "AMB",
            status: "PLANNED",
            chiefComplaint: a.reason ?? null,
            securityLabels: [],
            createdById: me.userId,
          },
        }));
    } else {
      if (b.class === "AMB" && !b.locationId)
        throw validationFailed([
          { field: "locationId", code: "required", message: "Choose the location." },
        ]);
      enc = await ctx.db.encounter.create({
        data: {
          practiceId: patient.practiceId,
          patientId: patient.id,
          practitionerId: practitioner.id,
          locationId: b.locationId ?? null,
          class: b.class,
          status: "IN_PROGRESS",
          periodStart: new Date(),
          chiefComplaint: b.reason?.trim() || null,
          securityLabels: [],
          createdById: me.userId,
        },
      });
    }
    await writeVersion(ctx.db, enc.practiceId, "Encounter", enc, me.userId);
    if (b.noteTemplateId) await ensureNote(ctx, enc);
    ctx.audit.resource("Encounter", enc.id);
    return encounterDetail(ctx.db, enc.id);
  },

  async getEncounter(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    return encounterDetail(ctx.db, enc.id);
  },

  async updateEncounter(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    ctx.checkVersion(enc.version, ctx.ifMatch());
    await assertEncounterOpen(ctx, enc.id);
    const b = ctx.body;
    const text = (v: string | null | undefined, max = 2000) =>
      v == null ? null : v.trim().slice(0, max) || null;
    const row = await ctx.db.encounter.update({
      where: { id: enc.id, version: enc.version },
      data: {
        ...(b.chiefComplaint !== undefined ? { chiefComplaint: text(b.chiefComplaint, 500) } : {}),
        ...(b.patientWords !== undefined ? { patientWords: text(b.patientWords, 500) } : {}),
        ...(b.prechartNote !== undefined ? { prechartNote: text(b.prechartNote) } : {}),
        ...(b.followUpInstruction !== undefined
          ? { followUpInstruction: text(b.followUpInstruction, 500) }
          : {}),
        ...(b.noChargeVisit !== undefined ? { noChargeVisit: b.noChargeVisit } : {}),
        ...(b.typeCode !== undefined ? { typeCode: b.typeCode } : {}),
        ...(b.placeOfService !== undefined ? { placeOfService: b.placeOfService } : {}),
        ...(b.emMethod !== undefined ? { emMethod: b.emMethod } : {}),
        ...(b.emTotalMinutes !== undefined ? { emTotalMinutes: b.emTotalMinutes } : {}),
        ...(b.mdmProblems !== undefined ? { mdmProblems: b.mdmProblems } : {}),
        ...(b.mdmData !== undefined ? { mdmData: b.mdmData } : {}),
        ...(b.mdmRisk !== undefined ? { mdmRisk: b.mdmRisk } : {}),
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, row.practiceId, "Encounter", row, ctx.staff().userId);
    return encounterDetail(ctx.db, row.id);
  },

  async getRooming(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const since = enc.periodStart ?? enc.createdAt;
    const [{ patient, responses, checklist }, vitals, previous] = await Promise.all([
      roomingChecklist(ctx, enc),
      ctx.db.observation.findMany({
        where: { encounterId: enc.id, category: "VITAL_SIGNS", stagingStatus: "ACTIVE" },
        orderBy: { effectiveAt: "asc" },
      }),
      latestByCode(ctx.db, enc.patientId, VITAL_CODES, {
        effectiveAt: { lt: since },
        encounterId: { not: enc.id },
      }),
    ]);
    const view: RoomingView = {
      encounterId: enc.id,
      banner: await buildBanner(ctx.db, patient),
      vitals: toDtos("Observation", vitals),
      previousVitals: toDtos("Observation", previous),
      ...(patient.allergiesReviewedAt
        ? { allergiesReviewedAt: patient.allergiesReviewedAt.toISOString() }
        : {}),
      ...(patient.medsReconciledAt
        ? { medicationsReviewedAt: patient.medsReconciledAt.toISOString() }
        : {}),
      screenings: toDtos("QuestionnaireResponse", responses),
      pocOrders: [],
      vaccinesDue: await patientForecast(ctx.db, patient.id, patient.birthDate),
      checklist,
    };
    return view;
  },

  async getPrechart(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: enc.patientId } });
    const last = await ctx.db.encounter.findFirst({
      where: { patientId: enc.patientId, id: { not: enc.id }, status: "FINISHED" },
      orderBy: { periodEnd: "desc" },
    });
    const appt = enc.appointmentId
      ? await ctx.db.appointment.findUnique({ where: { id: enc.appointmentId } })
      : null;
    const [timeline, staged, responses, forecast, [summary]] = await Promise.all([
      timelineSince(ctx, enc.patientId, last?.periodEnd ?? new Date(Date.now() - YEAR_MS), enc.id),
      ctx.db.stagedChange.findMany({
        where: { patientId: enc.patientId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
      }),
      ctx.db.questionnaireResponse.findMany({
        where: {
          patientId: enc.patientId,
          authoredAt: { gte: last?.periodEnd ?? new Date(Date.now() - YEAR_MS) },
        },
        orderBy: { authoredAt: "desc" },
      }),
      patientForecast(ctx.db, patient.id, patient.birthDate),
      summaries(ctx.db, [patient.id]),
    ]);
    return {
      encounterId: enc.id,
      banner: await buildBanner(ctx.db, patient),
      ...(appt?.reason || enc.chiefComplaint
        ? { reasonForVisit: (appt?.reason ?? enc.chiefComplaint)! }
        : {}),
      sinceLastVisit: timeline,
      stagedOutside: staged.map((s) => ({
        ...toDto("StagedChange", s),
        patient: summary!,
        diffs: (
          (s.changes ?? []) as Array<{ field: string; current?: unknown; proposed: unknown }>
        ).map((c) => ({
          path: c.field,
          ...(c.current !== undefined ? { current: c.current } : {}),
          proposed: c.proposed,
          source: s.source,
        })),
      })),
      careGaps: [],
      dueImmunizations: forecast,
      questionnaires: toDtos("QuestionnaireResponse", responses),
      plannedOrders: [],
    };
  },

  async markPrecharted(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const row = await ctx.db.encounter.update({
      where: { id: enc.id },
      data: { prechartedAt: new Date(), version: { increment: 1 } },
    });
    await writeVersion(ctx.db, row.practiceId, "Encounter", row, ctx.staff().userId, "pre-charted");
    return encounterDetail(ctx.db, row.id);
  },
};
