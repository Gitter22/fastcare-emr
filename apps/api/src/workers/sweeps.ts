import { getEnv } from "../env.js";
import type { Appointment, Tx } from "../db.js";
import { queuePatientMessage } from "../platform/communications.js";
import { assertTransition, toEnum } from "../platform/stateMachine.js";
import { addDays, dayRange, localParts, todayLocal } from "../platform/time.js";
import { writeAuditEntries } from "../platform/audit.js";
import { runEligibility } from "../modules/billing/eligibility.js";
import { whenText } from "../modules/scheduling/service.js";

/**
 * Scheduled sweeps (flow:access/03-04, appointment no-show guard). Each takes a tenant transaction and is
 * idempotent: running it twice does the work once. Messages are sent after the transaction commits.
 */
type AfterCommit = (fn: () => Promise<void>) => void;

const SYSTEM_ACTOR = (practiceId: string) => ({
  practiceId,
  actorType: "system" as const,
  actorId: null,
  actorRole: null,
  sessionId: null,
  ip: null,
  userAgent: "worker",
});

async function systemTransition(tx: Tx, a: Appointment, toId: string, note: string) {
  assertTransition("appointment", a.status, toId, "system");
  const updated = await tx.appointment.update({
    where: { id: a.id, version: a.version },
    data: { status: toEnum(toId) as Appointment["status"], version: { increment: 1 } },
  });
  await tx.appointmentStatusEvent.create({
    data: {
      practiceId: a.practiceId,
      appointmentId: a.id,
      fromStatus: a.status,
      toStatus: updated.status,
      note,
    },
  });
  await writeAuditEntries(tx, SYSTEM_ACTOR(a.practiceId), [
    {
      action: "UPDATE",
      patientId: a.patientId,
      resourceType: "Appointment",
      resourceId: a.id,
      operationId: "worker",
      detail: { transition: `appointment:${a.status}->${toId}` },
    },
  ]);
  return updated;
}

/** flow:access/04: reminders at 72 h and 24 h before the visit (no clinical detail; opt-outs respected). */
export async function sendReminders(
  tx: Tx,
  practice: { id: string; timezone: string },
  afterCommit: AfterCommit,
  now = new Date(),
) {
  const p = await tx.practice.findUniqueOrThrow({ where: { id: practice.id } });
  let sent = 0;
  for (const hours of [72, 24]) {
    const from = new Date(now.getTime() + (hours - 1) * 3_600_000);
    const to = new Date(now.getTime() + hours * 3_600_000);
    const appts = await tx.appointment.findMany({
      where: { start: { gte: from, lt: to }, status: { in: ["BOOKED", "CONFIRMED"] } },
    });
    for (const a of appts) {
      const purpose = `reminder-${hours}h`;
      if (
        await tx.communicationLog.findFirst({
          where: { relatedType: "Appointment", relatedId: a.id, purpose },
        })
      )
        continue;
      await queuePatientMessage(
        tx,
        practice.id,
        {
          patientId: a.patientId,
          template: "appointment-reminder",
          params: {
            practiceName: p.legalName,
            when: whenText(a.start, practice.timezone),
            link: `${getEnv().WEB_BASE_URL}/portal/appointments`,
          },
          purpose,
          relatedType: "Appointment",
          relatedId: a.id,
        },
        afterCommit,
      );
      sent++;
    }
  }
  return { sent };
}

/** flow:access/03: batch eligibility for visits in the next 48 hours that have no check in the last 24 hours. */
export async function eligibilityBatch(
  tx: Tx,
  practice: { id: string; timezone: string },
  now = new Date(),
) {
  const appts = await tx.appointment.findMany({
    where: {
      start: { gte: now, lt: new Date(now.getTime() + 48 * 3_600_000) },
      status: { in: ["BOOKED", "CONFIRMED"] },
    },
  });
  let checked = 0;
  for (const a of appts) {
    const cov = await tx.coverage.findFirst({
      where: { patientId: a.patientId, status: "active" },
      orderBy: { order: "asc" },
    });
    if (!cov) continue;
    const recent = await tx.eligibilityCheck.findFirst({
      where: { coverageId: cov.id, requestedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    });
    if (recent) continue;
    await runEligibility(tx, {
      practiceId: practice.id,
      coverageId: cov.id,
      appointmentId: a.id,
      mode: "batch",
      practitionerId: a.practitionerId,
      dateOfService: localParts(a.start, practice.timezone).date,
    });
    checked++;
  }
  return { checked };
}

/** states.yaml: booked/confirmed -> no-show, guard "end of day without arrival". Runs after local midnight. */
export async function endOfDayNoShows(tx: Tx, practice: { id: string; timezone: string }) {
  const today = todayLocal(practice.timezone);
  const { start } = dayRange(today, practice.timezone);
  const stale = await tx.appointment.findMany({
    where: {
      start: { lt: start, gte: dayRange(addDays(today, -14), practice.timezone).start },
      status: { in: ["BOOKED", "CONFIRMED"] },
    },
  });
  for (const a of stale) await systemTransition(tx, a, "no-show", "No arrival by end of day");
  return { marked: stale.length };
}

/** Waitlist offers that were not accepted in time go back to active. */
export async function expireWaitlistOffers(tx: Tx, now = new Date()) {
  const r = await tx.waitlistEntry.updateMany({
    where: { status: "OFFERED", offerExpiresAt: { lt: now } },
    data: { status: "ACTIVE", offeredSlotStart: null, offerExpiresAt: null },
  });
  return { expired: r.count };
}
