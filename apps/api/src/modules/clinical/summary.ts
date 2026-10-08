import type { ChartSummary, TimelineItem } from "@agile-emr/shared";
import { isoDate, limitOf, toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { RESTRICTED_LABELS, canSeeLabels, requirePatient } from "../../platform/patientAccess.js";
import { dayRange, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { encounterTitle, noteSummaries } from "../encounters/notes/service.js";
import { buildBanner } from "../patients/banner.js";
import { appointmentViews, practitionerName } from "../scheduling/views.js";
import { VITAL_CODES } from "./domain.js";
import { patientForecast } from "./immunizations.js";
import { medicationViews } from "./medications.js";
import { latestByCode } from "./observations.js";

/**
 * Chart summary ("understand the patient in 30 seconds") and the timeline. Restricted notes are counted, never shown
 * (INV-SEC-03); the banner still renders for a restricted chart (INV-ID-01).
 */

const NOTE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  READY_TO_SIGN: "Ready to sign",
  PENDING_COSIGN: "Pending co-sign",
  SIGNED: "Signed",
  ADDENDED: "Addended",
};

const isRestricted = (labels: string[]) => labels.some((l) => RESTRICTED_LABELS.includes(l));

/** Timeline items for a patient, newest first. `types` filters by TimelineItem.kind. */
async function timelineItems(
  ctx: Ctx,
  patientId: string,
  opts: { from?: Date; to?: Date; types?: string[]; excludeEncounterId?: string; take: number },
): Promise<TimelineItem[]> {
  const want = (k: TimelineItem["kind"]) => !opts.types?.length || opts.types.includes(k);
  const range = (field: string) =>
    opts.from || opts.to
      ? {
          [field]: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lte: opts.to } : {}),
          },
        }
      : {};
  const [encounters, reports, docs, comms, shots] = await Promise.all([
    want("encounter")
      ? ctx.db.encounter.findMany({
          where: {
            patientId,
            status: { in: ["IN_PROGRESS", "FINISHED"] },
            ...(opts.excludeEncounterId ? { id: { not: opts.excludeEncounterId } } : {}),
            ...range("periodStart"),
          },
          include: { notes: true, practitioner: true },
          orderBy: { periodStart: "desc" },
          take: opts.take,
        })
      : [],
    want("result")
      ? ctx.db.diagnosticReport.findMany({
          where: { patientId, ...range("issuedAt") },
          orderBy: { issuedAt: "desc" },
          take: opts.take,
        })
      : [],
    want("document")
      ? ctx.db.documentReference.findMany({
          where: { patientId, status: "CURRENT", ...range("documentDate") },
          orderBy: { documentDate: "desc" },
          take: opts.take,
        })
      : [],
    want("communication")
      ? ctx.db.communicationLog.findMany({
          where: { patientId, ...range("createdAt") },
          orderBy: { createdAt: "desc" },
          take: opts.take,
        })
      : [],
    want("immunization")
      ? ctx.db.immunization.findMany({
          where: { patientId, stagingStatus: "ACTIVE", ...range("occurrenceAt") },
          orderBy: { occurrenceAt: "desc" },
          take: opts.take,
        })
      : [],
  ]);
  const items: TimelineItem[] = [];
  for (const e of encounters) {
    const note = e.notes[0];
    const restricted =
      isRestricted(note?.securityLabels ?? e.securityLabels) &&
      !(await canSeeLabels(ctx, patientId, note?.securityLabels ?? e.securityLabels));
    items.push({
      id: e.id,
      at: (e.periodStart ?? e.createdAt).toISOString(),
      kind: "encounter",
      title: restricted ? "Restricted visit" : await encounterTitle(ctx.db, e),
      ...(restricted ? {} : { summary: e.chiefComplaint ?? undefined }),
      ...(note ? { status: NOTE_LABEL[note.status] } : {}),
      author: practitionerName(e.practitioner),
      entityType: note ? "ClinicalNote" : "Encounter",
      entityId: note?.id ?? e.id,
      restricted,
    });
  }
  for (const r of reports)
    items.push({
      id: r.id,
      at: (r.issuedAt ?? r.createdAt).toISOString(),
      kind: "result",
      title: r.display,
      status: r.status,
      ...(r.performerLab ? { author: r.performerLab } : {}),
      entityType: "DiagnosticReport",
      entityId: r.id,
      restricted: isRestricted(r.securityLabels),
    });
  for (const d of docs)
    items.push({
      id: d.id,
      at: d.documentDate.toISOString(),
      kind: "document",
      title: d.title,
      ...(d.author ? { author: d.author } : {}),
      entityType: "DocumentReference",
      entityId: d.id,
      restricted: isRestricted(d.securityLabels),
    });
  for (const c of comms)
    items.push({
      id: c.id,
      at: c.createdAt.toISOString(),
      kind: "communication",
      title: `${c.channel === "SMS" ? "Text" : c.channel === "EMAIL" ? "Email" : c.channel} · ${c.purpose.replace(/-/g, " ")}`,
      status: c.status,
      entityType: "CommunicationLog",
      entityId: c.id,
      restricted: false,
    });
  for (const s of shots)
    items.push({
      id: s.id,
      at: s.occurrenceAt.toISOString(),
      kind: "immunization",
      title: s.display,
      ...(s.lotNumber ? { summary: `Lot ${s.lotNumber}${s.site ? ` · ${s.site}` : ""}` } : {}),
      entityType: "Immunization",
      entityId: s.id,
      restricted: false,
    });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** What happened since a moment (pre-chart "since last visit"). */
export function timelineSince(
  ctx: Ctx,
  patientId: string,
  since: Date,
  excludeEncounterId: string,
) {
  return timelineItems(ctx, patientId, { from: since, excludeEncounterId, take: 50 });
}

export const summaryHandlers: HandlerMap = {
  async getPatientSummary(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const id = patient.id;
    const tz = await practiceTimeZone(ctx.db);
    const today = dayRange(todayLocal(tz), tz);
    const [banner, problems, meds, allergies, vitals, reports, gaps, upcoming, notes, staged] =
      await Promise.all([
        buildBanner(ctx.db, patient),
        ctx.db.condition.findMany({
          where: {
            patientId: id,
            category: "PROBLEM_LIST_ITEM",
            stagingStatus: "ACTIVE",
            verificationStatus: { not: "ENTERED_IN_ERROR" },
            clinicalStatus: { in: ["ACTIVE", "RECURRENCE", "RELAPSE"] },
          },
          orderBy: [{ onsetDate: "asc" }, { createdAt: "asc" }],
        }),
        ctx.db.medicationStatement.findMany({
          where: { patientId: id, stagingStatus: "ACTIVE", status: "ACTIVE" },
          orderBy: { display: "asc" },
        }),
        ctx.db.allergyIntolerance.findMany({
          where: {
            patientId: id,
            stagingStatus: "ACTIVE",
            clinicalStatus: "ACTIVE",
            verificationStatus: { not: "ENTERED_IN_ERROR" },
          },
        }),
        latestByCode(ctx.db, id, VITAL_CODES),
        ctx.db.diagnosticReport.findMany({
          where: { patientId: id, status: { in: ["FINAL", "CORRECTED", "AMENDED"] } },
          orderBy: { issuedAt: "desc" },
          take: 5,
        }),
        ctx.db.careGap.findMany({
          where: { patientId: id, status: "OPEN" },
          include: { measure: true },
          orderBy: { dueDate: "asc" },
        }),
        ctx.db.appointment.findMany({
          where: {
            patientId: id,
            start: { gte: today.start },
            status: { notIn: ["CANCELLED", "NO_SHOW", "LEFT_WITHOUT_BEING_SEEN"] },
          },
          orderBy: { start: "asc" },
          take: 5,
        }),
        ctx.db.clinicalNote.findMany({
          where: { patientId: id },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        ctx.db.$queryRaw<Array<{ kind: string; n: bigint }>>`
        SELECT 'problems' AS kind, count(*) AS n FROM "Condition" WHERE "patientId" = ${id}::uuid AND "stagingStatus" = 'STAGED'
        UNION ALL SELECT 'medications', count(*) FROM "MedicationStatement" WHERE "patientId" = ${id}::uuid AND "stagingStatus" = 'STAGED'
        UNION ALL SELECT 'allergies', count(*) FROM "AllergyIntolerance" WHERE "patientId" = ${id}::uuid AND "stagingStatus" = 'STAGED'`,
      ]);
    // Clinical detail follows the patient's access rules; identity (banner) is always shown.
    let clinical = true;
    try {
      await requirePatient(ctx, id);
    } catch {
      clinical = false;
    }
    const visibleNotes = [];
    let hidden = 0;
    for (const n of notes) {
      if (await canSeeLabels(ctx, id, n.securityLabels)) visibleNotes.push(n);
      else hidden++;
    }
    const n = (k: string) => Number(staged.find((s) => s.kind === k)?.n ?? 0);
    const apptViews = await appointmentViews(ctx.db, upcoming);
    const todayAppt = apptViews.find((a) => new Date(a.start) < today.end);
    const todayEnc = todayAppt
      ? await ctx.db.encounter.findUnique({ where: { appointmentId: todayAppt.id } })
      : null;
    const summary: ChartSummary = {
      banner,
      problems: clinical ? toDtos("Condition", problems) : [],
      medications: clinical ? await medicationViews(ctx.db, meds) : [],
      allergies: toDtos("AllergyIntolerance", allergies),
      recentVitals: clinical ? toDtos("Observation", vitals) : [],
      recentResults: clinical
        ? reports.map((r) => ({
            id: r.id,
            patientId: r.patientId,
            code: r.loincCode,
            display: r.display,
            status: r.status,
            ...(r.issuedAt ? { issuedAt: r.issuedAt.toISOString() } : {}),
            flag: r.flag ?? "NORMAL",
            reviewed: !!r.reviewedAt,
            released: !!r.releasedToPortalAt,
            ...(r.performerLab ? { performer: r.performerLab } : {}),
          }))
        : [],
      immunizationsDue: clinical ? await patientForecast(ctx.db, id, patient.birthDate) : [],
      careGaps: clinical
        ? gaps.map((g) => ({
            ...toDto("CareGap", g),
            measure: { id: g.measure.id, name: g.measure.name },
            ...(g.lastDoneDate ? { lastDone: isoDate(g.lastDoneDate)! } : {}),
            closesWith: [],
          }))
        : [],
      upcomingAppointments: apptViews,
      openOrders: [],
      stagedItems: n("problems") + n("medications") + n("allergies"),
      staged: { problems: n("problems"), medications: n("medications"), allergies: n("allergies") },
      restrictedHidden: clinical ? hidden : notes.length,
      recentVisits: clinical ? await noteSummaries(ctx.db, visibleNotes.slice(0, 5)) : [],
      ...(todayAppt ? { todayAppointment: todayAppt } : {}),
      ...(todayEnc ? { todayEncounterId: todayEnc.id } : {}),
    };
    return summary;
  },

  async getPatientTimeline(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(q);
    const to = q.cursor
      ? new Date(new Date(q.cursor).getTime() - 1)
      : q.toDate
        ? new Date(`${q.toDate}T23:59:59Z`)
        : undefined;
    const items = await timelineItems(ctx, ctx.params.patientId, {
      ...(q.fromDate ? { from: new Date(q.fromDate) } : {}),
      ...(to ? { to } : {}),
      types: q.types as string[] | undefined,
      take: limit + 1,
    });
    ctx.audit.detail({ rows: items.length });
    const pageItems = items.slice(0, limit);
    return {
      data: pageItems,
      nextCursor: items.length > limit ? pageItems.at(-1)!.at : null,
      hasMore: items.length > limit,
    };
  },
};
