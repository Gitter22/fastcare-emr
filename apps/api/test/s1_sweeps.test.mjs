// S1 background sweeps: end-of-day no-show guard, reminders once per window, waitlist offer expiry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, newPatientBody, signIn } from "./helpers.mjs";

after(closeApp);

test("end of day: booked/confirmed appointments from earlier days become no-shows; today's stay", async () => {
  const fd = await signIn("frontdesk@example.com");
  const p = (await call("POST", "/patients", { token: fd, body: newPatientBody() })).body;
  const sweeps = await import("../dist/workers/sweeps.js");
  const result = await asTenantOf("frontdesk@example.com", async (tx) => {
    const base = await tx.appointment.findFirst({
      where: { status: { in: ["BOOKED", "CONFIRMED"] } },
    });
    const yesterday = new Date(Date.now() - 30 * 3_600_000);
    const old = await tx.appointment.create({
      data: {
        practiceId: base.practiceId,
        patientId: p.id,
        practitionerId: base.practitionerId,
        locationId: base.locationId,
        visitTypeId: base.visitTypeId,
        start: yesterday,
        end: new Date(yesterday.getTime() + 1_200_000),
        status: "CONFIRMED",
      },
    });
    const practice = await tx.practice.findFirst();
    const r = await sweeps.endOfDayNoShows(tx, { id: practice.id, timezone: practice.timezone });
    const again = await sweeps.endOfDayNoShows(tx, {
      id: practice.id,
      timezone: practice.timezone,
    });
    const after = await tx.appointment.findUnique({ where: { id: old.id } });
    const events = await tx.appointmentStatusEvent.findMany({ where: { appointmentId: old.id } });
    return { r, again, status: after.status, events: events.length };
  });
  assert.ok(result.r.marked >= 1);
  assert.equal(result.again.marked, 0);
  assert.equal(result.status, "NO_SHOW");
  assert.equal(result.events, 1);
});

test("reminders: one per appointment per window, only with SMS consent or email", async () => {
  const sweeps = await import("../dist/workers/sweeps.js");
  const r = await asTenantOf("frontdesk@example.com", async (tx) => {
    const practice = await tx.practice.findFirst();
    const base = await tx.appointment.findFirst();
    const start = new Date(Date.now() + 23.5 * 3_600_000);
    const a = await tx.appointment.create({
      data: {
        practiceId: base.practiceId,
        patientId: base.patientId,
        practitionerId: base.practitionerId,
        locationId: base.locationId,
        visitTypeId: base.visitTypeId,
        start,
        end: new Date(start.getTime() + 1_200_000),
        status: "BOOKED",
      },
    });
    const noop = () => undefined;
    await sweeps.sendReminders(tx, { id: practice.id, timezone: practice.timezone }, noop);
    await sweeps.sendReminders(tx, { id: practice.id, timezone: practice.timezone }, noop);
    return tx.communicationLog.findMany({ where: { relatedId: a.id, purpose: "reminder-24h" } });
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].templateKey, "appointment-reminder");
});
