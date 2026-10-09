// S4: prescribing. INV-SAFE-01 (only prescribers sign Rx), INV-ID-03 (sign compares the patient on screen),
// INV-SAFE-06 (drug-allergy and severe drug-drug alerts are interruptive; overrides need a stored reason),
// INV-SAFE-05 (controlled substances need EPCS two-factor and a PDMP check or exception), INV-SAFE-08 (an unsigned Rx
// blocks note signing), flow:refills (renewal requests: protocol, pend, approve/deny), INV-OPS-01 (eRx outage).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";
import {
  TOTP_SECRET,
  asTenantOf,
  call,
  closeApp,
  newPatientBody,
  signIn,
  stepUp,
} from "./helpers.mjs";

// RxNav fixture (no network in tests). Codes are real RxNorm ids; schedule data mirrors the RxNorm attribute.
const C = (rxcui, name, ingredients, deaSchedule = null, scheduleKnown = true) => ({
  rxcui,
  name,
  tty: "SCD",
  ingredientRxcuis: ingredients.map(([r]) => r),
  ingredientNames: ingredients.map(([, n]) => n),
  strengthText: null,
  doseForm: "Oral Tablet",
  route: null,
  brandName: null,
  deaSchedule,
  scheduleKnown,
  scheduleSource: scheduleKnown ? "RXNORM_ATTRIBUTE" : "UNRESOLVED",
  prescribable: true,
  rxnormVersion: "test",
});
const DRUGS = {
  amox: C("308191", "amoxicillin 875 MG Oral Tablet", [["723", "amoxicillin"]]),
  doxy: C("1650142", "doxycycline hyclate 100 MG Oral Tablet", [["3640", "doxycycline"]]),
  oxy: C("1049621", "oxycodone hydrochloride 5 MG Oral Tablet", [["7804", "oxycodone"]], "II"),
  alpraz: C("308047", "alprazolam 0.25 MG Oral Tablet", [["596", "alprazolam"]], "IV"),
  lisin: C("314077", "lisinopril 20 MG Oral Tablet", [["29046", "lisinopril"]]),
  testo: C("1546370", "testosterone 1.62% Topical Gel", [["10379", "testosterone"]], null, false),
};
const byRxcui = new Map(Object.values(DRUGS).map((d) => [d.rxcui, d]));

let fd, ma, provider, np, manager, rao, location, practiceId, erx, pdmp, pharmacy, nonEpcsPharmacy;
before(async () => {
  const { setDrugTerminologyProvider } = await import("../dist/gateways/referenceData/rxnav.js");
  setDrugTerminologyProvider({
    async getConcept(rxcui) {
      return byRxcui.get(rxcui) ?? null;
    },
    async ingredientRxcuis(rxcui) {
      const d = byRxcui.get(rxcui);
      return d ? { name: d.name, tty: d.tty, ingredients: d.ingredientRxcuis } : null;
    },
    async search() {
      return [];
    },
    async listProducts() {
      return [];
    },
    async searchIngredients() {
      return [];
    },
    async getRxnormVersion() {
      return "test";
    },
  });
  const { getRedis } = await import("../dist/redis.js");
  const keys = await getRedis().keys("rxnav:concept:*");
  if (keys.length) await getRedis().del(...keys);
  await getRedis().del("epcs:fail:*");
  [fd, ma, provider, np, manager] = await Promise.all(
    ["frontdesk", "ma", "provider", "np", "manager"].map((u) => signIn(`${u}@example.com`)),
  );
  const practitioners = (await call("GET", "/practitioners", { token: fd })).body;
  rao = practitioners.find((p) => p.credential === "MD");
  location = (await call("GET", "/locations", { token: fd })).body.find(
    (l) => l.placeOfService === "11",
  );
  erx = (await import("../dist/gateways/erx/index.js")).simulatedErx();
  pdmp = (await import("../dist/gateways/pdmp/index.js")).simulatedPdmp();
  const pharmacies = await call("GET", "/reference/pharmacies?q=pharmacy", { token: provider });
  assert.equal(pharmacies.status, 200, JSON.stringify(pharmacies.body));
  pharmacy = pharmacies.body.find((p) => p.epcsEnabled);
  nonEpcsPharmacy = pharmacies.body.find((p) => !p.epcsEnabled);
  assert.ok(pharmacy && nonEpcsPharmacy, "seeded pharmacies");
  await asTenantOf("provider@example.com", async (tx) => {
    practiceId = (await tx.practice.findFirst()).id;
  });
});
after(async () => {
  const { getRedis } = await import("../dist/redis.js");
  const u = await asTenantOf("provider@example.com", (tx) =>
    tx.user.findFirst({ where: { email: "provider@example.com" } }),
  ).catch(() => null);
  if (u) await getRedis().del(`epcs:fail:${u.id}`);
  await closeApp();
});

const newPatient = async () => {
  const r = await call("POST", "/patients", { token: fd, body: newPatientBody() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

async function visit(patient) {
  const enc = await call("POST", `/patients/${patient.id}/encounters`, {
    token: provider,
    body: {
      patientId: patient.id,
      class: "AMB",
      practitionerId: rao.id,
      locationId: location.id,
      reason: "Follow-up",
    },
  });
  assert.equal(enc.status, 201, JSON.stringify(enc.body));
  return enc.body;
}

async function draft(patient, enc, drug, { token = provider, ...extra } = {}) {
  const r = await call("POST", `/encounters/${enc.id}/medication-requests`, {
    token,
    body: {
      patientId: patient.id,
      prescriberId: rao.id,
      rxnormCode: drug.rxcui,
      display: drug.name,
      sigText: "Take 1 tablet by mouth twice daily",
      quantity: "20",
      quantityUnit: "each",
      refills: 0,
      daysSupply: 10,
      pharmacyId: pharmacy.id,
      ...extra,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const check = (rx, token = provider) =>
  call("POST", `/medication-requests/${rx.id}/checks`, { token });
const sign = (rx, patientId, body = {}, token = provider) =>
  call("POST", `/medication-requests/${rx.id}/sign`, {
    token,
    body: { patientId, ids: [rx.id], ...body },
  });
const decide = (alertId, body, token = provider) =>
  call("POST", `/dur-alerts/${alertId}/decision`, { token, body });

async function addAllergy(patientId, a) {
  await asTenantOf("provider@example.com", (tx) =>
    tx.allergyIntolerance.create({
      data: {
        practiceId,
        patientId,
        category: "MEDICATION",
        criticality: "HIGH",
        reactions: { items: [{ manifestation: "Hives", severity: "moderate" }] },
        ...a,
      },
    }),
  );
}
async function addMed(patientId, rxnormCode, display) {
  await asTenantOf("provider@example.com", (tx) =>
    tx.medicationStatement.create({ data: { practiceId, patientId, rxnormCode, display } }),
  );
}

// ---------------------------------------------------------------- INV-SAFE-01, INV-ID-03

test("INV-SAFE-01: an MA can pend a prescription but not sign it", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.doxy, { token: ma });
  assert.equal(rx.status, "DRAFT");
  const r = await sign(rx, p.id, {}, ma);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const ok = await sign(rx, p.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "ACTIVE");
  assert.equal(ok.body.erxStatus, "SENT");
  assert.ok(ok.body.signedAt);
});

test("INV-ID-03: signing with another patient on screen is 409 and nothing is signed", async () => {
  const [p, other] = [await newPatient(), await newPatient()];
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.doxy);
  const r = await sign(rx, other.id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "patient_context_mismatch");
  const list = await call("GET", `/encounters/${enc.id}/medication-requests`, { token: provider });
  assert.equal(list.body[0].status, "DRAFT");
});

test("creating a prescription with another patient on screen is 409; unknown products are 422", async () => {
  const [p, other] = [await newPatient(), await newPatient()];
  const enc = await visit(p);
  const r = await call("POST", `/encounters/${enc.id}/medication-requests`, {
    token: provider,
    body: {
      patientId: other.id,
      prescriberId: rao.id,
      rxnormCode: DRUGS.doxy.rxcui,
      display: "x",
      sigText: "x",
      quantity: "1",
      quantityUnit: "each",
    },
  });
  assert.equal(r.status, 409);
  const bad = await call("POST", `/encounters/${enc.id}/medication-requests`, {
    token: provider,
    body: {
      patientId: p.id,
      prescriberId: rao.id,
      rxnormCode: "999999999",
      display: "x",
      sigText: "x",
      quantity: "1",
      quantityUnit: "each",
    },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, "not_prescribable");
});

// ---------------------------------------------------------------- INV-SAFE-06

test("INV-SAFE-06: drug-allergy alert (penicillin class) is interruptive; override needs a stored reason", async () => {
  const p = await newPatient();
  await addAllergy(p.id, {
    substanceSystem: "SNOMEDCT",
    substanceCode: "764146007",
    substanceDisplay: "Penicillin",
  });
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.amox);
  const c = await check(rx);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const alert = c.body.alerts.find((a) => a.type === "DRUG_ALLERGY");
  assert.ok(alert, JSON.stringify(c.body.alerts));
  assert.equal(alert.severity, "INTERRUPTIVE");
  assert.equal(alert.outcome, "pending");
  assert.match(alert.message, /Amoxicillin is a penicillin/);
  assert.equal(c.body.formulary.status, "preferred");
  assert.ok(c.body.formulary.alternatives.length > 0);

  // Re-checking keeps the same finding (no duplicate rows).
  const again = await check(rx);
  assert.equal(again.body.alerts.find((a) => a.type === "DRUG_ALLERGY").id, alert.id);

  const blocked = await sign(rx, p.id);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "invariant_blocked");
  assert.ok(blocked.body.blockers.some((b) => b.invariant === "INV-SAFE-06"));

  const maDecides = await decide(alert.id, { action: "override", reason: "Tolerated before" }, ma);
  assert.equal(maDecides.status, 403);
  const noReason = await decide(alert.id, { action: "override" });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.code, "override_reason_required");
  const blank = await decide(alert.id, { action: "override", reason: "   " });
  assert.equal(blank.status, 422);

  const ok = await decide(alert.id, {
    action: "override",
    reason: "Patient has tolerated this drug before",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.outcome, "overridden");
  assert.equal(ok.body.overrideReason, "Patient has tolerated this drug before");
  const twice = await decide(alert.id, { action: "override", reason: "again" });
  assert.equal(twice.status, 409);

  const signed = await sign(rx, p.id);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.status, "ACTIVE");

  // Reportable: the override is a stored row with its reason, author and time; the pending row is unchanged.
  const rows = await asTenantOf("provider@example.com", (tx) =>
    tx.durAlert.findMany({ where: { medicationRequestId: rx.id }, orderBy: { decidedAt: "asc" } }),
  );
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["pending", "overridden"],
  );
  assert.ok(rows[1].decidedById);
  assert.equal(rows[1].evidence.decides, alert.id);
});

test("INV-SAFE-06: removing the prescription from the alert cancels the draft", async () => {
  const p = await newPatient();
  await addAllergy(p.id, {
    substanceSystem: "RXNORM",
    substanceCode: "723",
    substanceDisplay: "amoxicillin",
  });
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.amox);
  const alert = (await check(rx)).body.alerts.find((a) => a.type === "DRUG_ALLERGY");
  assert.ok(alert);
  const r = await decide(alert.id, { action: "cancel" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "removed");
  const list = await call("GET", `/encounters/${enc.id}/medication-requests`, { token: provider });
  assert.equal(list.body.find((x) => x.id === rx.id).status, "CANCELLED");
});

test("INV-SAFE-06: switching the drug clears the allergy finding", async () => {
  const p = await newPatient();
  await addAllergy(p.id, {
    substanceSystem: "SNOMEDCT",
    substanceCode: "764146007",
    substanceDisplay: "Penicillin",
  });
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.amox);
  assert.equal((await check(rx)).body.alerts.length, 1);
  const sw = await call("PATCH", `/medication-requests/${rx.id}`, {
    token: provider,
    headers: { "if-match": `"${rx.version}"` },
    body: { rxnormCode: DRUGS.doxy.rxcui },
  });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal(sw.body.display, DRUGS.doxy.name);
  assert.equal((await check(rx)).body.alerts.length, 0);
  assert.equal((await sign(rx, p.id)).status, 200);
});

test("INV-SAFE-06: severe drug-drug interaction (opioid + benzodiazepine) is interruptive", async () => {
  const p = await newPatient();
  await addMed(p.id, DRUGS.alpraz.rxcui, "Alprazolam 0.25 mg tablet");
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.oxy, { quantity: "10" });
  const c = await check(rx);
  const ddi = c.body.alerts.find((a) => a.type === "DRUG_DRUG");
  assert.ok(ddi, JSON.stringify(c.body.alerts));
  assert.equal(ddi.severity, "INTERRUPTIVE");
  assert.match(ddi.evidence.effect, /respiratory depression/);
  assert.equal(c.body.pdmpRequired, true);
  assert.equal(c.body.epcsRequired, true);
});

test("duplicate therapy is passive: signing needs it acknowledged, and the acknowledgement is stored", async () => {
  const p = await newPatient();
  await addMed(p.id, DRUGS.lisin.rxcui, "Lisinopril 20 mg tablet");
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.lisin, { quantity: "30" });
  const dup = (await check(rx)).body.alerts.find((a) => a.type === "DUPLICATE_THERAPY");
  assert.ok(dup);
  assert.equal(dup.severity, "PASSIVE");
  const blocked = await sign(rx, p.id);
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.blockers.some((b) => b.code === "dur_alert_unacknowledged"));
  const ok = await sign(rx, p.id, { acknowledgedAlertIds: [dup.id] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rows = await asTenantOf("provider@example.com", (tx) =>
    tx.durAlert.findMany({ where: { medicationRequestId: rx.id, outcome: "acknowledged" } }),
  );
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------- INV-SAFE-05

test("INV-SAFE-05: controlled Rx is blocked without a PDMP check, then needs step-up and the EPCS code", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.oxy, { quantity: "12", daysSupply: 3 });
  assert.equal(rx.isControlled, true);
  assert.equal(rx.deaSchedule, "II");

  const noPdmp = await sign(rx, p.id, { epcsToken: authenticator.generate(TOTP_SECRET) });
  assert.equal(noPdmp.status, 422);
  assert.ok(
    noPdmp.body.blockers.some((b) => b.code === "pdmp_required" && b.invariant === "INV-SAFE-05"),
  );

  const maPdmp = await call("POST", `/patients/${p.id}/pdmp-queries`, {
    token: ma,
    body: { patientId: p.id, state: "IL", purpose: "Prescribing" },
  });
  assert.equal(maPdmp.status, 403);
  const q = await call("POST", `/patients/${p.id}/pdmp-queries`, {
    token: provider,
    body: { patientId: p.id, state: "IL", purpose: "Prescribing" },
  });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const report = await call("GET", `/pdmp-queries/${q.body.id}/report`, { token: provider });
  assert.equal(report.status, 200);
  assert.match(String(report.headers["content-type"]), /pdf/);

  // A PDMP query for a different patient does not count.
  const other = await newPatient();
  const otherQ = await call("POST", `/patients/${other.id}/pdmp-queries`, {
    token: provider,
    body: { patientId: other.id, state: "IL", purpose: "Prescribing" },
  });
  const wrongQ = await sign(rx, p.id, { pdmpQueryId: otherQ.body.id, epcsToken: "000000" });
  assert.equal(wrongQ.status, 422);
  assert.ok(wrongQ.body.blockers.some((b) => b.code === "pdmp_required"));

  // EPCS: wrong code is refused (and audited); the right code signs.
  await stepUp(provider);
  const wrong = await sign(rx, p.id, { pdmpQueryId: q.body.id, epcsToken: "000000" });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.equal(wrong.body.code, "epcs_token_invalid");
  const ok = await sign(rx, p.id, {
    pdmpQueryId: q.body.id,
    epcsToken: authenticator.generate(TOTP_SECRET),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "ACTIVE");
  assert.ok(ok.body.epcsTwoFactorAt);
  assert.equal(ok.body.pdmpQueryId, q.body.id);

  const audit = await asTenantOf("provider@example.com", (tx) =>
    tx.auditEvent.findMany({
      where: { operationId: "signPrescription", outcome: "FAILURE" },
      orderBy: { at: "desc" },
      take: 1,
    }),
  );
  assert.equal(audit.length, 1, "failed EPCS attempt is audited");
});

test("INV-SAFE-05: a recorded PDMP exception allows signing; Schedule II refills and non-EPCS pharmacies are blocked", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.oxy, {
    refills: 1,
    pharmacyId: nonEpcsPharmacy.id,
    pdmpExceptionReason: "State PDMP unavailable (outage)",
  });
  const r = await sign(rx, p.id, { epcsToken: authenticator.generate(TOTP_SECRET) });
  assert.equal(r.status, 422);
  const codes = r.body.blockers.map((b) => b.code).sort();
  assert.deepEqual(codes, ["pharmacy_not_epcs", "refills_not_allowed"]);
  const fixed = await call("PATCH", `/medication-requests/${rx.id}`, {
    token: provider,
    headers: { "if-match": `"${rx.version}"` },
    body: { refills: 0, pharmacyId: pharmacy.id },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  await stepUp(provider);
  const ok = await sign(rx, p.id, { epcsToken: authenticator.generate(TOTP_SECRET) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.pdmpQueryId ?? null, null);
  assert.equal(ok.body.pdmpExceptionReason, "State PDMP unavailable (outage)");
});

test("INV-SAFE-05: a prescriber without EPCS set-up can't sign controlled substances; unverified schedule counts as controlled", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.alpraz, { pdmpExceptionReason: "Checked on state website" });
  await stepUp(np);
  const r = await sign(rx, p.id, { epcsToken: authenticator.generate(TOTP_SECRET) }, np);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, "epcs_not_enabled");

  const testo = await draft(p, enc, DRUGS.testo);
  assert.equal(testo.isControlled, true, "schedule unknown = controlled (fail closed)");
  const c = await check(testo);
  assert.equal(c.body.pdmpRequired, true);
});

test("INV-SAFE-05: three wrong EPCS codes lock EPCS signing (423)", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.alpraz, { pdmpExceptionReason: "Checked on state website" });
  await stepUp(provider);
  for (let i = 0; i < 3; i++) {
    const r = await sign(rx, p.id, { epcsToken: "000000" });
    assert.equal(r.status, 422, JSON.stringify(r.body));
  }
  const locked = await sign(rx, p.id, { epcsToken: authenticator.generate(TOTP_SECRET) });
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, "epcs_locked");
  const { getRedis } = await import("../dist/redis.js");
  const u = await asTenantOf("provider@example.com", (tx) =>
    tx.user.findFirst({ where: { email: "provider@example.com" } }),
  );
  await getRedis().del(`epcs:fail:${u.id}`);
});

// ---------------------------------------------------------------- INV-SAFE-08

test("INV-SAFE-08: an unsigned prescription blocks note signing until it is signed", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.doxy);
  const pre = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: provider });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.ok(pre.body.blockers.some((b) => b.code === "unsigned_rx"));
  assert.equal((await sign(rx, p.id)).status, 200);
  const after = await call("GET", `/encounters/${enc.id}/sign-preflight`, { token: provider });
  assert.ok(!after.body.blockers.some((b) => b.code === "unsigned_rx"));
});

// ---------------------------------------------------------------- INV-OPS-01

test("INV-OPS-01: an eRx outage leaves the Rx signed with a work item; resend sends it once", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.doxy);
  erx.down = true;
  let r;
  try {
    r = await sign(rx, p.id);
  } finally {
    erx.down = false;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "ACTIVE");
  assert.equal(r.body.erxStatus, "QUEUED");
  const [task, msg] = await asTenantOf("provider@example.com", (tx) =>
    Promise.all([
      tx.task.findFirst({ where: { type: "INTERFACE_FAILURE", focusId: rx.id, status: "OPEN" } }),
      tx.interfaceMessage.findFirst({ where: { correlationId: rx.id, messageType: "NewRx" } }),
    ]),
  );
  assert.ok(task, "work item names the prescription");
  assert.equal(msg.status, "FAILED");
  await stepUp(manager);
  const resend = await call("POST", `/interface-messages/${msg.id}/resend`, { token: manager });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  const [after, msgs, open] = await asTenantOf("provider@example.com", (tx) =>
    Promise.all([
      tx.medicationRequest.findUnique({ where: { id: rx.id } }),
      tx.interfaceMessage.count({ where: { correlationId: rx.id, messageType: "NewRx" } }),
      tx.task.count({ where: { type: "INTERFACE_FAILURE", focusId: rx.id, status: "OPEN" } }),
    ]),
  );
  assert.equal(after.erxStatus, "SENT");
  assert.equal(msgs, 1, "same message row, no duplicate");
  assert.equal(open, 0);
});

test("cancelling a sent prescription sends CancelRx and stops it on the medication list", async () => {
  const p = await newPatient();
  const enc = await visit(p);
  const rx = await draft(p, enc, DRUGS.doxy);
  assert.equal((await sign(rx, p.id)).status, 200);
  const noReason = await call("POST", `/medication-requests/${rx.id}/cancel`, {
    token: provider,
    body: { reason: "" },
  });
  assert.equal(noReason.status, 422);
  const r = await call("POST", `/medication-requests/${rx.id}/cancel`, {
    token: provider,
    body: { reason: "Wrong drug" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "CANCELLED");
  assert.equal(r.body.erxStatus, "CANCELLED");
  const meds = await call("GET", `/patients/${p.id}/medication-statements`, { token: provider });
  assert.ok(!meds.body.some((m) => m.prescriptionId === rx.id && m.status === "ACTIVE"));
});

// ---------------------------------------------------------------- flow:refills

async function renewalEvent(patient, original, extra = {}) {
  const { signErxPayload } = await import("../dist/gateways/erx/index.js");
  const { connectionFor } = await import("../dist/platform/integrations.js");
  const conn = await asTenantOf("provider@example.com", (tx) =>
    connectionFor(tx, practiceId, "LOGICOY"),
  );
  const body = JSON.stringify({
    type: "RxRenewalRequest",
    eventId: `evt-${original.id}-${extra.n ?? 1}`,
    practiceId,
    pharmacyNcpdpId: pharmacy.ncpdpId,
    prescriptionId: original.id,
    patient: {
      mrn: patient.mrn,
      lastName: patient.lastName,
      firstName: patient.firstName,
      birthDate: patient.birthDate,
    },
    requested: { quantity: 60, daysSupply: 30, refills: 0 },
    ...extra.body,
  });
  return call("POST", "/webhooks/logicoy", {
    body: JSON.parse(body),
    headers: { "x-logicoy-signature": extra.badSig ? "sha256=00" : signErxPayload(conn.id, body) },
  });
}

async function signedOriginal(patient, drug = DRUGS.lisin) {
  const enc = await visit(patient);
  const rx = await draft(patient, enc, drug, { quantity: "30" });
  const r = await sign(rx, patient.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test("flow:refills: a signed renewal request opens a task; MA pends, provider approves and the response is sent", async () => {
  const p = await newPatient();
  const original = await signedOriginal(p);
  const bad = await renewalEvent(p, original, { badSig: true });
  assert.equal(bad.status, 401);
  const r = await renewalEvent(p, original);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const replay = await renewalEvent(p, original);
  assert.equal(replay.status, 202);

  const list = await call("GET", "/inbox/rx-requests", { token: ma });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const mine = list.body.data.filter((x) => x.patient.id === p.id);
  assert.equal(mine.length, 1, "replayed event creates no duplicate");
  const req = mine[0];
  assert.equal(req.type, "RENEWAL");
  assert.equal(req.taskStatus, "OPEN");
  assert.equal(req.medication.id, original.id);
  assert.equal(req.draft.status, "DRAFT");
  assert.equal(Number(req.draft.quantity), 60);
  assert.equal(typeof req.protocolMet, "boolean");
  assert.ok(req.protocolNotes.length > 0);

  const maApprove = await call("POST", `/rx-requests/${req.id}/approve`, {
    token: ma,
    body: { decision: "approve" },
  });
  assert.equal(maApprove.status, 403);
  const pend = await call("POST", `/rx-requests/${req.id}/pend`, {
    token: ma,
    body: { comment: "Protocol passed; last BP fine" },
  });
  assert.equal(pend.status, 200, JSON.stringify(pend.body));
  assert.equal(pend.body.taskStatus, "PENDED_TO_PROVIDER");

  // Duplicate-therapy check on the renewal ignores the original it replaces.
  const c = await check(req.draft);
  assert.equal(c.status, 200);
  assert.equal(c.body.alerts.length, 0, JSON.stringify(c.body.alerts));

  const ok = await call("POST", `/rx-requests/${req.id}/approve`, {
    token: provider,
    body: { decision: "approve", refills: 2 },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.taskStatus, "COMPLETED");
  assert.equal(ok.body.responseStatus, "approved");
  assert.equal(ok.body.draft.status, "ACTIVE");
  assert.equal(ok.body.draft.refills, 2);
  assert.equal(ok.body.draft.erxStatus, "SENT");
  assert.equal(ok.body.draft.priorPrescriptionId, original.id);

  const meds = await call("GET", `/patients/${p.id}/medication-statements`, { token: provider });
  const entry = meds.body.find((m) => m.prescriptionId === ok.body.draft.id);
  assert.ok(entry, "the medication list now points at the renewal");
  assert.ok(!meds.body.some((m) => m.prescriptionId === original.id));

  const again = await call("POST", `/rx-requests/${req.id}/approve`, {
    token: provider,
    body: { decision: "approve" },
  });
  assert.equal(again.status, 409);
});

test("flow:refills: deny needs a reason, cancels the draft and completes the task", async () => {
  const p = await newPatient();
  const original = await signedOriginal(p);
  assert.equal((await renewalEvent(p, original, { n: 2 })).status, 202);
  const req = (await call("GET", "/inbox/rx-requests", { token: provider })).body.data.find(
    (x) => x.patient.id === p.id,
  );
  const noReason = await call("POST", `/rx-requests/${req.id}/deny`, {
    token: provider,
    body: { reason: " " },
  });
  assert.equal(noReason.status, 422);
  const r = await call("POST", `/rx-requests/${req.id}/deny`, {
    token: provider,
    body: { reason: "Needs a visit first" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.taskStatus, "COMPLETED");
  assert.equal(r.body.responseStatus, "denied");
  assert.equal(r.body.draft.status, "CANCELLED");
});

test("flow:refills: renewal approval follows INV-SAFE-06 (an allergy alert must be decided first)", async () => {
  const p = await newPatient();
  const original = await signedOriginal(p, DRUGS.amox);
  // Allergy recorded after the original was written.
  await addAllergy(p.id, {
    substanceSystem: "SNOMEDCT",
    substanceCode: "764146007",
    substanceDisplay: "Penicillin",
  });
  assert.equal((await renewalEvent(p, original, { n: 3 })).status, 202);
  const req = (await call("GET", "/inbox/rx-requests", { token: provider })).body.data.find(
    (x) => x.patient.id === p.id,
  );
  const blocked = await call("POST", `/rx-requests/${req.id}/approve`, {
    token: provider,
    body: { decision: "approve" },
  });
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.blockers.some((b) => b.invariant === "INV-SAFE-06"));
  const alert = (await check(req.draft)).body.alerts.find((a) => a.type === "DRUG_ALLERGY");
  assert.ok(alert);
  assert.equal(
    (await decide(alert.id, { action: "override", reason: "Tolerated for 2 years" })).status,
    200,
  );
  const ok = await call("POST", `/rx-requests/${req.id}/approve`, {
    token: provider,
    body: { decision: "approve" },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("a pharmacy Error for a sent prescription comes back as a change request", async () => {
  const p = await newPatient();
  const original = await signedOriginal(p, DRUGS.doxy);
  const { signErxPayload } = await import("../dist/gateways/erx/index.js");
  const { connectionFor } = await import("../dist/platform/integrations.js");
  const conn = await asTenantOf("provider@example.com", (tx) =>
    connectionFor(tx, practiceId, "LOGICOY"),
  );
  const body = JSON.stringify({
    type: "Error",
    eventId: `err-${original.id}`,
    practiceId,
    messageId: original.erxMessageId,
    code: "900",
    description: "Drug not stocked",
  });
  const r = await call("POST", "/webhooks/logicoy", {
    body: JSON.parse(body),
    headers: { "x-logicoy-signature": signErxPayload(conn.id, body) },
  });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const req = (await call("GET", "/inbox/rx-requests", { token: provider })).body.data.find(
    (x) => x.patient.id === p.id,
  );
  assert.ok(req);
  assert.equal(req.type, "CHANGE");
  assert.equal(req.protocolMet, undefined);
});

test("Me.connectedGateways lists ErxGateway and PdmpGateway outside production", async () => {
  const me = await call("GET", "/auth/me", { token: provider });
  assert.ok(me.body.connectedGateways.includes("ErxGateway"));
  assert.ok(me.body.connectedGateways.includes("PdmpGateway"));
  assert.equal(me.body.canSign.controlledSubstances, true);
  const npMe = await call("GET", "/auth/me", { token: np });
  assert.equal(npMe.body.canSign.controlledSubstances, false);
});
