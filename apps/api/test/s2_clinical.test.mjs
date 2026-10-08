// S2: clinical core. INV-ID-03 (sign compares patient context), INV-SAFE-01 (only sign roles sign), INV-SAFE-02
// (signed notes are immutable; addenda), INV-SAFE-08 (pre-flight blockers), INV-DATA-01 (staged items need a
// reconcile action), INV-DATA-02 (AI text must be accepted before signing), plus vitals, co-sign and the visit flow.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, newPatientBody, signIn, stepUp, unique } from "./helpers.mjs";

let fd, ma, provider, np, manager, rao, kim, location;
before(async () => {
  [fd, ma, provider, np, manager] = await Promise.all(
    ["frontdesk", "ma", "provider", "np", "manager"].map((u) => signIn(`${u}@example.com`)),
  );
  const practitioners = (await call("GET", "/practitioners", { token: fd })).body;
  rao = practitioners.find((p) => p.credential === "MD");
  kim = practitioners.find((p) => p.credential === "NP");
  location = (await call("GET", "/locations", { token: fd })).body.find(
    (l) => l.placeOfService === "11",
  );
  await stepUp(provider);
  await stepUp(np);
});
after(closeApp);

const newPatient = async () => {
  const r = await call("POST", "/patients", { token: fd, body: newPatientBody() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

/** Unscheduled encounter (phone/walk-in) for a fresh patient, with its note. */
async function encounterFor(patient, practitioner = rao, token = provider) {
  const enc = await call("POST", `/patients/${patient.id}/encounters`, {
    token,
    body: {
      patientId: patient.id,
      class: "AMB",
      practitionerId: practitioner.id,
      locationId: location.id,
      reason: "Cough for 5 days",
    },
  });
  assert.equal(enc.status, 201, JSON.stringify(enc.body));
  const note = await call("GET", `/encounters/${enc.body.id}/note`, { token });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  return { enc: enc.body, note: note.body };
}

async function addDx(encId, code = "J01.90", token = provider) {
  const r = await call("POST", `/encounters/${encId}/diagnoses`, {
    token,
    body: { icd10Code: code },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const save = (encId, version, sections, token = provider) =>
  call("PUT", `/encounters/${encId}/note/sections`, { token, body: { version, sections } });

const sign = (note, patientId, token = provider) =>
  call("POST", `/notes/${note.id}/sign`, {
    token,
    body: { version: note.version, patientId, attest: true },
  });

test("INV-SAFE-01: an MA can document but cannot sign, co-sign or add addenda (403)", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p);
  const saved = await save(enc.id, note.version, [{ key: "hpi", text: "Scribed by MA." }], ma);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  for (const [path, body] of [
    [`/notes/${note.id}/sign`, { version: saved.body.version, patientId: p.id, attest: true }],
    [`/notes/${note.id}/cosign`, { version: saved.body.version, patientId: p.id, attest: true }],
    [`/notes/${note.id}/addenda`, { text: "x", reason: "y" }],
  ]) {
    const r = await call("POST", path, { token: ma, body });
    assert.equal(r.status, 403, `${path} ${JSON.stringify(r.body)}`);
  }
  const preflight = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: ma });
  assert.equal(preflight.status, 403);
});

test("INV-ID-03: signing with a different patient in context is refused (409)", async () => {
  const p = await newPatient();
  const other = await newPatient();
  const { enc, note } = await encounterFor(p);
  await addDx(enc.id);
  const r = await sign(note, other.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "patient_context_mismatch");
  const missing = await call("POST", `/notes/${note.id}/sign`, {
    token: provider,
    body: { version: note.version, attest: true },
  });
  assert.ok([409, 422].includes(missing.status));
});

test("INV-SAFE-02: a signed note is immutable; changes are addenda with author and time", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p);
  const dx = await addDx(enc.id);
  const saved = await save(enc.id, note.version, [
    { key: "hpi", text: "Five days of congestion." },
    { key: `ap:${dx.id}`, text: "Saline irrigation." },
  ]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const signed = await sign(saved.body, p.id);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.note.status, "SIGNED");
  assert.ok(signed.body.avsId, "an AVS is generated at signing");
  const edit = await save(enc.id, saved.body.version + 1, [{ key: "hpi", text: "changed" }]);
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "note_signed");
  const again = await call("POST", `/notes/${note.id}/sign`, {
    token: provider,
    body: { version: saved.body.version + 1, patientId: p.id, attest: true },
  });
  assert.equal(again.status, 409);
  const dxEdit = await call("POST", `/encounters/${enc.id}/diagnoses`, {
    token: provider,
    body: { icd10Code: "R05.9" },
  });
  assert.equal(dxEdit.status, 409, "visit diagnoses freeze with the note");
  const add = await call("POST", `/notes/${note.id}/addenda`, {
    token: provider,
    body: { text: "Patient called: symptoms improving.", reason: "Follow-up call" },
  });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.ok(add.body.authorId && add.body.signedAt);
  const detail = await call("GET", `/notes/${note.id}`, { token: provider });
  assert.equal(detail.body.status, "ADDENDED");
  assert.equal(detail.body.addenda.length, 1);
  assert.equal(
    detail.body.sections.find((s) => s.key === "hpi").content,
    "Five days of congestion.",
  );
  const draftAddendum = await encounterFor(await newPatient());
  const notSigned = await call("POST", `/notes/${draftAddendum.note.id}/addenda`, {
    token: provider,
    body: { text: "x", reason: "y" },
  });
  assert.equal(notSigned.status, 409);
});

test("signing needs a recent step-up (403 step_up_required) unless the practice turns it off", async () => {
  const fresh = await signIn("provider@example.com");
  const p = await newPatient();
  const { enc, note } = await encounterFor(p, rao, fresh);
  await addDx(enc.id, "J01.90", fresh);
  const r = await sign(note, p.id, fresh);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "step_up_required");
  await stepUp(fresh);
  const ok = await sign(note, p.id, fresh);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("INV-SAFE-08: pre-flight lists unsigned Rx, orders without a diagnosis and charges without a pointer; sign is blocked", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p);
  await addDx(enc.id);
  await asTenantOf("provider@example.com", async (tx) => {
    await tx.medicationRequest.create({
      data: {
        practiceId: enc.practiceId,
        patientId: p.id,
        encounterId: enc.id,
        prescriberId: rao.id,
        rxnormCode: "308182",
        display: "Amoxicillin 500 mg capsule",
        sigText: "1 cap three times daily",
        quantity: 30,
        quantityUnit: "capsule",
      },
    });
    await tx.serviceRequest.create({
      data: {
        practiceId: enc.practiceId,
        patientId: p.id,
        encounterId: enc.id,
        category: "LAB",
        codeSystem: "LOINC",
        code: "24331-1",
        display: "Lipid panel",
      },
    });
    await tx.chargeItem.create({
      data: {
        practiceId: enc.practiceId,
        patientId: p.id,
        encounterId: enc.id,
        codeSystem: "CPT",
        code: "99213",
        description: "Office visit",
        fee: 120,
        serviceDate: new Date(),
        renderingPractitionerId: rao.id,
      },
    });
  });
  const pre = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: provider });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.canSign, false);
  const codes = pre.body.blockers.map((b) => b.code).sort();
  assert.deepEqual(codes, ["charge_without_pointer", "order_without_dx", "unsigned_rx"]);
  assert.ok(
    pre.body.blockers.every((b) => b.text.length > 10),
    "each blocker says what to fix",
  );
  const r = await sign(note, p.id);
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "invariant_blocked");
  assert.equal(r.body.blockers.length, 3);
  assert.ok(r.body.blockers.every((b) => b.invariant === "INV-SAFE-08"));
});

test("INV-DATA-02: unaccepted AI text blocks signing until the author accepts, edits or discards it", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p);
  await addDx(enc.id);
  const saved = await save(enc.id, note.version, [{ key: "hpi", text: "Seen today." }]);
  const segId = await asTenantOf("provider@example.com", async (tx) => {
    const section = await tx.noteSection.findFirst({ where: { noteId: note.id, key: "hpi" } });
    const seg = await tx.aiDraftSegment.create({
      data: {
        practiceId: enc.practiceId,
        sectionId: section.id,
        text: "Reports facial pressure for 10 days.",
        model: "test-fixture",
      },
    });
    return seg.id;
  });
  const pre = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: provider });
  assert.deepEqual(
    pre.body.blockers.map((b) => [b.code, b.sectionKey]),
    [["ai_text_unaccepted", "hpi"]],
  );
  const blocked = await sign(saved.body, p.id);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.blockers[0].invariant, "INV-DATA-02");
  const maDecides = await call("POST", `/ai-segments/${segId}/decision`, {
    token: ma,
    body: { decision: "accept", version: saved.body.version },
  });
  assert.equal(maDecides.status, 403);
  const accept = await call("POST", `/ai-segments/${segId}/decision`, {
    token: provider,
    body: { decision: "accept", version: saved.body.version },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.status, "ACCEPTED");
  const after = await call("GET", `/encounters/${enc.id}/note`, { token: provider });
  assert.match(
    after.body.sections.find((s) => s.key === "hpi").content,
    /Seen today\.\nReports facial pressure/,
  );
  const ok = await sign(after.body, p.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("INV-DATA-01: staged medications stay out of the active list until a staff reconcile action", async () => {
  const p = await newPatient();
  const staged = await asTenantOf("ma@example.com", async (tx) => {
    const { practiceId } = await tx.patient.findUnique({ where: { id: p.id } });
    return tx.medicationStatement.create({
      data: {
        practiceId,
        patientId: p.id,
        display: "Lipitor 40 mg tablet",
        rxnormCode: "617320",
        stagingStatus: "STAGED",
        source: "PATIENT_REPORTED",
      },
    });
  });
  const active = await call("GET", `/patients/${p.id}/medication-statements`, { token: ma });
  assert.equal(active.status, 200);
  assert.ok(!active.body.some((m) => m.id === staged.id), "staged item not in the active list");
  const incoming = await call(
    "GET",
    `/patients/${p.id}/medication-statements?stagingStatus=STAGED`,
    { token: ma },
  );
  assert.ok(incoming.body.some((m) => m.id === staged.id));
  const markReviewed = await call("POST", `/patients/${p.id}/medication-reconciliation`, {
    token: ma,
  });
  assert.equal(markReviewed.status, 409);
  assert.equal(markReviewed.body.code, "staged_items_pending");
  const accept = await call("POST", `/medication-statements/${staged.id}/reconcile`, {
    token: ma,
    body: { items: [{ stagedId: staged.id, action: "accept" }], reviewedComplete: true },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.stagingStatus, "ACTIVE");
  assert.equal(accept.body.source, "PATIENT_REPORTED", "provenance is kept");
  const again = await call("POST", `/medication-statements/${staged.id}/reconcile`, {
    token: ma,
    body: { items: [], reviewedComplete: false },
  });
  assert.equal(again.status, 409);
  const now = await call("GET", `/patients/${p.id}/medication-statements`, { token: ma });
  assert.ok(now.body.some((m) => m.id === staged.id));
  const prov = await asTenantOf("ma@example.com", (tx) =>
    tx.provenanceRecord.findMany({ where: { targetId: staged.id } }),
  );
  assert.ok(prov.some((r) => r.activity === "reconcile-accept"));
});

test("vitals: BMI is computed, out-of-range values alert and both readings are kept; implausible values are refused", async () => {
  const p = await newPatient();
  const { enc } = await encounterFor(p, rao, provider);
  const r = await call("POST", `/encounters/${enc.id}/vitals`, {
    token: ma,
    body: {
      systolic: 168,
      diastolic: 102,
      heartRate: 84,
      temperature: 99.1,
      temperatureUnit: "degf",
      spo2: 97,
      heightCm: 162.6,
      weightKg: 82.6,
      painScore: 4,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bmi, 31.2);
  assert.deepEqual(r.body.alerts, ["BP 168/102 is above the alert range (160/100)."]);
  const repeat = await call("POST", `/encounters/${enc.id}/vitals`, {
    token: ma,
    body: { systolic: 158, diastolic: 96 },
  });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body.alerts, []);
  const trend = await call("GET", `/patients/${p.id}/observations/trend?loinc=8480-6`, {
    token: ma,
  });
  assert.deepEqual(
    trend.body.points.map((x) => x.value),
    [168, 158],
  );
  const bad = await call("POST", `/encounters/${enc.id}/vitals`, {
    token: ma,
    body: { systolic: 1680, diastolic: 102 },
  });
  assert.equal(bad.status, 422);
  const half = await call("POST", `/encounters/${enc.id}/vitals`, {
    token: ma,
    body: { systolic: 120 },
  });
  assert.equal(half.status, 422);
});

test("co-sign rule: a supervised NP's note for a new patient routes to the supervisor, who alone can co-sign", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p, kim, np);
  await addDx(enc.id, "J01.90", np);
  const pre = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: np });
  assert.equal(pre.body.requiresCosign, true);
  assert.match(pre.body.cosigner.name, /Rao/);
  const signed = await sign(note, p.id, np);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.note.status, "PENDING_COSIGN");
  const queue = await call("GET", "/inbox/cosign", { token: provider });
  assert.ok(queue.body.data.some((i) => i.note.id === note.id));
  const self = await call("POST", `/notes/${note.id}/cosign`, {
    token: np,
    body: { version: note.version + 1, patientId: p.id, attest: true },
  });
  assert.equal(self.status, 403);
  const co = await call("POST", `/notes/${note.id}/cosign`, {
    token: provider,
    body: { version: note.version + 1, patientId: p.id, attest: true },
  });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal(co.body.note.status, "SIGNED");
});

test("edit lock: a second user cannot save while the first holds the note", async () => {
  const p = await newPatient();
  const { enc, note } = await encounterFor(p);
  const lock = await call("POST", `/notes/${note.id}/lock`, { token: provider });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  const other = await save(enc.id, note.version, [{ key: "hpi", text: "MA edit" }], ma);
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "note_locked");
  const mine = await save(enc.id, note.version, [{ key: "hpi", text: "Provider edit" }]);
  assert.equal(mine.status, 200);
  const stale = await save(enc.id, note.version, [{ key: "hpi", text: "stale" }]);
  assert.equal(stale.status, 412, "an old version is refused");
  await call("DELETE", `/notes/${note.id}/lock`, { token: provider });
  const nowMa = await save(enc.id, mine.body.version, [{ key: "ros", text: "Negative." }], ma);
  assert.equal(nowMa.status, 200);
});

test("problems and allergies: duplicates refused, NKA cannot coexist with active allergies, banner refreshes", async () => {
  const p = await newPatient();
  const c = await call("POST", `/patients/${p.id}/conditions`, {
    token: provider,
    body: {
      patientId: p.id,
      category: "PROBLEM_LIST_ITEM",
      icd10Code: "I10",
      display: "Essential (primary) hypertension",
    },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.display, "Essential (primary) hypertension");
  const dup = await call("POST", `/patients/${p.id}/conditions`, {
    token: provider,
    body: {
      patientId: p.id,
      category: "PROBLEM_LIST_ITEM",
      icd10Code: "I10",
      display: "Essential (primary) hypertension",
    },
  });
  assert.equal(dup.status, 409);
  const bad = await call("POST", `/patients/${p.id}/conditions`, {
    token: provider,
    body: { patientId: p.id, category: "PROBLEM_LIST_ITEM", icd10Code: "ZZZ.9", display: "x" },
  });
  assert.equal(bad.status, 422);
  const fdCannot = await call("POST", `/patients/${p.id}/conditions`, {
    token: fd,
    body: {
      patientId: p.id,
      category: "PROBLEM_LIST_ITEM",
      icd10Code: "E11.9",
      display: "Type 2 diabetes mellitus without complications",
    },
  });
  assert.equal(fdCannot.status, 403);
  const al = await call("POST", `/patients/${p.id}/allergies`, {
    token: ma,
    body: {
      patientId: p.id,
      substanceSystem: "SNOMEDCT",
      substanceCode: "762952008",
      substanceDisplay: "Peanut",
      category: "FOOD",
      criticality: "HIGH",
      reactions: { items: [{ manifestation: "Anaphylaxis", severity: "severe" }] },
    },
  });
  assert.equal(al.status, 201, JSON.stringify(al.body));
  const banner = await call("GET", `/patients/${p.id}/banner`, { token: fd });
  assert.deepEqual(
    banner.body.allergies.map((a) => a.display),
    ["Peanut"],
  );
  const nka = await call("POST", `/patients/${p.id}/allergies/review`, {
    token: ma,
    body: { noKnownAllergies: true, reviewedAt: new Date().toISOString() },
  });
  assert.equal(nka.status, 409);
  const resolved = await call("PATCH", `/conditions/${c.body.id}`, {
    token: provider,
    body: { clinicalStatus: "RESOLVED" },
    headers: { "if-match": `"${c.body.version}"` },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.ok(resolved.body.abatementDate);
  const list = await call("GET", `/patients/${p.id}/conditions?category=PROBLEM_LIST_ITEM`, {
    token: provider,
  });
  assert.equal(list.body.length, 0, "resolved problems are hidden by default");
});

test("vaccines: an expired lot is refused; a good lot records the dose and decrements stock", async () => {
  const p = await newPatient();
  const { enc } = await encounterFor(p);
  // Own lots, so repeated runs never drain the seeded inventory.
  const mkLot = async (lotNumber, expirationDate, quantityOnHand) => {
    const r = await call("POST", "/vaccine-lots", {
      token: ma,
      body: {
        locationId: location.id,
        cvxCode: "187",
        lotNumber,
        expirationDate,
        quantityOnHand,
        fundingSource: "private",
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const expired = await mkLot(unique("EXP"), "2026-01-31", 3);
  const good = await mkLot(unique("ZS"), "2030-12-31", 2);
  const body = (lot) => ({
    cvx: "187",
    vaccineLotId: lot.id,
    route: "IM",
    site: "Left deltoid",
    doseQuantity: 0.5,
    administeredAt: new Date().toISOString(),
    visGivenDate: new Date().toISOString().slice(0, 10),
    visEditionDate: "2023-02-01",
    fundingSource: "private",
    orderedById: rao.id,
    reportToIis: false,
  });
  const r1 = await call("POST", `/encounters/${enc.id}/immunizations`, {
    token: ma,
    body: body(expired),
  });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, "lot_expired");
  const r2 = await call("POST", `/encounters/${enc.id}/immunizations`, {
    token: ma,
    body: body(good),
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.lotNumber, good.lotNumber);
  const after = (await call("GET", "/vaccine-lots?cvx=187", { token: ma })).body.find(
    (l) => l.id === good.id,
  );
  assert.equal(after.quantityOnHand, good.quantityOnHand - 1);
  const registry = await call("POST", `/encounters/${enc.id}/immunizations`, {
    token: ma,
    body: { ...body(good), reportToIis: true },
  });
  assert.equal(registry.status, 422, "the state registry is not connected yet");
});

test("questionnaires are scored by the server; unanswered required items are refused", async () => {
  const p = await newPatient();
  const qns = (await call("GET", "/questionnaires", { token: ma })).body;
  const phq9 = qns.find((q) => q.loincCode === "44249-1");
  const answers = Object.fromEntries(phq9.items.map((i, n) => [i.linkId, n < 5 ? "2" : "0"]));
  const r = await call("POST", `/patients/${p.id}/questionnaire-responses`, {
    token: ma,
    body: { questionnaireId: phq9.id, patientId: p.id, answers },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Number(r.body.score), 10);
  const partial = await call("POST", `/patients/${p.id}/questionnaire-responses`, {
    token: ma,
    body: { questionnaireId: phq9.id, patientId: p.id, answers: { phq1: "1" } },
  });
  assert.equal(partial.status, 422);
});

test("restricted notes are hidden from the chart and counted, never shown (INV-SEC-03)", async () => {
  const p = await newPatient();
  const { enc } = await encounterFor(p);
  await asTenantOf("provider@example.com", (tx) =>
    tx.clinicalNote.updateMany({
      where: { encounterId: enc.id },
      data: { securityLabels: ["R"], status: "SIGNED", signedAt: new Date() },
    }),
  );
  const notes = await call("GET", `/patients/${p.id}/notes`, { token: provider });
  assert.equal(notes.body.data.length, 0);
  const summary = await call("GET", `/patients/${p.id}/summary`, { token: provider });
  assert.equal(summary.body.restrictedHidden, 1);
  const noteId = (
    await asTenantOf("provider@example.com", (tx) =>
      tx.clinicalNote.findFirst({ where: { encounterId: enc.id } }),
    )
  ).id;
  const direct = await call("GET", `/notes/${noteId}`, { token: provider });
  assert.equal(direct.status, 403);
});

test("flow: room -> vitals -> ready -> start -> document -> sign moves the visit to checkout; AVS releases; checkout completes", async () => {
  const room = await call("POST", `/locations/${location.id}/rooms`, {
    token: manager,
    body: { locationId: location.id, name: unique("Exam ") },
  });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  // Book our own visit later today (overbook: the demo day's slots may be used up by earlier runs).
  const patient = await newPatient();
  const visitType = (await call("GET", "/visit-types", { token: fd })).body.find(
    (v) => v.name === "Follow-up",
  );
  const start = new Date(Math.ceil((Date.now() + 30 * 60_000) / 600_000) * 600_000).toISOString();
  const booked = await call("POST", "/appointments", {
    token: fd,
    body: {
      patientId: patient.id,
      visitTypeId: visitType.id,
      practitionerId: rao.id,
      locationId: location.id,
      start,
      modality: "IN_PERSON",
      overbookReason: "Test visit",
      sendConfirmation: false,
    },
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const appt = booked.body;
  const arrived = await call("POST", `/appointments/${appt.id}/arrive`, {
    token: fd,
    body: {
      version: appt.version,
      identityVerified: true,
      coverageVerified: true,
      consentsSigned: ["NOTICE_OF_PRIVACY_PRACTICES", "FINANCIAL_POLICY"],
    },
  });
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  const roomed = await call("POST", `/appointments/${appt.id}/room`, {
    token: ma,
    body: { roomId: room.body.id, version: arrived.body.appointment.version },
  });
  assert.equal(roomed.status, 200, JSON.stringify(roomed.body));
  const encId = roomed.body.id;
  const daylist = await call("GET", "/workspace/clinical", { token: ma });
  assert.ok(daylist.body.rows.some((r) => r.appointment.id === appt.id && r.encounterId === encId));
  assert.equal(
    (
      await call("POST", `/encounters/${encId}/vitals`, {
        token: ma,
        body: { systolic: 128, diastolic: 82, heartRate: 72 },
      })
    ).status,
    200,
  );
  const rooming = await call("GET", `/encounters/${encId}/rooming`, { token: ma });
  assert.equal(rooming.status, 200, JSON.stringify(rooming.body));
  assert.equal(rooming.body.checklist.find((c) => c.key === "vitals").done, true);
  const cur = (await call("GET", `/appointments/${appt.id}`, { token: ma })).body.appointment;
  const ready = await call("POST", `/appointments/${appt.id}/ready`, {
    token: ma,
    body: { to: "ready-for-provider", version: cur.version },
  });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  const worklist = await call("GET", "/workspace/provider", { token: provider });
  assert.equal(worklist.status, 200, JSON.stringify(worklist.body));
  const row = worklist.body.readiness.find((r) => r.appointmentId === appt.id);
  assert.equal(row.vitalsDone, true);
  const started = await call("POST", `/appointments/${appt.id}/start`, {
    token: provider,
    body: { to: "with-provider", version: ready.body.version },
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const note = (await call("GET", `/encounters/${encId}/note`, { token: provider })).body;
  const dx = await addDx(encId, "I10");
  const saved = await save(encId, note.version, [
    { key: "hpi", text: "BP follow-up." },
    { key: `ap:${dx.id}`, text: "Continue current therapy." },
  ]);
  const followUp = await call("PATCH", `/encounters/${encId}`, {
    token: provider,
    body: { followUpInstruction: "Return in 3 months" },
    headers: {
      "if-match": `"${(await call("GET", `/encounters/${encId}`, { token: provider })).body.version}"`,
    },
  });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  const signed = await sign(saved.body, appt.patient.id);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const apptNow = (await call("GET", `/appointments/${appt.id}`, { token: fd })).body.appointment;
  assert.equal(apptNow.status, "CHECKOUT");
  const checkout = await call("GET", `/appointments/${appt.id}/checkout`, { token: fd });
  assert.equal(checkout.status, 200);
  assert.deepEqual(checkout.body.followUps, [{ text: "Return in 3 months" }]);
  assert.deepEqual(checkout.body.avs.content.diagnoses, ["Essential (primary) hypertension"]);
  const released = await call("POST", `/encounters/${encId}/avs/release`, { token: fd });
  assert.equal(released.status, 200);
  assert.ok(released.body.releasedAt);
  const pdf = await call("GET", `/encounters/${encId}/avs/pdf`, { token: fd });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  const done = await call("POST", `/appointments/${appt.id}/complete`, {
    token: fd,
    body: { version: apptNow.version },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "COMPLETED");
});

test("concurrent first opens of a note create exactly one draft", async () => {
  const p = await newPatient();
  const enc = await call("POST", `/patients/${p.id}/encounters`, {
    token: provider,
    body: {
      patientId: p.id,
      class: "AMB",
      practitionerId: rao.id,
      locationId: location.id,
      reason: "Race check",
    },
  });
  assert.equal(enc.status, 201, JSON.stringify(enc.body));
  const opens = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      i % 2
        ? call("GET", `/encounters/${enc.body.id}/note`, { token: provider })
        : call("GET", `/encounters/${enc.body.id}/sign-preflight`, { token: provider }),
    ),
  );
  assert.ok(
    opens.every((r) => r.status === 200),
    JSON.stringify(opens.map((r) => r.status)),
  );
  const notes = await asTenantOf("provider@example.com", (tx) =>
    tx.clinicalNote.count({ where: { encounterId: enc.body.id } }),
  );
  assert.equal(notes, 1);
});
