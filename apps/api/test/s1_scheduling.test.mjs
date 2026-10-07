// S1: booking, check-in and the ledger. INV-FIN-01 (append-only ledger), INV-FIN-02 (derived balances),
// states.yaml#appointment transitions, flow:access/03 eligibility work items.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, newPatientBody, signIn, unique } from "./helpers.mjs";

let fd, ma, provider, manager, patient, visitTypes, practitioners, location;
before(async () => {
  [fd, ma, provider, manager] = await Promise.all(["frontdesk", "ma", "provider", "manager"].map((u) => signIn(`${u}@example.com`)));
  visitTypes = (await call("GET", "/visit-types", { token: fd })).body;
  practitioners = (await call("GET", "/practitioners", { token: fd })).body;
  location = (await call("GET", "/locations", { token: fd })).body.find((l) => l.placeOfService === "11");
  const payerId = (await call("GET", "/payers", { token: fd })).body[0].id;
  const created = await call("POST", "/patients", { token: fd, body: newPatientBody({ coverages: [{ patientId: "00000000-0000-0000-0000-000000000000", payerId, memberId: "W000111222" }] }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  patient = created.body;
});
after(closeApp);

const followUp = () => visitTypes.find((v) => v.name === "Follow-up");

async function firstSlot(fromDate) {
  const r = await call("GET", `/availability?visitTypeId=${followUp().id}&practitionerId=${practitioners[0].id}${fromDate ? `&fromDate=${fromDate}` : ""}`, { token: fd });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.slots.length, "expected open slots");
  return r.body.slots[0];
}

const book = (slot, extra = {}) =>
  call("POST", "/appointments", { token: fd, body: { patientId: patient.id, visitTypeId: followUp().id, practitionerId: slot.practitionerId, locationId: slot.locationId, start: slot.start, modality: "IN_PERSON", ...extra } });

test("slot finder respects templates; booking takes the slot; a second booking for it is refused", async () => {
  const slot = await firstSlot();
  const a = await book(slot);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.status, "BOOKED");
  const again = await book(slot);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "slot_unavailable");
  const overbook = await book(slot, { overbookReason: "Urgent: provider approved" });
  assert.equal(overbook.status, 201);
  const after = await call("GET", `/availability?visitTypeId=${followUp().id}&practitionerId=${slot.practitionerId}&fromDate=${slot.start.slice(0, 10)}&toDate=${slot.start.slice(0, 10)}`, { token: fd });
  assert.ok(!after.body.slots.some((s) => s.start === slot.start));
});

test("a time outside the provider's template is not bookable without an overbook reason", async () => {
  const r = await call("POST", "/appointments", { token: fd, body: { patientId: patient.id, visitTypeId: followUp().id, practitionerId: practitioners[0].id, locationId: location.id, start: "2030-01-05T03:00:00Z", modality: "IN_PERSON" } });
  assert.equal(r.status, 409);
});

test("states.yaml: transitions not listed are refused (409), and roles must match `by`", async () => {
  const slot = await firstSlot();
  const a = (await book(slot)).body;
  const room = await call("POST", `/appointments/${a.id}/room`, { token: ma, body: { roomId: "00000000-0000-0000-0000-000000000000", version: a.version } });
  assert.ok([409, 422].includes(room.status));
  const complete = await call("POST", `/appointments/${a.id}/complete`, { token: fd, body: { version: a.version } });
  assert.equal(complete.status, 409);
  assert.equal(complete.body.code, "invalid_transition");
  const confirmByProvider = await call("POST", `/appointments/${a.id}/confirm`, { token: provider, body: { to: "confirmed", version: a.version } });
  assert.equal(confirmByProvider.status, 403);
});

test("check-in flow: arrive with copay posts payment to an append-only ledger; balance is derived (INV-FIN-01/02)", async () => {
  // Today's demo appointments exist; take one that is booked or confirmed.
  const today = await call("GET", "/workspace/front-desk", { token: fd });
  assert.equal(today.status, 200);
  const appt = today.body.columns.flatMap((c) => c.appointments).find((a) => ["BOOKED", "CONFIRMED"].includes(a.status));
  assert.ok(appt, "a bookable appointment today");
  const before = await call("GET", `/patients/${appt.patient.id}/banner`, { token: fd });
  const noId = await call("POST", `/appointments/${appt.id}/arrive`, { token: fd, body: { version: appt.version, identityVerified: false, coverageVerified: true } });
  assert.equal(noId.status, 422);
  const key = unique("pay");
  const arrived = await call("POST", `/appointments/${appt.id}/arrive`, {
    token: fd,
    body: { version: appt.version, identityVerified: true, coverageVerified: true, consentsSigned: ["FINANCIAL_POLICY"], copayCollected: { amount: "25.00", method: "CARD", hostedFieldsToken: "tok_visa_4242_1229", idempotencyKey: key } },
  });
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.equal(arrived.body.appointment.status, "ARRIVED");
  assert.ok(arrived.body.encounterId);
  const afterBanner = await call("GET", `/patients/${appt.patient.id}/banner`, { token: fd });
  assert.equal(Number(afterBanner.body.balance), Number(before.body.balance) - 25);
  // INV-FIN-02: the balance equals the sum of the ledger, recomputed independently.
  const sum = await asTenantOf("frontdesk@example.com", (tx) => tx.$queryRaw`SELECT coalesce(sum(amount),0)::text AS s FROM "LedgerEntry" WHERE "patientId" = ${appt.patient.id}::uuid AND responsibility = 'PATIENT'`);
  assert.equal(Number(sum[0].s), Number(afterBanner.body.balance));
  // INV-FIN-01: the app role cannot update or delete ledger rows.
  await assert.rejects(asTenantOf("frontdesk@example.com", (tx) => tx.$executeRaw`UPDATE "LedgerEntry" SET amount = 0 WHERE "patientId" = ${appt.patient.id}::uuid`));
  // Rooming opens the encounter for the MA.
  const rooms = (await call("GET", `/locations/${location.id}/rooms`, { token: ma })).body.filter((r) => !r.isVirtual && r.status === "READY");
  const roomed = await call("POST", `/appointments/${appt.id}/room`, { token: ma, body: { roomId: rooms[0].id, version: arrived.body.appointment.version } });
  assert.equal(roomed.status, 200, JSON.stringify(roomed.body));
  assert.equal(roomed.body.status, "IN_PROGRESS");
  assert.equal(roomed.body.patient.id, appt.patient.id);
  const board = await call("GET", "/flow-board", { token: ma });
  assert.ok(board.body.rows.some((r) => r.appointment.id === appt.id && r.stage === "ROOMED"));
});

test("property: for random payment sequences the derived balance always equals charges minus payments (INV-FIN-02)", async () => {
  const p = (await call("POST", "/patients", { token: fd, body: newPatientBody() })).body;
  let expected = 0;
  for (let i = 0; i < 8; i++) {
    const cents = 100 + Math.floor(Math.random() * 5000);
    const r = await call("POST", "/payments", { token: fd, body: { patientId: p.id, amount: (cents / 100).toFixed(2), method: "CASH", idempotencyKey: unique("prop") } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    expected -= cents;
  }
  const banner = await call("GET", `/patients/${p.id}/banner`, { token: fd });
  assert.equal(Math.round(Number(banner.body.balance) * 100), expected);
});

test("a repeated payment idempotency key does not charge twice", async () => {
  const p = (await call("POST", "/patients", { token: fd, body: newPatientBody() })).body;
  const key = unique("same");
  const one = await call("POST", "/payments", { token: fd, body: { patientId: p.id, amount: "10.00", method: "CARD", hostedFieldsToken: "tok_visa_1111", idempotencyKey: key } });
  const two = await call("POST", "/payments", { token: fd, body: { patientId: p.id, amount: "10.00", method: "CARD", hostedFieldsToken: "tok_visa_1111", idempotencyKey: key } });
  assert.equal(one.body.id, two.body.id);
  const banner = await call("GET", `/patients/${p.id}/banner`, { token: fd });
  assert.equal(banner.body.balance, "-10.00");
});

test("declined card: no ledger entry, request fails with payment_declined", async () => {
  const p = (await call("POST", "/patients", { token: fd, body: newPatientBody() })).body;
  const r = await call("POST", "/payments", { token: fd, body: { patientId: p.id, amount: "30.00", method: "CARD", hostedFieldsToken: "tok_decline", idempotencyKey: unique("d") } });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "payment_declined");
  const banner = await call("GET", `/patients/${p.id}/banner`, { token: fd });
  assert.equal(banner.body.balance, "0.00");
});

test("flow:access/03: inactive coverage creates an eligibility work item; active closes it", async () => {
  const p = (await call("POST", "/patients", { token: fd, body: newPatientBody() })).body;
  const payerId = (await call("GET", "/payers", { token: fd })).body[0].id;
  const cov = (await call("POST", `/patients/${p.id}/coverages`, { token: fd, body: { patientId: p.id, payerId, memberId: "ABC-INACTIVE" } })).body;
  const r = await call("POST", `/coverages/${cov.id}/eligibility-checks`, { token: fd, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "INACTIVE");
  const tasks = await asTenantOf("frontdesk@example.com", (tx) => tx.task.findMany({ where: { focusId: cov.id, type: "ELIGIBILITY_FAILURE", status: "OPEN" } }));
  assert.equal(tasks.length, 1);
  await call("PATCH", `/coverages/${cov.id}`, { token: fd, body: { memberId: "ABC-OK" }, headers: { "if-match": `W/"${cov.version}"`, "content-type": "application/merge-patch+json" } });
  const ok = await call("POST", `/coverages/${cov.id}/eligibility-checks`, { token: fd, body: {} });
  assert.equal(ok.body.status, "ACTIVE");
  assert.equal(ok.body.copay, "25.00");
  const open = await asTenantOf("frontdesk@example.com", (tx) => tx.task.count({ where: { focusId: cov.id, type: "ELIGIBILITY_FAILURE", status: "OPEN" } }));
  assert.equal(open, 0);
});

test("INV-SEC-06: every message template is free of clinical detail", async () => {
  const { templateKeys, renderTemplate } = await import("../dist/gateways/messaging/templates.js");
  const clinical = /\b(diagnos|result|lab|test|medication|prescri|rx\b|refill|blood|a1c|glucose|pressure|cancer|hiv|pregnan|mental|depress|biopsy|x-ray|mri|allerg|vaccine|immuniz|dose)/i;
  const sample = { code: "123456", practiceName: "Riverbend Family Medicine", link: "https://example/portal", when: "Wed, Oct 7 at 9:40 AM", minutes: 15, amount: "$25.00" };
  for (const k of templateKeys) {
    const { subject, body } = renderTemplate(k, sample);
    assert.doesNotMatch(`${subject} ${body}`, clinical, `template ${k}`);
  }
});
