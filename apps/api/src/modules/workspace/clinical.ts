import type { AppointmentStatus, Prisma } from "../../db.js";
import { queuePatientMessage } from "../../platform/communications.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { forbidden, unprocessable, validationFailed } from "../../platform/problem.js";
import { dayRange, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { forecast } from "../clinical/immunizations.js";
import { noteSummaries } from "../encounters/notes/service.js";
import { appointmentViews } from "../scheduling/views.js";

/**
 * Clinical homes (home.clinical-daylist for MAs, home.provider-worklist for providers): today's patients with
 * readiness, plus work counts. Counts read the real queues; queues that later slices fill (results, Rx requests,
 * messages, overdue orders) are simply zero until then.
 */

const WAITING: AppointmentStatus[] = ["ARRIVED", "ROOMED", "READY_FOR_PROVIDER"];
const LATE_ALERT_MINUTES = 15;
const LONG_WAIT_MINUTES = 20;

export const clinicalWorkspaceHandlers: HandlerMap = {
  async getClinicalDayList(ctx) {
    const q = ctx.query;
    const tz = await practiceTimeZone(ctx.db);
    const date = q.date ?? todayLocal(tz);
    const { start, end } = dayRange(date, tz);
    const rows = await ctx.db.appointment.findMany({
      where: {
        start: { gte: start, lt: end },
        status: { notIn: ["REQUESTED", "CANCELLED"] },
        ...(q.locationId ? { locationId: q.locationId } : {}),
        ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
      },
      orderBy: { start: "asc" },
    });
    const ids = rows.map((r) => r.id);
    const patientIds = [...new Set(rows.map((r) => r.patientId))];
    const [views, encounters, roomed, gaps, patients, doses] = await Promise.all([
      appointmentViews(ctx.db, rows),
      ctx.db.encounter.findMany({ where: { appointmentId: { in: ids } } }),
      ctx.db.appointmentStatusEvent.findMany({
        where: { appointmentId: { in: ids }, toStatus: "ROOMED" },
        orderBy: { at: "desc" },
      }),
      ctx.db.careGap.groupBy({
        by: ["patientId"],
        where: { patientId: { in: patientIds }, status: "OPEN" },
        _count: true,
      }),
      ctx.db.patient.findMany({
        where: { id: { in: patientIds } },
        select: { id: true, birthDate: true },
      }),
      ctx.db.immunization.findMany({
        where: { patientId: { in: patientIds }, status: "COMPLETED", stagingStatus: "ACTIVE" },
        select: { patientId: true, cvxCode: true, occurrenceAt: true },
      }),
    ]);
    const pended = await ctx.db.serviceRequest.groupBy({
      by: ["encounterId"],
      where: { encounterId: { in: encounters.map((e) => e.id) }, status: "PENDED" },
      _count: true,
    });
    const today = todayLocal(tz);
    ctx.audit.detail({ rows: rows.length });
    return {
      date,
      rows: views.map((v) => {
        const enc = encounters.find((e) => e.appointmentId === v.id);
        const p = patients.find((x) => x.id === v.patient.id)!;
        const due = forecast(
          p.birthDate,
          doses.filter((d) => d.patientId === p.id),
          today,
        );
        const roomedAt = roomed.find((r) => r.appointmentId === v.id)?.at;
        return {
          appointment: v,
          prechartReady: !!enc?.prechartedAt,
          careGaps: gaps.find((g) => g.patientId === p.id)?._count ?? 0,
          pendingOrders: enc ? (pended.find((x) => x.encounterId === enc.id)?._count ?? 0) : 0,
          ...(roomedAt ? { roomedAt: roomedAt.toISOString() } : {}),
          ...(enc ? { encounterId: enc.id } : {}),
          protocols: due.map((d) => `${d.vaccineGroup} vaccine due`),
        };
      }),
    };
  },

  async getProviderWorklist(ctx) {
    const me = ctx.staff();
    if (!me.practitionerId)
      throw forbidden("not_a_provider", "Your account isn't linked to a provider record.");
    const tz = await practiceTimeZone(ctx.db);
    const date = ctx.query.date ?? todayLocal(tz);
    const { start, end } = dayRange(date, tz);
    const isToday = date === todayLocal(tz);
    const appts = await ctx.db.appointment.findMany({
      where: {
        practitionerId: me.practitionerId,
        start: { gte: start, lt: end },
        status: { notIn: ["REQUESTED", "CANCELLED"] },
      },
      orderBy: { start: "asc" },
    });
    const ids = appts.map((a) => a.id);
    const encounters = await ctx.db.encounter.findMany({ where: { appointmentId: { in: ids } } });
    const encIds = encounters.map((e) => e.id);
    const now = new Date();
    const myOrders: Prisma.ServiceRequestWhereInput = { signedById: me.userId };
    const [views, vitals, pended, unsigned, cosign, results, rx, threads, overdue, staged] =
      await Promise.all([
        appointmentViews(ctx.db, appts),
        ctx.db.observation.findMany({
          where: { encounterId: { in: encIds }, category: "VITAL_SIGNS", stagingStatus: "ACTIVE" },
          select: { encounterId: true, loincCode: true, flag: true, interpretation: true },
        }),
        ctx.db.serviceRequest.groupBy({
          by: ["encounterId"],
          where: { encounterId: { in: encIds }, status: "PENDED" },
          _count: true,
        }),
        ctx.db.clinicalNote.findMany({
          where: { authorId: me.userId, status: { in: ["DRAFT", "READY_TO_SIGN"] } },
          orderBy: { createdAt: "asc" },
          take: 50,
        }),
        ctx.db.clinicalNote.count({ where: { status: "PENDING_COSIGN", cosignerId: me.userId } }),
        ctx.db.diagnosticReport.count({
          where: {
            reviewedAt: null,
            status: { in: ["FINAL", "CORRECTED", "AMENDED"] },
            serviceRequest: myOrders,
          },
        }),
        ctx.db.rxRequest.count({ where: { responseStatus: null } }),
        ctx.db.messageThread.count({ where: { closedAt: null, assignedUserId: me.userId } }),
        ctx.db.serviceRequest.count({
          where: {
            ...myOrders,
            status: { in: ["SIGNED", "SENT", "COLLECTED"] },
            expectedBy: { lt: start },
          },
        }),
        ctx.db.stagedChange.groupBy({
          by: ["patientId"],
          where: { patientId: { in: appts.map((a) => a.patientId) }, status: "PENDING" },
          _count: true,
        }),
      ]);
    const behind = isToday
      ? appts
          .filter((a) => WAITING.includes(a.status) && a.start < now)
          .map((a) => Math.floor((now.getTime() - a.start.getTime()) / 60_000))
      : [];
    ctx.audit.detail({ rows: appts.length });
    return {
      date,
      practitionerId: me.practitionerId,
      schedule: views,
      unsignedNotes: await noteSummaries(ctx.db, unsigned),
      pendingCosign: cosign,
      resultsToReview: results,
      rxRequests: rx,
      messages: threads,
      overdueOrders: overdue,
      readiness: views.map((v) => {
        const enc = encounters.find((e) => e.appointmentId === v.id);
        const encVitals = enc ? vitals.filter((o) => o.encounterId === enc.id) : [];
        const bp = encVitals.filter((o) => o.loincCode === "85354-9").at(-1);
        const notes: string[] = [];
        if (staged.some((s) => s.patientId === v.patient.id))
          notes.push("Patient-submitted changes to review");
        return {
          appointmentId: v.id,
          ...(enc ? { encounterId: enc.id } : {}),
          vitalsDone: encVitals.length > 0,
          ...(bp?.flag === "ABNORMAL"
            ? { vitalAlert: bp.interpretation === "L" ? "BP low" : "BP high" }
            : {}),
          precharted: !!enc?.prechartedAt,
          pendedOrders: enc ? (pended.find((p) => p.encounterId === enc.id)?._count ?? 0) : 0,
          notes,
        };
      }),
      minutesBehind:
        behind.length && Math.max(...behind) > LATE_ALERT_MINUTES ? Math.max(...behind) : 0,
      waitingLong: behind.filter((m) => m > LONG_WAIT_MINUTES).length,
    };
  },

  async sendRunningLateNotice(ctx) {
    const me = ctx.staff();
    const b = ctx.body;
    if (me.role === "provider" && b.practitionerId !== me.practitionerId)
      throw forbidden("forbidden", "You can only send delay updates for your own schedule.");
    if (!b.notifyPatients)
      throw unprocessable("validation_failed", "Choose to notify patients to send an update.");
    if (!Number.isInteger(b.minutes) || b.minutes < 5 || b.minutes > 180)
      throw validationFailed([
        {
          field: "minutes",
          code: "out_of_range",
          message: "Enter a delay between 5 and 180 minutes.",
        },
      ]);
    const tz = await practiceTimeZone(ctx.db);
    const { end } = dayRange(todayLocal(tz), tz);
    const now = Date.now();
    const appts = await ctx.db.appointment.findMany({
      where: {
        practitionerId: b.practitionerId,
        status: { in: ["BOOKED", "CONFIRMED", ...WAITING] },
        start: { gte: new Date(now - 2 * 3_600_000), lt: end },
      },
    });
    const practice = await ctx.db.practice.findFirstOrThrow();
    let queued = 0;
    for (const a of appts) {
      const id = await queuePatientMessage(
        ctx.db,
        a.practiceId,
        {
          patientId: a.patientId,
          template: "running-late",
          params: { practiceName: practice.legalName, minutes: b.minutes },
          purpose: "running-late",
          relatedType: "Appointment",
          relatedId: a.id,
          createdById: me.userId,
          ...(b.channel === "SMS" || b.channel === "EMAIL" ? { prefer: b.channel } : {}),
        },
        ctx.afterCommit,
      );
      if (id) queued++;
    }
    ctx.audit.detail({ recipients: appts.length, queued, minutes: b.minutes });
    return { requestId: ctx.requestId, status: "queued" as const };
  },
};
