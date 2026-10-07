// S0 identity invariants: INV-ID-02 (duplicate search before create), INV-ID-04 (reversible merge), INV-SEC-03.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { call, closeApp, signIn, stepUp, unique } from "./helpers.mjs";

let frontdesk, manager, provider;
before(async () => {
  frontdesk = await signIn("frontdesk@example.com");
  manager = await signIn("manager@example.com");
  provider = await signIn("provider@example.com");
});
after(closeApp);

const newPatient = (first, last, dob, phone, extra = {}) => ({
  patient: { firstName: first, lastName: last, birthDate: dob, administrativeGender: "FEMALE", ...extra },
  contactPoints: phone ? [{ patientId: "00000000-0000-0000-0000-000000000000", system: "PHONE", use: "MOBILE", value: phone }] : [],
});

test("INV-ID-02: duplicate check finds an existing patient by name + DOB + phone", async () => {
  const r = await call("POST", "/patients/duplicate-check", { token: frontdesk, body: { firstName: "Maria", lastName: "Gonzalez", birthDate: "1968-03-14", phone: "+13125550142" } });
  assert.equal(r.status, 200);
  assert.ok(r.body.candidates.length >= 1);
  assert.equal(r.body.blocking, true);
  assert.ok(r.body.candidates[0].matchedOn.includes("dob"));
  assert.ok(r.body.candidates[0].matchedOn.includes("phone"));
});

test("INV-ID-02: createPatient with an existing DOB + name is refused with the possible duplicates", async () => {
  const r = await call("POST", "/patients", { token: frontdesk, body: newPatient("Maria", "Gonzalez", "1968-03-14", "312-555-0142") });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "duplicate");
  assert.ok(r.body.candidates.length >= 1);
});

test("INV-ID-02: 'not the same person' with a reason creates the patient and queues the pair for review", async () => {
  const r = await call("POST", "/patients", { token: frontdesk, body: { ...newPatient("Maria", "Gonzalez", "1968-03-14", null), duplicateOverrideReason: "Different person: confirmed different SSN and address" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.mrn, /^\d{3}-\d{3}-\d{2}$/);
  const list = await call("GET", "/duplicate-candidates", { token: manager });
  assert.ok(list.body.data.some((c) => c.a.id === r.body.id || c.b.id === r.body.id));
});

test("search is fuzzy, matches DOB and phone, and returns DOB on every row (INV-ID-01)", async () => {
  const byName = await call("GET", "/patients?q=gonzales", { token: frontdesk });
  assert.equal(byName.status, 200);
  assert.ok(byName.body.data.length >= 2);
  for (const row of byName.body.data) assert.match(row.birthDate, /^\d{4}-\d{2}-\d{2}$/);
  const byPhone = await call("GET", "/patients?phone=3125550187", { token: frontdesk });
  assert.equal(byPhone.body.data[0].name, "Lee, Michael");
  assert.equal(byPhone.body.data[0].phoneMasked, "•••-•••-0187");
  const byDob = await call("GET", "/patients?q=11/02/1979", { token: frontdesk });
  assert.ok(byDob.body.data.some((p) => p.name === "Lee, Michael"));
});

test("contact values are encrypted at rest and searchable through the blind index", async () => {
  const created = await call("POST", "/patients", { token: frontdesk, body: newPatient(unique("Enc"), unique("Tester"), "2001-01-01", "312-555-0999") });
  assert.equal(created.status, 201);
  assert.equal(created.body.contactPoints[0].value, "312-555-0999");
  const { asTenantOf } = await import("./helpers.mjs");
  const raw = await asTenantOf("frontdesk@example.com", (tx) => tx.patientContactPoint.findFirst({ where: { patientId: created.body.id } }));
  assert.match(raw.value, /^v1:/);
  assert.ok(raw.valueIndex);
});

test("INV-ID-04: merge is reversible and audited; records are never deleted", async () => {
  const a = await call("POST", "/patients", { token: frontdesk, body: newPatient("Merge", unique("Alpha"), "1990-05-05", null) });
  const b = await call("POST", "/patients", { token: frontdesk, body: { ...newPatient("Merge", a.body.lastName, "1990-05-05", null), duplicateOverrideReason: "test: create the duplicate" } });
  assert.equal(b.status, 201);
  await call("POST", `/patients/${b.body.id}/related-persons`, { token: frontdesk, body: { patientId: b.body.id, relationship: "ECON", firstName: "Pat", lastName: "Contact", isEmergencyContact: true, phone: "312-555-0111" } });
  const cands = await call("GET", "/duplicate-candidates", { token: manager });
  const cand = cands.body.data.find((c) => [c.a.id, c.b.id].includes(b.body.id));
  assert.ok(cand);
  const noStepUp = await call("POST", `/duplicate-candidates/${cand.id}/merge`, { token: manager, body: { survivorId: a.body.id, mergedId: b.body.id, fieldChoices: [], reason: "same person", version: a.body.version } });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.body.code, "step_up_required");
  await stepUp(manager);
  const merged = await call("POST", `/duplicate-candidates/${cand.id}/merge`, { token: manager, body: { survivorId: a.body.id, mergedId: b.body.id, fieldChoices: [], reason: "same person", version: a.body.version } });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  const gone = await call("GET", `/patients/${b.body.id}`, { token: frontdesk });
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, "merged");
  assert.equal(gone.body.survivorId, a.body.id);
  const survivorRelated = await call("GET", `/patients/${a.body.id}/related-persons`, { token: frontdesk });
  assert.equal(survivorRelated.body.length, 1);
  const undone = await call("POST", `/patient-merges/${merged.body.id}/unmerge`, { token: manager });
  assert.equal(undone.status, 200);
  assert.ok(undone.body.unmergedAt);
  const back = await call("GET", `/patients/${b.body.id}/related-persons`, { token: frontdesk });
  assert.equal(back.body.length, 1);
  assert.equal((await call("GET", `/patients/${b.body.id}`, { token: frontdesk })).status, 200);
  const log = await call("GET", `/audit-events?action=MERGE&patientId=${a.body.id}`, { token: manager });
  assert.ok(log.body.data.length >= 2);
});

test("INV-SEC-03: restricted record needs break-the-glass with a reason; banner still renders", async () => {
  const p = await call("POST", "/patients", { token: frontdesk, body: newPatient("Vip", unique("Restricted"), "1977-07-07", null, { securityLabels: ["VIP"] }) });
  assert.equal(p.status, 201);
  const denied = await call("GET", `/patients/${p.body.id}`, { token: provider });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "restricted_record");
  const banner = await call("GET", `/patients/${p.body.id}/banner`, { token: provider });
  assert.equal(banner.status, 200);
  assert.equal(banner.body.restricted, true);
  const short = await call("POST", `/patients/${p.body.id}/emergency-access`, { token: provider, body: { reason: "x", reasonCategory: "emergency", durationMinutes: 30 } });
  assert.equal(short.status, 422);
  const grant = await call("POST", `/patients/${p.body.id}/emergency-access`, { token: provider, body: { reason: "Patient unresponsive in clinic; need allergy history", reasonCategory: "emergency", durationMinutes: 30 } });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const allowed = await call("GET", `/patients/${p.body.id}`, { token: provider });
  assert.equal(allowed.status, 200);
  const review = await call("GET", "/emergency-access?reviewOutcome=PENDING_REVIEW", { token: manager });
  assert.ok(review.body.data.some((g) => g.id === grant.body.id));
});
