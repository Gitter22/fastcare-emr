import type { AppointmentStatus } from "../../db.js";
import { getEnv } from "../../env.js";
import { queuePatientMessage } from "../../platform/communications.js";
import { limitOf, toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { centsToMoney, patientBalanceCents } from "../../platform/ledger.js";
import { notifyPool } from "../../platform/notify.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { dayRange, localParts, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { writeVersion } from "../../platform/versioning.js";
import { takePayment } from "../billing/payments.js";
import { encounterDetail } from "../encounters/views.js";
import { FLOW_STAGES } from "./domain.js";
import {
  assertSlot,
  isToday,
  loadAppointment,
  lockProviderDay,
  notifyPatient,
  searchSlots,
  transition,
  whenText,
} from "./service.js";
import { allowedTransitions, appointmentViews, practitionerName } from "./views.js";

/** Scheduling (schedule.*, flow:access, flow:checkin). Every status change goes through `transition`. */

const one = async (ctx: Ctx, id: string) =>
  (
    await appointmentViews(ctx.db, [await ctx.db.appointment.findUniqueOrThrow({ where: { id } })])
  )[0]!;

async function waitTargets(
  ctx: Ctx,
): Promise<Array<{ status: AppointmentStatus; minutes: number }>> {
  const s = await ctx.db.practiceSetting.findFirst({
    where: { key: "schedule.waitTargetMinutes" },
  });
  const v = s?.value;
  // A number applies to every stage; an object sets per-stage targets (status -> minutes).
  return FLOW_STAGES.map((status) => ({
    status,
    minutes:
      typeof v === "number"
        ? v
        : v && typeof v === "object" && typeof (v as Record<string, unknown>)[status] === "number"
          ? ((v as Record<string, number>)[status] as number)
          : 15,
  }));
}

export const schedulingHandlers: HandlerMap = {
  async listAppointments(ctx) {
    const q = ctx.query;
    const tz = await practiceTimeZone(ctx.db);
    const from = q.from
      ? new Date(q.from.length === 10 ? dayRange(q.from, tz).start : q.from)
      : dayRange(todayLocal(tz), tz).start;
    const to = q.to
      ? new Date(q.to.length === 10 ? dayRange(q.to, tz).end : q.to)
      : new Date(from.getTime() + 86_400_000);
    if (q.patientId) await requirePatient(ctx, q.patientId);
    const limit = limitOf(q);
    const offset = Number(q.cursor ?? 0) || 0;
    const rows = await ctx.db.appointment.findMany({
      where: {
        start: { gte: from, lt: to },
        ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
        ...(q.locationId ? { locationId: q.locationId } : {}),
        ...(q.status?.length ? { status: { in: q.status as AppointmentStatus[] } } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
      },
      orderBy: [{ start: "asc" }, { id: "asc" }],
      take: limit + 1,
      skip: offset,
    });
    ctx.audit.detail({ rows: rows.length });
    const pageRows = rows.slice(0, limit);
    return {
      data: await appointmentViews(ctx.db, pageRows),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
      hasMore: rows.length > limit,
    };
  },

  async searchAvailability(ctx) {
    const q = ctx.query;
    if (!q.visitTypeId)
      throw unprocessable("validation_failed", "Choose a visit type to see open times.", {
        errors: [{ field: "visitTypeId", code: "required", message: "Choose a visit type." }],
      });
    return searchSlots(ctx.db, {
      ...q,
      visitTypeId: q.visitTypeId,
      timeOfDay: q.timeOfDay as "morning" | "afternoon" | "any" | undefined,
      channel: "STAFF",
    });
  },

  async bookAppointment(ctx) {
    const b = ctx.body;
    const me = ctx.staff();
    await requirePatient(ctx, b.patientId);
    const start = new Date(b.start);
    const tz = await practiceTimeZone(ctx.db);
    await lockProviderDay(ctx.db, b.practitionerId, localParts(start, tz).date);
    const { end } = await assertSlot(ctx, {
      start,
      practitionerId: b.practitionerId,
      locationId: b.locationId,
      visitTypeId: b.visitTypeId,
      modality: b.modality,
      overbookReason: b.overbookReason,
    });
    const a = await ctx.db.appointment.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: b.patientId,
        practitionerId: b.practitionerId,
        locationId: b.locationId,
        visitTypeId: b.visitTypeId,
        modality: b.modality,
        start,
        end,
        reason: b.reason ?? null,
        comment: b.overbookReason ? `Overbooked: ${b.overbookReason}` : null,
        bookingChannel: b.waitlistEntryId ? "WAITLIST" : "STAFF",
        status: "BOOKED",
        createdById: me.userId,
      },
    });
    // new -> booked (states.yaml); recorded as the first status event.
    await ctx.db.appointmentStatusEvent.create({
      data: {
        practiceId: a.practiceId,
        appointmentId: a.id,
        toStatus: "BOOKED",
        byUserId: me.userId,
      },
    });
    if (b.waitlistEntryId)
      await ctx.db.waitlistEntry.updateMany({
        where: { id: b.waitlistEntryId, patientId: b.patientId },
        data: { status: "BOOKED" },
      });
    if (b.recallId)
      await ctx.db.recall.updateMany({
        where: { id: b.recallId, patientId: b.patientId },
        data: { status: "BOOKED" },
      });
    await writeVersion(ctx.db, a.practiceId, "Appointment", a, me.userId, "booked");
    if (b.sendConfirmation !== false)
      await notifyPatient(ctx, a, "appointment-confirmation", "confirmation");
    ctx.audit.resource("Appointment", a.id);
    ctx.setHeader("Location", `/api/v1/appointments/${a.id}`);
    return one(ctx, a.id);
  },

  async approveAppointmentRequest(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await assertSlot(ctx, {
      start: a.start,
      practitionerId: a.practitionerId,
      locationId: a.locationId,
      visitTypeId: a.visitTypeId,
      modality: a.modality,
      ignoreAppointmentId: a.id,
    });
    const updated = await transition(ctx, a, "booked", {
      version: ctx.body.version,
      note: ctx.body.reason,
    });
    await notifyPatient(ctx, updated, "appointment-confirmation", "confirmation");
    return one(ctx, a.id);
  },

  async getAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const [view, history, comms, enc, checkin] = await Promise.all([
      one(ctx, a.id),
      ctx.db.appointmentStatusEvent.findMany({
        where: { appointmentId: a.id },
        orderBy: { at: "asc" },
      }),
      ctx.db.communicationLog.findMany({
        where: { relatedType: "Appointment", relatedId: a.id },
        orderBy: { createdAt: "desc" },
      }),
      ctx.db.encounter.findUnique({ where: { appointmentId: a.id }, select: { id: true } }),
      ctx.db.checkinSession.findUnique({ where: { appointmentId: a.id } }),
    ]);
    const cov = await ctx.db.coverage.findFirst({
      where: { patientId: a.patientId, status: "active" },
      orderBy: { order: "asc" },
    });
    const elig = cov
      ? await ctx.db.eligibilityCheck.findFirst({
          where: { coverageId: cov.id },
          orderBy: { requestedAt: "desc" },
        })
      : null;
    return {
      appointment: view,
      statusHistory: toDtos("AppointmentStatusEvent", history),
      communications: toDtos("CommunicationLog", comms.map(maskComm)),
      ...(enc ? { encounterId: enc.id } : {}),
      ...(checkin ? { checkin: checkinView(checkin) } : {}),
      ...(elig ? { eligibility: toDto("EligibilityCheck", elig) } : {}),
      allowedTransitions: allowedTransitions(a),
    };
  },

  async updateAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    ctx.checkVersion(a.version);
    // Moves and status changes have their own operations; PATCH edits notes, reason and MA only.
    const b = ctx.body;
    const updated = await ctx.db.appointment.update({
      where: { id: a.id },
      data: {
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
        ...(b.comment !== undefined ? { comment: b.comment } : {}),
        ...(b.assignedMaId !== undefined ? { assignedMaId: b.assignedMaId } : {}),
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, a.practiceId, "Appointment", updated, ctx.staff().userId, "edit");
    ctx.audit.detail({ fields: Object.keys(b) });
    return one(ctx, a.id);
  },

  async rescheduleAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const b = ctx.body;
    ctx.checkVersion(a.version, b.version);
    if (!["REQUESTED", "BOOKED", "CONFIRMED"].includes(a.status))
      throw conflict("invalid_transition", "Only upcoming appointments can be moved.");
    const start = new Date(b.start);
    const practitionerId = b.practitionerId ?? a.practitionerId;
    const tz = await practiceTimeZone(ctx.db);
    await lockProviderDay(ctx.db, practitionerId, localParts(start, tz).date);
    const { end } = await assertSlot(ctx, {
      start,
      practitionerId,
      locationId: b.locationId ?? a.locationId,
      visitTypeId: a.visitTypeId,
      modality: b.modality ?? a.modality,
      ignoreAppointmentId: a.id,
    });
    const updated = await ctx.db.appointment.update({
      where: { id: a.id, version: a.version },
      data: {
        start,
        end,
        practitionerId,
        locationId: b.locationId ?? a.locationId,
        modality: b.modality ?? a.modality,
        ...(a.status === "CONFIRMED" ? { status: "BOOKED" } : {}),
        version: { increment: 1 },
      },
    });
    await ctx.db.appointmentStatusEvent.create({
      data: {
        practiceId: a.practiceId,
        appointmentId: a.id,
        fromStatus: a.status,
        toStatus: updated.status,
        byUserId: ctx.staff().userId,
        note: `Rescheduled${b.reason ? `: ${b.reason}` : ""}`,
      },
    });
    await writeVersion(
      ctx.db,
      a.practiceId,
      "Appointment",
      updated,
      ctx.staff().userId,
      "reschedule",
    );
    if (b.notify !== false)
      await notifyPatient(ctx, updated, "appointment-rescheduled", "reschedule");
    return one(ctx, a.id);
  },

  async confirmAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await transition(ctx, a, "confirmed", {
      version: ctx.body.version,
      note: ctx.body.reason ?? "Confirmed by staff",
    });
    return one(ctx, a.id);
  },

  async arriveAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const b = ctx.body;
    const me = ctx.staff();
    if (!(await isToday(ctx.db, a.start)))
      throw unprocessable(
        "guard_failed",
        "Patients can only be arrived on the day of the appointment.",
      );
    if (!b.identityVerified) {
      throw unprocessable(
        "validation_failed",
        "Confirm the photo ID matches the patient in person.",
        { errors: [{ field: "identityVerified", code: "required", message: "Confirm identity." }] },
      );
    }
    const warnings: string[] = [];
    let paymentId: string | undefined;
    for (const type of b.consentsSigned ?? []) {
      const has = await ctx.db.consent.findFirst({
        where: { patientId: a.patientId, type, status: "ACTIVE", revokedAt: null },
      });
      if (!has)
        await ctx.db.consent.create({
          data: {
            practiceId: a.practiceId,
            patientId: a.patientId,
            type,
            status: "ACTIVE",
            signedAt: new Date(),
            method: "tablet",
            recordedById: me.userId,
          },
        });
    }
    const loc = await ctx.db.location.findUnique({ where: { id: a.locationId } });
    const enc =
      (await ctx.db.encounter.findUnique({ where: { appointmentId: a.id } })) ??
      (await ctx.db.encounter.create({
        data: {
          practiceId: a.practiceId,
          patientId: a.patientId,
          appointmentId: a.id,
          practitionerId: a.practitionerId,
          locationId: a.locationId,
          status: "ARRIVED",
          class: a.modality === "VIDEO" ? "VR" : a.modality === "PHONE" ? "PHONE" : "AMB",
          placeOfService: a.modality === "VIDEO" ? "10" : (loc?.placeOfService ?? null),
          periodStart: new Date(),
          securityLabels: [],
          createdById: me.userId,
        },
      }));
    await transition(ctx, a, "arrived", {
      version: b.version,
      note: b.coverageVerified
        ? "ID and insurance verified"
        : "ID verified; insurance not verified",
    });
    if (!b.coverageVerified) warnings.push("Insurance was not verified at check-in.");
    if (b.copayCollected) {
      // flow:checkin/01 failure: "Copay declined; allow arrival, record balance, flag."
      const pay = await takePayment(ctx.db, {
        practiceId: a.practiceId,
        patientId: a.patientId,
        amount: b.copayCollected.amount,
        method: b.copayCollected.method,
        paymentMethodId: b.copayCollected.paymentMethodId,
        hostedFieldsToken: b.copayCollected.hostedFieldsToken,
        checkNumber: b.copayCollected.checkNumber,
        appointmentId: a.id,
        encounterId: enc.id,
        channel: "front-desk",
        locationId: a.locationId,
        takenById: me.userId,
        idempotencyKey: b.copayCollected.idempotencyKey,
      });
      if (pay.status !== "SUCCEEDED")
        warnings.push("Payment was declined. The amount stays on the patient's balance.");
      else paymentId = pay.id;
      ctx.audit.add({
        action: "CREATE",
        patientId: a.patientId,
        resourceType: "Payment",
        resourceId: pay.id,
        detail: { status: pay.status },
      });
    }
    // flow:checkin/02: wait timer starts; MA pool notified (no PHI in the title).
    const pool = await ctx.db.workPool.findFirst({ where: { kind: "care-team", active: true } });
    if (pool)
      await notifyPool(ctx.db, a.practiceId, pool.id, {
        type: "GENERAL",
        title: `Patient arrived for ${(await ctx.db.practitioner.findUnique({ where: { id: a.practitionerId } }))?.lastName ?? "provider"} · ${whenText(a.start, await practiceTimeZone(ctx.db))}`,
        linkRoute: "/schedule/flow",
      });
    return {
      appointment: await one(ctx, a.id),
      encounterId: enc.id,
      warnings,
      ...(paymentId ? { paymentId } : {}),
    };
  },

  async roomAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const room = await ctx.db.room.findUnique({ where: { id: ctx.body.roomId } });
    if (!room || !room.active || room.locationId !== a.locationId)
      throw unprocessable("validation_failed", "Choose a room at this location.", {
        errors: [{ field: "roomId", code: "invalid", message: "Choose a room at this location." }],
      });
    if (room.status === "OCCUPIED" || room.status === "OUT_OF_SERVICE")
      throw conflict("room_unavailable", `${room.name} isn't free.`);
    const me = ctx.staff();
    await transition(ctx, a, "roomed", {
      version: ctx.body.version,
      data: { roomId: room.id, assignedMaId: me.userId },
    });
    await ctx.db.room.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });
    const enc = await ctx.db.encounter.upsert({
      where: { appointmentId: a.id },
      create: {
        practiceId: a.practiceId,
        patientId: a.patientId,
        appointmentId: a.id,
        practitionerId: a.practitionerId,
        locationId: a.locationId,
        status: "IN_PROGRESS",
        periodStart: new Date(),
        securityLabels: [],
        createdById: me.userId,
      },
      update: { status: "IN_PROGRESS" },
    });
    return encounterDetail(ctx.db, enc.id);
  },

  async markReadyForProvider(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await transition(ctx, a, "ready-for-provider", { version: ctx.body.version });
    await ctx.db.encounter.updateMany({
      where: { appointmentId: a.id },
      data: { readyForProviderAt: new Date() },
    });
    return one(ctx, a.id);
  },

  async startVisit(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await transition(ctx, a, "with-provider", { version: ctx.body.version });
    await ctx.db.encounter.updateMany({
      where: { appointmentId: a.id },
      data: { status: "IN_PROGRESS" },
    });
    return one(ctx, a.id);
  },

  async endVisit(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await transition(ctx, a, "checkout", { version: ctx.body.version });
    if (a.roomId)
      await ctx.db.room.update({ where: { id: a.roomId }, data: { status: "NEEDS_CLEANING" } });
    return one(ctx, a.id);
  },

  async getCheckout(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const view = await one(ctx, a.id);
    const enc = await ctx.db.encounter.findUnique({ where: { appointmentId: a.id } });
    const [avs, balance] = await Promise.all([
      enc ? ctx.db.afterVisitSummary.findFirst({ where: { encounterId: enc.id } }) : null,
      patientBalanceView(ctx, a.patientId),
    ]);
    return {
      appointment: view,
      ...(avs ? { avs: toDto("AfterVisitSummary", avs) } : {}),
      followUps: enc?.followUpInstruction ? [{ text: enc.followUpInstruction }] : [],
      ordersToSchedule: [],
      referrals: [],
      balance,
      ...(view.copayDue ? { copayDue: view.copayDue } : {}),
    };
  },

  async completeCheckout(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const b = ctx.body;
    const me = ctx.staff();
    ctx.checkVersion(a.version, b.version);
    const enc = await ctx.db.encounter.findUnique({ where: { appointmentId: a.id } });
    let followUpId: string | null = null;
    if (b.followUpAppointment) {
      const f = b.followUpAppointment;
      if (f.patientId !== a.patientId)
        throw unprocessable("validation_failed", "The follow-up must be for the same patient.");
      const start = new Date(f.start);
      await lockProviderDay(
        ctx.db,
        f.practitionerId,
        localParts(start, await practiceTimeZone(ctx.db)).date,
      );
      const { end } = await assertSlot(ctx, {
        start,
        practitionerId: f.practitionerId,
        locationId: f.locationId,
        visitTypeId: f.visitTypeId,
        modality: f.modality,
        overbookReason: f.overbookReason,
      });
      const fu = await ctx.db.appointment.create({
        data: {
          practiceId: a.practiceId,
          patientId: a.patientId,
          practitionerId: f.practitionerId,
          locationId: f.locationId,
          visitTypeId: f.visitTypeId,
          modality: f.modality,
          start,
          end,
          reason: f.reason ?? null,
          status: "BOOKED",
          createdById: me.userId,
        },
      });
      await ctx.db.appointmentStatusEvent.create({
        data: {
          practiceId: a.practiceId,
          appointmentId: fu.id,
          toStatus: "BOOKED",
          byUserId: me.userId,
          note: "Follow-up booked at checkout",
        },
      });
      if (f.sendConfirmation !== false)
        await notifyPatient(ctx, fu, "appointment-confirmation", "confirmation");
      followUpId = fu.id;
    }
    if (b.payment) {
      const pay = await takePayment(ctx.db, {
        practiceId: a.practiceId,
        patientId: a.patientId,
        amount: b.payment.amount,
        method: b.payment.method,
        paymentMethodId: b.payment.paymentMethodId,
        hostedFieldsToken: b.payment.hostedFieldsToken,
        checkNumber: b.payment.checkNumber,
        appointmentId: a.id,
        encounterId: enc?.id ?? null,
        channel: "front-desk",
        locationId: a.locationId,
        takenById: me.userId,
        idempotencyKey: b.payment.idempotencyKey,
      });
      if (pay.status !== "SUCCEEDED")
        throw unprocessable(
          "payment_declined",
          "The payment was declined. Try another method or collect later.",
        );
    }
    if (enc && b.avsDelivery?.includes("portal")) {
      await ctx.db.afterVisitSummary.updateMany({
        where: { encounterId: enc.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });
    }
    await transition(ctx, a, "completed", {
      note: followUpId ? "Checked out; follow-up booked" : "Checked out",
    });
    if (enc)
      await ctx.db.encounter.update({
        where: { id: enc.id },
        data: {
          periodEnd: enc.periodEnd ?? new Date(),
          status:
            enc.status === "IN_PROGRESS" || enc.status === "ARRIVED" ? "FINISHED" : enc.status,
        },
      });
    return one(ctx, a.id);
  },

  async markNoShow(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    if (a.start > new Date())
      throw unprocessable(
        "guard_failed",
        "An appointment can be marked no-show only after its start time.",
      );
    await transition(ctx, a, "no-show", { version: ctx.body.version, note: ctx.body.reason });
    return one(ctx, a.id);
  },

  async cancelAppointment(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const b = ctx.body;
    if (!b.reason?.trim())
      throw unprocessable("validation_failed", "Choose a reason.", {
        errors: [{ field: "reason", code: "required", message: "Choose a reason." }],
      });
    const updated = await transition(ctx, a, "cancelled", {
      version: b.version,
      data: { cancellationReason: `${b.reasonCode}: ${b.reason}`.slice(0, 500) },
      note: b.reason,
    });
    if (b.notify) await notifyPatient(ctx, updated, "appointment-cancelled", "cancellation");
    if (b.offerToWaitlist) {
      // Freed slot: queue the best waitlist match for the front desk to offer (no automatic texting without staff).
      const match = await ctx.db.waitlistEntry.findFirst({
        where: {
          status: "ACTIVE",
          visitTypeId: a.visitTypeId,
          OR: [{ practitionerId: null }, { practitionerId: a.practitionerId }],
          AND: [
            { OR: [{ earliest: null }, { earliest: { lte: a.start } }] },
            { OR: [{ latest: null }, { latest: { gte: a.start } }] },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
      if (match) ctx.audit.detail({ waitlistMatch: match.id });
    }
    return one(ctx, a.id);
  },

  async markLeftWithoutBeingSeen(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    await transition(ctx, a, "left-without-being-seen", {
      version: ctx.body.version,
      note: ctx.body.reason,
    });
    if (a.roomId)
      await ctx.db.room.update({ where: { id: a.roomId }, data: { status: "NEEDS_CLEANING" } });
    await ctx.db.encounter.updateMany({
      where: { appointmentId: a.id, status: { in: ["PLANNED", "ARRIVED", "IN_PROGRESS"] } },
      data: { status: "CANCELLED", periodEnd: new Date() },
    });
    return one(ctx, a.id);
  },

  async listAppointmentCommunications(ctx) {
    const a = await loadAppointment(ctx, ctx.params.appointmentId);
    const rows = await ctx.db.communicationLog.findMany({
      where: { relatedType: "Appointment", relatedId: a.id },
      orderBy: { createdAt: "desc" },
    });
    return toDtos("CommunicationLog", rows.map(maskComm));
  },

  // ------------------------------------------------------------------ boards
  async getFlowBoard(ctx) {
    const q = ctx.query;
    const tz = await practiceTimeZone(ctx.db);
    const { start, end } = dayRange(q.date ?? todayLocal(tz), tz);
    const loc =
      q.locationId ??
      (await ctx.db.location.findFirst({ where: { active: true }, orderBy: { name: "asc" } }))
        ?.id ??
      "";
    const rows = await ctx.db.appointment.findMany({
      where: {
        start: { gte: start, lt: end },
        status: { in: [...FLOW_STAGES] },
        ...(loc ? { locationId: loc } : {}),
        ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
      },
      orderBy: { start: "asc" },
    });
    const [views, events, thresholds] = await Promise.all([
      appointmentViews(ctx.db, rows),
      ctx.db.appointmentStatusEvent.findMany({
        where: { appointmentId: { in: rows.map((r) => r.id) } },
        orderBy: { at: "desc" },
      }),
      waitTargets(ctx),
    ]);
    return {
      locationId: loc,
      rows: views.map((v) => {
        const entered =
          events.find((e) => e.appointmentId === v.id && e.toStatus === v.status)?.at ?? new Date();
        const wait = Math.max(0, Math.round((Date.now() - entered.getTime()) / 60_000));
        const target = thresholds.find((t) => t.status === v.status)?.minutes ?? 15;
        return {
          appointment: v,
          stage: v.status,
          enteredStageAt: entered.toISOString(),
          waitMinutes: wait,
          overThreshold: wait > target && v.status !== "WITH_PROVIDER",
        };
      }),
      thresholds,
    };
  },

  async getRoomBoard(ctx) {
    const loc =
      ctx.query.locationId ??
      (await ctx.db.location.findFirst({ where: { active: true }, orderBy: { name: "asc" } }))
        ?.id ??
      "";
    const rooms = await ctx.db.room.findMany({
      where: { locationId: loc, active: true },
      orderBy: { name: "asc" },
    });
    const occupied = await ctx.db.appointment.findMany({
      where: {
        roomId: { in: rooms.map((r) => r.id) },
        status: { in: ["ROOMED", "READY_FOR_PROVIDER", "WITH_PROVIDER"] },
      },
    });
    const views = await appointmentViews(ctx.db, occupied);
    const events = await ctx.db.appointmentStatusEvent.findMany({
      where: { appointmentId: { in: occupied.map((o) => o.id) }, toStatus: "ROOMED" },
    });
    return {
      locationId: loc,
      rooms: rooms.map((r) => {
        const appt = occupied.find((o) => o.roomId === r.id);
        const since = appt ? events.find((e) => e.appointmentId === appt.id)?.at : undefined;
        return {
          room: toDto("Room", r),
          ...(appt ? { appointment: views.find((v) => v.id === appt.id)! } : {}),
          ...(since ? { since: since.toISOString() } : {}),
        };
      }),
    };
  },

  async getFrontDeskBoard(ctx) {
    const q = ctx.query;
    const tz = await practiceTimeZone(ctx.db);
    const date = q.date ?? todayLocal(tz);
    const { start, end } = dayRange(date, tz);
    const loc =
      q.locationId ??
      (await ctx.db.location.findFirst({ where: { active: true }, orderBy: { name: "asc" } }))
        ?.id ??
      "";
    const rows = await ctx.db.appointment.findMany({
      where: {
        start: { gte: start, lt: end },
        ...(loc ? { locationId: loc } : {}),
        ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
        status: { not: "REQUESTED" },
      },
      orderBy: { start: "asc" },
    });
    const views = await appointmentViews(ctx.db, rows);
    const statuses = [...new Set(views.map((v) => v.status))];
    const alerts: Array<{
      kind: "eligibility" | "forms" | "balance" | "unconfirmed";
      appointmentId: string;
      text: string;
    }> = [];
    for (const v of views) {
      if (!["BOOKED", "CONFIRMED", "ARRIVED"].includes(v.status)) continue;
      if (v.eligibility === "INACTIVE" || v.eligibility === "ERROR")
        alerts.push({
          kind: "eligibility",
          appointmentId: v.id,
          text: v.eligibility === "INACTIVE" ? "Coverage inactive" : "Eligibility not verified",
        });
      if (v.formsOutstanding)
        alerts.push({
          kind: "forms",
          appointmentId: v.id,
          text: `${v.formsOutstanding} consent${v.formsOutstanding > 1 ? "s" : ""} to sign`,
        });
      if (v.balanceDue && Number(v.balanceDue) > 0)
        alerts.push({ kind: "balance", appointmentId: v.id, text: `Balance ${v.balanceDue}` });
      if (v.status === "BOOKED")
        alerts.push({ kind: "unconfirmed", appointmentId: v.id, text: "Not confirmed" });
    }
    const count = (s: AppointmentStatus[]) => views.filter((v) => s.includes(v.status)).length;
    ctx.audit.detail({ rows: views.length });
    return {
      date,
      locationId: loc,
      counts: {
        booked: count(["BOOKED"]),
        confirmed: count(["CONFIRMED"]),
        arrived: count([
          "ARRIVED",
          "ROOMED",
          "READY_FOR_PROVIDER",
          "WITH_PROVIDER",
          "CHECKOUT",
          "COMPLETED",
        ]),
        noShow: count(["NO_SHOW"]),
        cancelled: count(["CANCELLED"]),
      },
      columns: statuses.map((status) => ({
        status,
        appointments: views.filter((v) => v.status === status),
      })),
      alerts,
    };
  },

  // ------------------------------------------------------------------ waitlist and recalls
  async listWaitlist(ctx) {
    const q = ctx.query;
    const rows = await ctx.db.waitlistEntry.findMany({
      where: {
        status: { in: q.status?.length ? (q.status as never) : ["ACTIVE", "OFFERED"] },
        ...(q.visitTypeId ? { visitTypeId: q.visitTypeId } : {}),
        ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
      },
      include: { patient: { include: { contactPoints: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    const [vts, prs] = await Promise.all([
      ctx.db.visitType.findMany({ where: { id: { in: rows.map((r) => r.visitTypeId) } } }),
      ctx.db.practitioner.findMany({
        where: { id: { in: rows.map((r) => r.practitionerId).filter((x): x is string => !!x) } },
      }),
    ]);
    const { toSummary } = await import("../patients/service.js");
    return {
      data: rows.map(({ patient, ...w }) => ({
        ...toDto("WaitlistEntry", w),
        patient: toSummary(patient),
        ...(vts.find((v) => v.id === w.visitTypeId)
          ? {
              visitType: toDto(
                "VisitType",
                vts.find((v) => v.id === w.visitTypeId),
              ),
            }
          : {}),
        ...(w.practitionerId && prs.find((p) => p.id === w.practitionerId)
          ? { practitionerName: practitionerName(prs.find((p) => p.id === w.practitionerId)!) }
          : {}),
      })),
      nextCursor: null,
      hasMore: false,
    };
  },

  async createWaitlistEntry(ctx) {
    const b = ctx.body;
    await requirePatient(ctx, b.patientId);
    const w = await ctx.db.waitlistEntry.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: b.patientId,
        visitTypeId: b.visitTypeId,
        practitionerId: b.practitionerId ?? null,
        earliest: b.earliest ? new Date(b.earliest) : null,
        latest: b.latest ? new Date(b.latest) : null,
        status: "ACTIVE",
      },
    });
    ctx.audit.resource("WaitlistEntry", w.id);
    return toDto("WaitlistEntry", w);
  },

  async removeWaitlistEntry(ctx) {
    const w = await ctx.db.waitlistEntry.findUnique({ where: { id: ctx.params.waitlistEntryId } });
    if (!w) throw notFound();
    ctx.audit.patient(w.patientId);
    await ctx.db.waitlistEntry.update({ where: { id: w.id }, data: { status: "REMOVED" } });
  },

  async offerWaitlistSlot(ctx) {
    const w = await ctx.db.waitlistEntry.findUnique({ where: { id: ctx.params.waitlistEntryId } });
    if (!w || w.status === "REMOVED" || w.status === "BOOKED") throw notFound();
    ctx.audit.patient(w.patientId);
    const b = ctx.body;
    const start = new Date(b.start);
    const vt = await ctx.db.visitType.findUniqueOrThrow({ where: { id: b.visitTypeId } });
    await assertSlot(ctx, {
      start,
      practitionerId: b.practitionerId,
      locationId: b.locationId,
      visitTypeId: vt.id,
      modality: vt.modalities[0] ?? "IN_PERSON",
    });
    const updated = await ctx.db.waitlistEntry.update({
      where: { id: w.id },
      data: {
        status: "OFFERED",
        offeredSlotStart: start,
        offerExpiresAt: new Date(Date.now() + b.expiresInMinutes * 60_000),
      },
    });
    const tz = await practiceTimeZone(ctx.db);
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: w.practiceId } });
    await queuePatientMessage(
      ctx.db,
      w.practiceId,
      {
        patientId: w.patientId,
        template: "waitlist-offer",
        params: {
          practiceName: practice.legalName,
          when: whenText(start, tz),
          link: `${getEnv().WEB_BASE_URL}/portal/appointments`,
        },
        purpose: "waitlist-offer",
        relatedType: "WaitlistEntry",
        relatedId: w.id,
        prefer: b.channel === "EMAIL" ? "EMAIL" : "SMS",
        createdById: ctx.staff().userId,
      },
      ctx.afterCommit,
    );
    return toDto("WaitlistEntry", updated);
  },

  async listRecalls(ctx) {
    const q = ctx.query;
    const rows = await ctx.db.recall.findMany({
      where: {
        status: { in: q.status?.length ? (q.status as never) : ["DUE", "CONTACTED"] },
        ...(q.category ? { reason: { contains: q.category, mode: "insensitive" } } : {}),
      },
      include: { patient: { include: { contactPoints: true } } },
      orderBy: { dueDate: "asc" },
      take: 500,
    });
    const logs = await ctx.db.communicationLog.findMany({
      where: { relatedType: "Recall", relatedId: { in: rows.map((r) => r.id) } },
      orderBy: { createdAt: "desc" },
    });
    const { toSummary } = await import("../patients/service.js");
    return {
      data: rows.map(({ patient, ...r }) => ({
        ...toDto("Recall", r),
        patient: toSummary(patient),
        outreach: logs.filter((l) => l.relatedId === r.id).map(attemptOf),
      })),
      nextCursor: null,
      hasMore: false,
    };
  },

  async createRecall(ctx) {
    const b = ctx.body;
    await requirePatient(ctx, b.patientId);
    const r = await ctx.db.recall.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: b.patientId,
        reason: b.reason,
        dueDate: new Date(`${b.dueDate}T00:00:00Z`),
        status: "DUE",
      },
    });
    ctx.audit.resource("Recall", r.id);
    return [toDto("Recall", r)];
  },

  async logRecallContact(ctx) {
    const r = await ctx.db.recall.findUnique({ where: { id: ctx.params.recallId } });
    if (!r) throw notFound();
    ctx.audit.patient(r.patientId);
    const b = ctx.body;
    await ctx.db.communicationLog.create({
      data: {
        practiceId: r.practiceId,
        patientId: r.patientId,
        channel: b.channel,
        direction: "outbound",
        purpose: "recall",
        to: "",
        status: b.outcome === "no-answer" ? "FAILED" : "DELIVERED",
        relatedType: "Recall",
        relatedId: r.id,
        summary: `${b.outcome}${b.note ? `: ${b.note}` : ""}`.slice(0, 500),
        sentAt: new Date(b.at),
        createdById: ctx.staff().userId,
      },
    });
    const updated = await ctx.db.recall.update({
      where: { id: r.id },
      data: {
        attempts: { increment: 1 },
        lastContactAt: new Date(b.at),
        status:
          b.outcome === "booked" ? "BOOKED" : b.outcome === "declined" ? "CLOSED" : "CONTACTED",
      },
    });
    return toDto("Recall", updated);
  },

  async sendRecallCampaign(ctx) {
    const b = ctx.body;
    const recalls = await ctx.db.recall.findMany({
      where: { id: { in: b.recallIds }, status: { in: ["DUE", "CONTACTED"] } },
    });
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: ctx.practiceId! } });
    for (const r of recalls) {
      // Booking link only; the reason for the recall never goes in the message (INV-SEC-06).
      await queuePatientMessage(
        ctx.db,
        r.practiceId,
        {
          patientId: r.patientId,
          template: "recall-outreach",
          params: {
            practiceName: practice.legalName,
            link: `${getEnv().WEB_BASE_URL}/portal/appointments`,
          },
          purpose: "recall",
          relatedType: "Recall",
          relatedId: r.id,
          prefer: b.channel === "EMAIL" ? "EMAIL" : "SMS",
          createdById: ctx.staff().userId,
        },
        ctx.afterCommit,
      );
      await ctx.db.recall.update({
        where: { id: r.id },
        data: { attempts: { increment: 1 }, lastContactAt: new Date(), status: "CONTACTED" },
      });
      ctx.audit.add({
        action: "CREATE",
        patientId: r.patientId,
        resourceType: "Recall",
        resourceId: r.id,
        detail: { outreach: true },
      });
    }
    const job = await ctx.db.job.create({
      data: {
        practiceId: ctx.practiceId!,
        type: "recall-campaign",
        params: { recallIds: recalls.map((r) => r.id), channel: b.channel },
        status: "SUCCEEDED",
        progress: 100,
        resultFileIds: [],
        requestedById: ctx.staff().userId,
        finishedAt: new Date(),
      },
    });
    ctx.setStatus(202);
    return toDto("Job", job);
  },
};

function maskComm<T extends { to: string; channel: string }>(c: T): T {
  // Phone/email masked in API responses (CommunicationLog.to).
  return { ...c, to: c.to ? "•••" : "" };
}

function attemptOf(l: {
  createdAt: Date;
  sentAt: Date | null;
  channel: "SMS" | "EMAIL" | "VOICE" | "PORTAL" | "LETTER" | "FAX";
  summary: string | null;
  status: string;
}) {
  const outcome = (l.summary?.split(":")[0] ?? (l.status === "FAILED" ? "no-answer" : "sent")) as
    | "sent"
    | "reached"
    | "left-message"
    | "no-answer"
    | "booked"
    | "declined";
  return {
    at: (l.sentAt ?? l.createdAt).toISOString(),
    channel: l.channel,
    outcome: ["sent", "reached", "left-message", "no-answer", "booked", "declined"].includes(
      outcome,
    )
      ? outcome
      : "sent",
    ...(l.summary?.includes(":") ? { note: l.summary.split(":").slice(1).join(":").trim() } : {}),
  };
}

function checkinView(c: {
  appointmentId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  steps: unknown;
}) {
  const steps = (c.steps && typeof c.steps === "object" ? c.steps : {}) as Record<string, string>;
  const keys = [
    "details",
    "insurance",
    "questionnaire",
    "medications",
    "consents",
    "payment",
  ] as const;
  return {
    appointmentId: c.appointmentId,
    status: c.status,
    steps: keys.map((key) => ({ key, done: steps[key] === "done", required: key !== "payment" })),
  };
}

export async function patientBalanceView(ctx: Ctx, patientId: string) {
  const [patient, insurance] = await Promise.all([
    patientBalanceCents(ctx.db, patientId, "PATIENT"),
    patientBalanceCents(ctx.db, patientId, "INSURANCE"),
  ]);
  return {
    patientId,
    insurancePending: centsToMoney(Math.max(0, insurance)),
    patientDue: centsToMoney(Math.max(0, patient)),
    credit: centsToMoney(Math.max(0, -patient)),
    inCollections: false,
  };
}
