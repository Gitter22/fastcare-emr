import type { Appointment, Modality, Prisma, Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import type { Ctx } from "../../platform/http/context.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { assertTransition, toEnum } from "../../platform/stateMachine.js";
import { addDays, localParts, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { writeVersion } from "../../platform/versioning.js";
import { queuePatientMessage } from "../../platform/communications.js";
import {
  OCCUPYING,
  isBookable,
  openSlots,
  parseWindows,
  type Busy,
  type TemplateInput,
} from "./domain.js";

/** Appointment lifecycle (states.yaml#appointment). Status changes only through `transition`. */

export async function loadAppointment(ctx: Ctx, id: string): Promise<Appointment> {
  const a = await ctx.db.appointment.findUnique({ where: { id } });
  if (!a) throw notFound();
  ctx.audit.patient(a.patientId);
  ctx.audit.resource("Appointment", a.id);
  return a;
}

/**
 * Applies one state change: checks it exists in states.yaml and the caller's role may make it, checks the
 * version (optimistic concurrency), writes the AppointmentStatusEvent (flow-board timers, cycle time) and a version
 * snapshot.
 */
export async function transition(
  ctx: Ctx,
  a: Appointment,
  toId: string,
  opts: {
    version?: number;
    data?: Prisma.AppointmentUncheckedUpdateInput;
    note?: string;
    actor?: "system";
  } = {},
): Promise<Appointment> {
  const role =
    opts.actor === "system"
      ? "system"
      : ctx.principal?.kind === "portal"
        ? "patient"
        : ctx.staff().role;
  assertTransition("appointment", a.status, toId, role);
  if (opts.version !== undefined) ctx.checkVersion(a.version, opts.version);
  const updated = await ctx.db.appointment.update({
    where: { id: a.id, version: a.version },
    data: {
      ...(opts.data ?? {}),
      status: toEnum(toId) as Appointment["status"],
      version: { increment: 1 },
    },
  });
  await ctx.db.appointmentStatusEvent.create({
    data: {
      practiceId: a.practiceId,
      appointmentId: a.id,
      fromStatus: a.status,
      toStatus: updated.status,
      byUserId: ctx.principal?.kind === "staff" ? ctx.principal.userId : null,
      byPortalUserId: ctx.principal?.kind === "portal" ? ctx.principal.portalUserId : null,
      note: opts.note ?? null,
    },
  });
  await writeVersion(
    ctx.db,
    a.practiceId,
    "Appointment",
    updated,
    ctx.principal?.kind === "staff" ? ctx.principal.userId : null,
    `status ${toId}`,
  );
  ctx.audit.detail({ transition: `appointment:${a.status}->${toId}` });
  return updated;
}

export async function availabilityInputs(
  tx: Tx,
  fromIso: Date,
  toIso: Date,
  practitionerIds?: string[],
) {
  const [templates, blocks, appts] = await Promise.all([
    tx.scheduleTemplate.findMany({
      where: practitionerIds?.length ? { practitionerId: { in: practitionerIds } } : {},
    }),
    tx.scheduleBlock.findMany({ where: { start: { lt: toIso }, end: { gt: fromIso } } }),
    tx.appointment.findMany({
      where: {
        start: { lt: toIso },
        end: { gt: fromIso },
        status: { in: [...OCCUPYING] },
        ...(practitionerIds?.length ? { practitionerId: { in: practitionerIds } } : {}),
      },
      select: { id: true, practitionerId: true, start: true, end: true },
    }),
  ]);
  const tmpl: TemplateInput[] = templates.map((t) => ({
    practitionerId: t.practitionerId,
    locationId: t.locationId,
    effectiveFrom: t.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : null,
    windows: parseWindows(t.slots),
  }));
  const busy: Busy[] = [
    ...blocks.map((b) => ({
      practitionerId: b.practitionerId,
      start: b.start,
      end: b.end,
      kind: "block" as const,
    })),
    ...appts.map((a) => ({
      practitionerId: a.practitionerId,
      start: a.start,
      end: a.end,
      kind: "appointment" as const,
      id: a.id,
    })),
  ];
  return { tmpl, busy, appts };
}

export async function slotStep(tx: Tx): Promise<number> {
  const s = await tx.practiceSetting.findFirst({ where: { key: "schedule.slotMinutes" } });
  const n = Number(s?.value ?? 15);
  return Number.isFinite(n) && n >= 5 ? n : 15;
}

/**
 * Guard "slot available per visit type rules" (states.yaml) for booking and rescheduling. An overbook needs a
 * recorded reason; the reason goes on the appointment comment and in the audit detail.
 */
export async function assertSlot(
  ctx: Ctx,
  input: {
    start: Date;
    practitionerId: string;
    locationId: string;
    visitTypeId: string;
    modality: Modality;
    overbookReason?: string | null;
    ignoreAppointmentId?: string;
  },
) {
  const vt = await ctx.db.visitType.findUnique({ where: { id: input.visitTypeId } });
  if (!vt || !vt.active)
    throw unprocessable("validation_failed", "Choose an active visit type.", {
      errors: [{ field: "visitTypeId", code: "inactive", message: "Choose an active visit type." }],
    });
  if (vt.modalities.length && !vt.modalities.includes(input.modality)) {
    throw unprocessable(
      "validation_failed",
      `${vt.name} can't be booked as ${input.modality.toLowerCase().replace("_", " ")}.`,
      {
        errors: [
          { field: "modality", code: "not_allowed", message: "Not allowed for this visit type." },
        ],
      },
    );
  }
  const end = new Date(input.start.getTime() + vt.durationMinutes * 60_000);
  const tz = await practiceTimeZone(ctx.db);
  const { tmpl, busy } = await availabilityInputs(ctx.db, input.start, end, [input.practitionerId]);
  const free = busy.filter(
    (b) => !("id" in b) || (b as { id: string }).id !== input.ignoreAppointmentId,
  );
  const ok = isBookable(
    input.start,
    vt.durationMinutes,
    input.practitionerId,
    input.locationId,
    {
      tz,
      stepMinutes: await slotStep(ctx.db),
      durationMinutes: vt.durationMinutes,
      visitTypeId: vt.id,
      notBefore: new Date(Date.now() - 60_000),
    },
    tmpl,
    free,
  );
  if (!ok) {
    if (!input.overbookReason?.trim()) {
      throw conflict(
        "slot_unavailable",
        "That time is no longer open. Pick another slot or record an overbook reason.",
      );
    }
    ctx.audit.detail({ overbook: true });
  }
  return { vt, end, tz };
}

/** Serialises bookings for one provider-day so two people can't take the same slot (double-booking race). */
export async function lockProviderDay(tx: Tx, practitionerId: string, day: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`book:${practitionerId}:${day}`}))`;
}

export async function searchSlots(
  tx: Tx,
  q: {
    visitTypeId: string;
    practitionerId?: string;
    locationId?: string;
    modality?: Modality;
    fromDate?: string;
    toDate?: string;
    timeOfDay?: "morning" | "afternoon" | "any";
    channel?: "STAFF" | "PORTAL";
  },
) {
  const vt = await tx.visitType.findUnique({ where: { id: q.visitTypeId } });
  if (!vt || !vt.active) throw unprocessable("validation_failed", "Choose an active visit type.");
  const tz = await practiceTimeZone(tx);
  const today = todayLocal(tz);
  const from = q.fromDate && q.fromDate > today ? q.fromDate : today;
  const to = q.toDate ?? addDays(from, 13);
  const minNotice = q.channel === "PORTAL" ? vt.minNoticeHours : 0;
  const notBefore = new Date(Date.now() + minNotice * 3_600_000);
  const range = {
    start: new Date(`${from}T00:00:00Z`),
    end: new Date(`${addDays(to, 2)}T00:00:00Z`),
  };
  const step = await slotStep(tx);
  const run = async (f: string, t: string, limit?: number) => {
    const { tmpl, busy } = await availabilityInputs(
      tx,
      new Date(`${addDays(f, -1)}T00:00:00Z`),
      new Date(`${addDays(t, 2)}T00:00:00Z`),
      q.practitionerId ? [q.practitionerId] : undefined,
    );
    return openSlots(
      {
        fromDate: f,
        toDate: t,
        tz,
        stepMinutes: step,
        durationMinutes: vt.durationMinutes,
        visitTypeId: vt.id,
        practitionerIds: q.practitionerId ? [q.practitionerId] : undefined,
        locationId: q.locationId,
        timeOfDay: q.timeOfDay,
        notBefore,
        limit,
      },
      tmpl,
      busy,
    );
  };
  void range;
  const slots = await run(from, to);
  let nextAvailable: string | undefined;
  if (!slots.length) {
    // "No slots in range": look ahead up to the booking window for the earliest one.
    const later = await run(addDays(to, 1), addDays(from, Math.max(vt.bookingWindowDays, 30)), 1);
    nextAvailable = later[0]?.start.toISOString();
  }
  const practitioners = await tx.practitioner.findMany({
    where: { id: { in: [...new Set(slots.map((s) => s.practitionerId))] } },
  });
  const { practitionerName } = await import("./views.js");
  const names = new Map(practitioners.map((p) => [p.id, practitionerName(p)]));
  return {
    slots: slots.slice(0, 300).map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      practitionerId: s.practitionerId,
      practitionerName: names.get(s.practitionerId) ?? "",
      locationId: s.locationId,
      modality: q.modality ?? "IN_PERSON",
      visitTypeId: vt.id,
    })),
    ...(nextAvailable ? { nextAvailable } : {}),
  };
}

/** "When" text for messages: "Wed, Oct 7 at 9:40 AM" in practice time (no clinical detail, INV-SEC-06). */
export function whenText(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(d)
    .replace(/, (\d+:\d+)/, " at $1");
}

export async function notifyPatient(
  ctx: Ctx,
  a: Appointment,
  template: "appointment-confirmation" | "appointment-cancelled" | "appointment-rescheduled",
  purpose: string,
) {
  const tz = await practiceTimeZone(ctx.db);
  const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: a.practiceId } });
  await queuePatientMessage(
    ctx.db,
    a.practiceId,
    {
      patientId: a.patientId,
      template,
      params: {
        practiceName: practice.legalName,
        when: whenText(a.start, tz),
        link: `${getEnv().WEB_BASE_URL}/portal/appointments`,
      },
      purpose,
      relatedType: "Appointment",
      relatedId: a.id,
      createdById: ctx.principal?.kind === "staff" ? ctx.principal.userId : null,
    },
    ctx.afterCommit,
  );
}

/** Appointment date is today in the practice time zone (guard for arrive). */
export async function isToday(tx: Tx, d: Date): Promise<boolean> {
  const tz = await practiceTimeZone(tx);
  return localParts(d, tz).date === todayLocal(tz);
}
