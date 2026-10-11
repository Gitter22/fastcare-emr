// S5: revenue cycle. flow:encounter/06 (charge capture, E/M, coding edits), flow:rcm (release on sign, charge
// review, scrub, 837P, 999/277CA, ERA posting, denials/appeals, statements, payment plans, day close).
// INV-FIN-01 (append-only ledger), INV-FIN-02 (derived balance), INV-FIN-03 (scrubber), INV-FIN-04 (day-close
// variance), INV-FIN-05 (rejections/denials are work items with deadlines), INV-SEC-05 (billers never read notes),
// INV-OPS-01 (clearinghouse outage + idempotent webhook).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, newPatientBody, signIn, stepUp } from "./helpers.mjs";

const NIL = "00000000-0000-0000-0000-000000000000";
let fd, provider, biller, manager, rao, location, payers, practiceId, ch, inbound;

before(async () => {
  [fd, provider, biller, manager] = await Promise.all(
    ["frontdesk", "provider", "biller", "manager"].map((u) => signIn(`${u}@example.com`)),
  );
  rao = (await call("GET", "/practitioners", { token: fd })).body.find(
    (p) => p.credential === "MD",
  );
  location = (await call("GET", "/locations", { token: fd })).body.find(
    (l) => l.placeOfService === "11",
  );
  payers = (await call("GET", "/payers", { token: fd })).body;
  practiceId = await asTenantOf("biller@example.com", async (tx) => {
    const r = await tx.$queryRaw`SELECT current_setting('app.practice_id') AS id`;
    return r[0].id;
  });
  ch = await import("../dist/gateways/clearinghouse/index.js");
  inbound = await import("../dist/modules/rcm/inbound.js");
  await stepUp(provider);
});
after(closeApp);

const payer = (name) => payers.find((p) => p.name === name);

/** Patient with an address and primary coverage (member id drives the simulated payer). */
async function insuredPatient(memberId, payerName = "Aetna") {
  const body = newPatientBody({
    addresses: [
      { patientId: NIL, line1: "12 Elm St", city: "Springfield", state: "IL", postalCode: "62701" },
    ],
  });
  const p = await call("POST", "/patients", { token: fd, body });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  if (memberId) {
    const cov = await call("POST", `/patients/${p.body.id}/coverages`, {
      token: fd,
      body: { patientId: p.body.id, payerId: payer(payerName).id, memberId },
    });
    assert.equal(cov.status, 201, JSON.stringify(cov.body));
  }
  return p.body;
}

async function encounterWithDx(patient, codes = ["E11.9"]) {
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
  const note = (await call("GET", `/encounters/${enc.body.id}/note`, { token: provider })).body;
  const dx = [];
  for (const icd10Code of codes) {
    const r = await call("POST", `/encounters/${enc.body.id}/diagnoses`, {
      token: provider,
      body: { icd10Code },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    dx.push(r.body);
  }
  return { enc: enc.body, note, dx };
}

const addCharge = (encId, code, dxIds, extra = {}) =>
  call("POST", `/encounters/${encId}/charges`, {
    token: provider,
    body: { code, dxConditionIds: dxIds, ...extra },
  });

async function signNote(enc, note, dx, patientId) {
  const saved = await call("PUT", `/encounters/${enc.id}/note/sections`, {
    token: provider,
    body: {
      version: note.version,
      sections: [
        { key: "hpi", text: "Doing well." },
        ...dx.map((d) => ({ key: `ap:${d.id}`, text: "Continue." })),
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const r = await call("POST", `/notes/${note.id}/sign`, {
    token: provider,
    body: { version: saved.body.version, patientId, attest: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** A visit with clean charges, signed: returns the READY claim. */
async function readyClaim(memberId, payerName = "Aetna", codes = ["99213"]) {
  const p = await insuredPatient(memberId, payerName);
  const { enc, note, dx } = await encounterWithDx(p);
  for (const c of codes) assert.equal((await addCharge(enc.id, c, [dx[0].id])).status, 201);
  const signed = await signNote(enc, note, dx, p.id);
  assert.equal(signed.chargesCreated, codes.length);
  const claims = (await call("GET", `/claims?patientId=${p.id}`, { token: biller })).body.data;
  assert.equal(claims.length, 1);
  return { patient: p, enc, claim: claims[0] };
}

const simulate = () =>
  asTenantOf("biller@example.com", (tx) =>
    inbound.runSimulatedClearinghouse(tx, practiceId, new Date(Date.now() + 60_000), 0),
  );
const submit = (ids) => call("POST", "/claims/submit", { token: biller, body: { ids } });
const claim = async (id) => (await call("GET", `/claims/${id}`, { token: biller })).body;
const balance = async (pid) =>
  (await call("GET", `/patients/${pid}/balance`, { token: biller })).body;
const ledgerSum = (rows, resp) =>
  rows
    .filter((r) => r.responsibility === resp)
    .reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);

test("flow:encounter/06: E/M suggestion, modifier-25 edit with apply, pointers required (INV-FIN-03)", async () => {
  const p = await insuredPatient("W100");
  const { enc, dx } = await encounterWithDx(p, ["E11.9", "Z23"]);
  const em = await call("POST", `/encounters/${enc.id}/em-level`, {
    token: provider,
    body: {
      basis: "mdm",
      problems: "moderate",
      data: "limited",
      risk: "moderate",
      newPatient: false,
    },
  });
  assert.equal(em.status, 200, JSON.stringify(em.body));
  assert.equal(em.body.code, "99214");
  const time = await call("POST", `/encounters/${enc.id}/em-level`, {
    token: provider,
    body: { basis: "time", totalMinutes: 5, newPatient: false },
  });
  assert.equal(time.status, 422);

  const noPtr = await addCharge(enc.id, "99214", []);
  assert.equal(noPtr.status, 422, "INV-FIN-03: a charge needs a diagnosis pointer");
  const emLine = await addCharge(enc.id, "99214", [dx[0].id]);
  assert.equal(emLine.status, 201, JSON.stringify(emLine.body));
  assert.equal(emLine.body.fee, "165.00", "fee from the practice fee schedule");
  assert.equal((await addCharge(enc.id, "90686", [dx[1].id])).status, 201);
  assert.equal((await addCharge(enc.id, "90471", [dx[1].id])).status, 201);
  const view = (await call("GET", `/encounters/${enc.id}/charges`, { token: provider })).body;
  assert.equal(view.readyForClaim, false);
  const mod25 = view.holds.find((h) => h.code.startsWith("mod25:"));
  assert.ok(mod25, "modifier 25 warning on the E/M");
  assert.equal(view.emSuggestion.code, "99214");
  const applied = await call(
    "POST",
    `/charge-items/${emLine.body.id}/edits/${encodeURIComponent(mod25.code)}/apply`,
    { token: provider },
  );
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.modifiers, ["25"]);
  const after = (await call("GET", `/encounters/${enc.id}/charges`, { token: provider })).body;
  assert.equal(after.readyForClaim, true, JSON.stringify(after.holds));
  // A biller can read the charges but never the note (INV-SEC-05).
  assert.equal((await call("GET", `/encounters/${enc.id}/charges`, { token: biller })).status, 200);
});

test("flow:rcm/01-02: unresolved edit holds charges on sign; charge review release needs the fix (INV-SEC-05)", async () => {
  const p = await insuredPatient("W200");
  const { enc, note, dx } = await encounterWithDx(p, ["E11.9", "Z23"]);
  const em = (await addCharge(enc.id, "99213", [dx[0].id])).body;
  await addCharge(enc.id, "90471", [dx[1].id]);
  await addCharge(enc.id, "90686", [dx[1].id]);
  const signed = await signNote(enc, note, dx, p.id);
  assert.equal(signed.chargesCreated, 0, "held, not released");
  const list = (await call("GET", "/charge-review", { token: biller })).body.data;
  const row = list.find((r) => r.encounterId === enc.id);
  assert.ok(row && row.holds.includes("modifier"), JSON.stringify(row));

  const detail = await call("GET", `/charge-review/${enc.id}`, { token: biller });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.ok(detail.body.note, "note summary is shown");
  assert.equal(detail.body.note.sections, undefined, "INV-SEC-05: no note text for billing");
  assert.ok(
    !JSON.stringify(detail.body).includes("Doing well."),
    "INV-SEC-05: note body never leaves the API",
  );
  assert.equal((await call("GET", `/encounters/${enc.id}/note`, { token: biller })).status, 403);
  assert.equal((await call("GET", `/notes/${note.id}`, { token: biller })).status, 403);

  const blocked = await call("POST", `/charge-review/${enc.id}/release`, { token: biller });
  assert.equal(blocked.status, 422);
  const query = await call("POST", `/charge-review/${enc.id}/provider-query`, {
    token: biller,
    body: { comment: "Separate problem for 99213?" },
  });
  assert.equal(query.status, 200, JSON.stringify(query.body));
  assert.equal(query.body.type, "PROVIDER_QUERY");

  const key = detail.body.edits.find((e) => e.code.startsWith("mod25:")).code;
  const errDismiss = await call(
    "POST",
    `/charge-items/${em.id}/edits/${encodeURIComponent(key)}/dismiss`,
    { token: biller, body: { reason: "" } },
  );
  assert.equal(errDismiss.status, 422);
  const dismissed = await call(
    "POST",
    `/charge-items/${em.id}/edits/${encodeURIComponent(key)}/dismiss`,
    {
      token: biller,
      body: { reason: "Same-day E/M not separately identifiable; payer bundles" },
    },
  );
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  const released = await call("POST", `/charge-review/${enc.id}/release`, { token: biller });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const claims = (await call("GET", `/claims?patientId=${p.id}`, { token: biller })).body.data;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "READY");
  assert.equal(claims[0].billed, "182.00");
  const tasks = await asTenantOf("biller@example.com", (tx) =>
    tx.task.findMany({ where: { focusId: enc.id, type: "PROVIDER_QUERY" } }),
  );
  assert.equal(tasks[0].status, "COMPLETED", "release closes the provider query");
});

test("INV-FIN-03: the scrubber refuses a claim without POS, and a stored claim missing NPI/TIN is not sent", async () => {
  const p = await insuredPatient("W300");
  const { enc, note, dx } = await encounterWithDx(p);
  await addCharge(enc.id, "99213", [dx[0].id]);
  await asTenantOf("biller@example.com", (tx) =>
    tx.encounter.update({ where: { id: enc.id }, data: { placeOfService: "Q9" } }),
  );
  const signed = await signNote(enc, note, dx, p.id);
  assert.equal(signed.chargesCreated, 0);
  const r = await call("POST", `/charge-review/${enc.id}/release`, { token: biller });
  assert.equal(r.status, 422);
  assert.ok(
    r.body.blockers.some((b) => b.code === "pos" && b.invariant === "INV-FIN-03"),
    JSON.stringify(r.body),
  );

  const { claim: c } = await readyClaim("W301");
  await asTenantOf("biller@example.com", (tx) =>
    tx.claim.update({
      where: { id: c.id },
      data: { billingTin: "", renderingProviderNpi: "1234567890" },
    }),
  );
  const job = await submit([c.id]);
  assert.equal(job.status, 202, JSON.stringify(job.body));
  const res = job.body.params.results.find((x) => x.claimId === c.id);
  assert.equal(res.outcome, "blocked");
  assert.ok(
    res.blockers.some((b) => b.code === "tin") &&
      res.blockers.some((b) => b.code === "npi-rendering"),
  );
  assert.equal((await claim(c.id)).status, "READY", "never sent");
});

test("flow:rcm main path: submit -> 999 -> 277CA -> 835 with CO-45/PR-3 -> balance -> statement -> plan -> autopay (INV-FIN-01/02)", async () => {
  const { patient, claim: c } = await readyClaim("W400", "Aetna", ["99213"]);
  assert.equal(c.billed, "125.00");
  const before = await claim(c.id);
  assert.equal(before.ledger.length, 1);
  assert.equal(before.ledger[0].type, "CHARGE");
  assert.equal(before.ledger[0].responsibility, "INSURANCE");
  assert.equal((await balance(patient.id)).insurancePending, "125.00");

  const job = await submit([c.id]);
  assert.equal(job.body.params.results[0].outcome, "submitted");
  let d = await claim(c.id);
  assert.equal(d.status, "SUBMITTED");
  assert.ok(d.events.some((e) => e.type === "ACK_999" && e.statusCode === "A"));
  const x12 = await call("GET", `/claims/${c.id}/x12`, { token: biller });
  assert.equal(x12.status, 200);

  await simulate(); // 277CA accept
  d = await claim(c.id);
  assert.equal(d.status, "ACCEPTED");
  await simulate(); // 835
  d = await claim(c.id);
  assert.equal(d.status, "PAID", JSON.stringify(d.events));
  // Aetna contract 99213 = 125 * 0.78 = 97.50 allowed; PR-3 25.00; paid 72.50; CO-45 27.50.
  assert.equal(d.totalPaid, "72.50");
  assert.equal(d.patientResponsibility, "25.00");
  const types = d.ledger.map((l) => l.type).sort();
  assert.deepEqual(types, [
    "CHARGE",
    "CONTRACTUAL_ADJUSTMENT",
    "INSURANCE_PAYMENT",
    "TRANSFER_TO_PATIENT",
    "TRANSFER_TO_PATIENT",
  ]);
  const bal = await balance(patient.id);
  assert.equal(bal.insurancePending, "0.00");
  assert.equal(bal.patientDue, "25.00");
  // INV-FIN-02: the balance is the sum of the ledger.
  const ledger = (await call("GET", `/patients/${patient.id}/ledger`, { token: biller })).body.data;
  assert.equal(ledgerSum(ledger, "PATIENT"), 2500);
  assert.equal(ledgerSum(ledger, "INSURANCE"), 0);

  const remits = (await call("GET", "/remittances", { token: biller })).body.data;
  const remit = remits.find((r) => r.status === "POSTED");
  assert.ok(remit, "balanced ERA auto-posts");

  const st = await call("POST", `/patients/${patient.id}/statements`, {
    token: biller,
    body: { channel: "SMS" },
  });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.amountDue, "25.00");
  assert.equal((await call("GET", `/statements/${st.body.id}/pdf`, { token: biller })).status, 200);

  const card = await call("POST", `/patients/${patient.id}/payment-methods`, {
    token: fd,
    body: { hostedFieldsToken: "tok_visa_4242_1228", consentToCardOnFile: true },
  });
  assert.equal(card.status, 201, JSON.stringify(card.body));
  const today = new Date().toISOString().slice(0, 10);
  const tooMuch = await call("POST", `/patients/${patient.id}/payment-plans`, {
    token: biller,
    body: { totalAmount: "30.00", months: 2, firstPaymentOn: today, paymentMethodId: card.body.id },
  });
  assert.equal(tooMuch.status, 422);
  const plan = await call("POST", `/patients/${patient.id}/payment-plans`, {
    token: biller,
    body: { totalAmount: "25.00", months: 2, firstPaymentOn: today, paymentMethodId: card.body.id },
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.monthlyAmount, "12.50");
  const { runPaymentPlanAutopay } = await import("../dist/modules/rcm/accounts.js");
  await asTenantOf("biller@example.com", (tx) => runPaymentPlanAutopay(tx, practiceId, new Date()));
  await asTenantOf("biller@example.com", (tx) => runPaymentPlanAutopay(tx, practiceId, new Date()));
  assert.equal(
    (await balance(patient.id)).patientDue,
    "12.50",
    "one installment, charged once (idempotent)",
  );
  const cycle = await call("GET", "/statements/cycle", { token: biller });
  assert.equal(cycle.status, 200, JSON.stringify(cycle.body));
});

test("INV-FIN-05: 999 and 277CA rejections become work items due by the filing deadline; fix and resubmit", async () => {
  const { claim: r999 } = await readyClaim("REJECT999-1");
  await submit([r999.id]);
  let d = await claim(r999.id);
  assert.equal(d.status, "REJECTED");
  assert.ok(d.rejectionReason.includes("member ID"));

  const { patient, claim: c } = await readyClaim("REJECT-277");
  await submit([c.id]);
  await simulate();
  d = await claim(c.id);
  assert.equal(d.status, "REJECTED");
  assert.equal(d.rejectionField, "coverage.memberId");
  const tasks = await asTenantOf("biller@example.com", (tx) =>
    tx.task.findMany({ where: { focusType: "Claim", focusId: c.id, type: "CLAIM_REJECTION" } }),
  );
  assert.equal(tasks.length, 1);
  assert.equal(
    tasks[0].dueAt.toISOString().slice(0, 10),
    d.filingDeadline,
    "due by the filing deadline",
  );
  const rej = (await call("GET", "/claims/rejections", { token: biller })).body.data.find(
    (r) => r.claim.id === c.id,
  );
  assert.equal(rej.source, "277CA");

  // Fix the member id, correct as an original (never adjudicated), resubmit.
  const cov = (await call("GET", `/patients/${patient.id}/coverages`, { token: fd })).body[0];
  const fixed = await call("PATCH", `/coverages/${cov.id}`, {
    token: fd,
    headers: { "if-match": String(cov.version) },
    body: { memberId: "W500" },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const seven = await call("PATCH", `/claims/${c.id}`, {
    token: biller,
    headers: { "if-match": String(d.version) },
    body: { frequencyCode: "7", changes: {}, reason: "member id", version: d.version },
  });
  assert.equal(seven.status, 422, "a rejected claim goes back as an original");
  const corr = await call("PATCH", `/claims/${c.id}`, {
    token: biller,
    headers: { "if-match": String(d.version) },
    body: { frequencyCode: "1", changes: {}, reason: "Member ID corrected", version: d.version },
  });
  assert.equal(corr.status, 200, JSON.stringify(corr.body));
  const re = await call("POST", `/claims/${c.id}/resubmit`, { token: biller });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.status, "SUBMITTED");
  const open = await asTenantOf("biller@example.com", (tx) =>
    tx.task.count({ where: { focusId: c.id, type: "CLAIM_REJECTION", status: "OPEN" } }),
  );
  assert.equal(open, 0, "resubmission closes the rejection work item");

  // Bill the patient instead (rejected -> closed, transfer rows only).
  const { patient: p2, claim: c2 } = await readyClaim("REJECT999-2");
  await submit([c2.id]);
  const t = await call("POST", `/claims/${c2.id}/transfer-to-patient`, {
    token: biller,
    body: { reason: "Patient says no coverage" },
  });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.status, "CLOSED");
  assert.equal((await balance(p2.id)).patientDue, "125.00");
});

test("INV-FIN-05: 835 denial -> Denial with appeal deadline + task; appeal letter has no note text; appeal; write-off approval", async () => {
  const { claim: c, enc } = await readyClaim("DENY-1");
  await submit([c.id]);
  await simulate();
  await simulate();
  let d = await claim(c.id);
  assert.equal(d.status, "DENIED", JSON.stringify(d.events));
  assert.equal(d.denials.length, 1);
  const denial = d.denials[0];
  assert.equal(denial.carc, "197");
  assert.equal(denial.rootCause, "no-auth");
  const task = await asTenantOf("biller@example.com", (tx) =>
    tx.task.findFirst({ where: { focusType: "Denial", focusId: denial.id } }),
  );
  assert.equal(task.type, "DENIAL");
  assert.equal(task.dueAt.toISOString().slice(0, 10), denial.appealDeadline);
  const groups = (await call("GET", "/denials/groups", { token: biller })).body;
  assert.ok(groups.some((g) => g.key === "no-auth" && g.count >= 1));
  const rows = (await call("GET", "/denials?rootCause=no-auth", { token: biller })).body.data;
  assert.ok(
    rows.some((r) => r.denial.id === denial.id && r.appealDeadline === denial.appealDeadline),
  );

  const letter = await call("POST", `/denials/${denial.id}/appeal-letter`, {
    token: biller,
    body: { denialId: denial.id, level: 1 },
  });
  assert.equal(letter.status, 200, JSON.stringify(letter.body));
  assert.ok(!letter.body.text.includes("Doing well."), "INV-SEC-05: no note text in the letter");
  assert.ok(letter.body.attachmentsSuggested.some((a) => a.includes("provider release")));
  const appeal = await call("POST", `/denials/${denial.id}/appeals`, {
    token: biller,
    body: { level: 1, letter: letter.body.text, attachmentFileIds: [], submittedVia: "portal" },
  });
  assert.equal(appeal.status, 200, JSON.stringify(appeal.body));
  assert.equal(appeal.body.status, "APPEALED");
  assert.equal(appeal.body.claim.status, "APPEALED");
  void enc;

  // Write-off above the threshold needs a manager.
  const { claim: c2 } = await readyClaim("DENY-2", "Aetna", ["99214"]);
  await submit([c2.id]);
  await simulate();
  await simulate();
  const den2 = (await claim(c2.id)).denials[0];
  const big = await call("POST", `/denials/${den2.id}/write-off`, {
    token: biller,
    body: { amount: "165.00", reasonCode: "197" },
  });
  assert.equal(big.status, 403);
  assert.equal(big.body.code, "write_off_needs_approval");
  const ok = await call("POST", `/denials/${den2.id}/write-off`, {
    token: manager,
    body: { amount: "165.00", reasonCode: "197" },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const closed = await call("POST", `/claims/${c2.id}/close`, {
    token: biller,
    body: { reason: "Written off" },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "CLOSED");
});

test("flow:rcm/06: underpayment vs contract stays open as an underpaid denial (partially paid)", async () => {
  const { claim: c } = await readyClaim("UNDERPAY-1", "Aetna", ["99214"]);
  await submit([c.id]);
  await simulate();
  await simulate();
  const d = await claim(c.id);
  assert.equal(d.status, "PARTIALLY_PAID", JSON.stringify(d.events));
  const den = d.denials.find((x) => x.rootCause === "underpaid");
  assert.ok(den);
  // contract 128.70; paid at 80% = 102.96 allowed -> 25.74 under.
  assert.equal(den.amount, "25.74");
  const bal = await balance(d.patientId);
  assert.equal(bal.insurancePending, "25.74");
});

test("ERA exceptions: unmatched claim and recoupment keep the remit unbalanced; webhook redelivery is idempotent (INV-OPS-01)", async () => {
  const { claim: c } = await readyClaim("W700", "Blue Cross Blue Shield of Illinois", ["99213"]);
  await submit([c.id]);
  await simulate(); // accepted
  const { simulated835 } = await import("../dist/gateways/clearinghouse/simulated.js");
  const bcbs = payer("Blue Cross Blue Shield of Illinois");
  const pcn = c.number.replace(/[^A-Za-z0-9]/g, "");
  const report = simulated835({
    traceNumber: `T${Date.now()}`,
    paymentDate: new Date().toISOString().slice(0, 10),
    payerName: bcbs.name,
    payerId: bcbs.clearinghousePayerId,
    claims: [
      {
        patientControlNumber: pcn,
        payerClaimControlNumber: "PX1",
        memberId: "W700",
        billed: 125,
        contractAllowed: 100,
      },
      {
        patientControlNumber: "NOSUCHCLAIM1",
        payerClaimControlNumber: "PX2",
        memberId: "W701",
        billed: 125,
        contractAllowed: 100,
      },
    ],
    providerAdjustments: [{ reasonCode: "WO", reference: pcn, amount: 10 }],
  });
  ch.fakeClearinghouse().reports.set("TX-ERA-1", report);
  const connId = await asTenantOf("biller@example.com", async (tx) => {
    const { connectionFor } = await import("../dist/platform/integrations.js");
    return (await connectionFor(tx, practiceId, "STEDI")).id;
  });
  const event = {
    event: { detail: { transactionId: "TX-ERA-1", x12: { transactionSetIdentifier: "835" } } },
  };
  const bad = await call("POST", "/webhooks/stedi", {
    body: event,
    headers: { "x-practice-id": practiceId, authorization: "Key nope" },
  });
  assert.equal(bad.status, 401);
  const headers = {
    "x-practice-id": practiceId,
    authorization: `Key ${inbound.stediWebhookKey(connId)}`,
  };
  const hook = await call("POST", "/webhooks/stedi", { body: event, headers });
  assert.equal(hook.status, 202, JSON.stringify(hook.body));
  const again = await call("POST", "/webhooks/stedi", { body: event, headers });
  assert.equal(again.status, 202);
  const remits = (await call("GET", "/remittances", { token: biller })).body.data.filter(
    (r) => r.payerName === bcbs.name,
  );
  assert.equal(remits.length, 1, "redelivery does not create a second remittance");
  const remit = (await call("GET", `/remittances/${remits[0].id}`, { token: biller })).body;
  assert.equal(remit.status, "EXCEPTION");
  assert.equal((await claim(c.id)).status, "PAID", "matched claim auto-posts");
  const fin = await call("POST", `/remittances/${remit.id}/post`, { token: biller });
  assert.equal(fin.status, 409, "unbalanced remit cannot finish");

  // Match the stray line to another accepted BCBS claim, post the recoupment, then finish.
  const { claim: c2 } = await readyClaim("W702", "Blue Cross Blue Shield of Illinois", ["99213"]);
  await submit([c2.id]);
  await simulate();
  const stray = remit.claimPayments.find((x) => !x.payment.claimId);
  const m = await call("POST", `/remittance-claim-payments/${stray.payment.id}/match`, {
    token: biller,
    body: { claimId: c2.id },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const plb = remit.providerLevelAdjustments[0];
  const rec = await call("POST", `/provider-adjustments/${plb.id}/post`, {
    token: biller,
    body: { claimId: c.id },
  });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  const done = await call("POST", `/remittances/${remit.id}/post`, { token: biller });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "POSTED");
  const recoup = (await claim(c.id)).ledger.find((l) => l.type === "RECOUPMENT");
  assert.equal(recoup.amount, "10.00");
});

test("INV-OPS-01: a clearinghouse outage leaves the claim ready with a work item; retry sends it once", async () => {
  const { claim: c } = await readyClaim("W800");
  ch.fakeClearinghouse().down = true;
  try {
    const job = await submit([c.id]);
    assert.equal(job.body.params.results[0].outcome, "failed");
  } finally {
    ch.fakeClearinghouse().down = false;
  }
  assert.equal((await claim(c.id)).status, "READY");
  const t = await asTenantOf("biller@example.com", (tx) =>
    tx.task.findFirst({ where: { focusId: c.id, type: "INTERFACE_FAILURE" } }),
  );
  assert.ok(t);
  const msg = await asTenantOf("biller@example.com", (tx) =>
    tx.interfaceMessage.findFirst({ where: { correlationId: c.id, messageType: "X12_837P" } }),
  );
  assert.equal(msg.status, "FAILED");
  const resend = await call("POST", `/interface-messages/${msg.id}/resend`, { token: manager });
  assert.ok([200, 202].includes(resend.status), JSON.stringify(resend.body));
  const d = await claim(c.id);
  assert.equal(d.status, "SUBMITTED");
  assert.equal(d.events.filter((e) => e.type === "SUBMITTED").length, 1);
  const done = await asTenantOf("biller@example.com", (tx) =>
    tx.task.findUnique({ where: { id: t.id } }),
  );
  assert.equal(done.status, "COMPLETED");
});

test("INV-FIN-04: day close with an unexplained variance is refused; a reason closes and locks the day", async () => {
  const p = await insuredPatient(null);
  const pay = await call("POST", "/payments", {
    token: fd,
    body: { patientId: p.id, amount: "40.00", method: "CASH", idempotencyKey: `dc-${Date.now()}` },
  });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const day = await call("GET", "/deposit-batches/current", { token: biller });
  assert.equal(day.status, 200, JSON.stringify(day.body));
  const cash = Number(day.body.expected.cash);
  assert.ok(cash >= 40, JSON.stringify(day.body.expected));
  const counts = {
    cash: (cash - 5).toFixed(2),
    checks: day.body.expected.check,
    cardTerminal: day.body.expected.card,
  };
  const saved = await call("PUT", `/deposit-batches/${day.body.id}/counts`, {
    token: biller,
    body: counts,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.variance, "-5.00");
  const date = day.body.businessDate;
  const refused = await call("POST", `/deposit-batches/${day.body.id}/close`, {
    token: biller,
    body: { locationId: day.body.locationId, date, counts },
  });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.blockers[0].invariant, "INV-FIN-04");
  const closed = await call("POST", `/deposit-batches/${day.body.id}/close`, {
    token: biller,
    body: {
      locationId: day.body.locationId,
      date,
      counts,
      varianceReason: "$5 given as change twice; recounted",
    },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "CLOSED");
  const late = await call("PUT", `/deposit-batches/${day.body.id}/counts`, {
    token: biller,
    body: counts,
  });
  assert.equal(late.status, 409);
});

test("INV-FIN-01: refunds and corrections are new ledger rows; refunds need step-up and a credit", async () => {
  const p = await insuredPatient(null);
  const pay = await call("POST", "/payments", {
    token: fd,
    body: { patientId: p.id, amount: "30.00", method: "CASH", idempotencyKey: `rf-${Date.now()}` },
  });
  assert.equal(pay.status, 201);
  const before = (await call("GET", `/patients/${p.id}/ledger`, { token: biller })).body.data;
  const noStep = await call("POST", `/payments/${pay.body.id}/refund`, {
    token: biller,
    body: { amount: "10.00", reason: "Overpaid", toOriginalMethod: true },
  });
  assert.equal(noStep.status, 403);
  await stepUp(biller);
  const tooMuch = await call("POST", `/payments/${pay.body.id}/refund`, {
    token: biller,
    body: { amount: "40.00", reason: "x", toOriginalMethod: true },
  });
  assert.equal(tooMuch.status, 422);
  const r = await call("POST", `/payments/${pay.body.id}/refund`, {
    token: biller,
    body: { amount: "10.00", reason: "Overpaid", toOriginalMethod: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const afterRows = (await call("GET", `/patients/${p.id}/ledger`, { token: biller })).body.data;
  assert.equal(afterRows.length, before.length + 1);
  for (const row of before)
    assert.deepEqual(
      afterRows.find((x) => x.id === row.id),
      row,
      "earlier rows unchanged",
    );
  assert.equal((await balance(p.id)).credit, "20.00");
  // The app role still cannot rewrite ledger history.
  await assert.rejects(
    asTenantOf(
      "biller@example.com",
      (tx) => tx.$executeRaw`UPDATE "LedgerEntry" SET amount = 0 WHERE "patientId" = ${p.id}::uuid`,
    ),
  );
  const acct = await call("GET", `/patients/${p.id}/account`, { token: biller });
  assert.equal(acct.status, 200, JSON.stringify(acct.body));
  assert.equal(acct.body.balance.credit, "20.00");
});

test("self-pay visit: charges post straight to the patient; claims pipeline and reference lookups", async () => {
  const p = await insuredPatient(null);
  const { enc, note, dx } = await encounterWithDx(p);
  await addCharge(enc.id, "99212", [dx[0].id]);
  const signed = await signNote(enc, note, dx, p.id);
  assert.equal(signed.chargesCreated, 1);
  assert.equal((await balance(p.id)).patientDue, "85.00");
  const pipe = await call("GET", "/claims/pipeline", { token: biller });
  assert.equal(pipe.status, 200);
  assert.ok(pipe.body.buckets.find((b) => b.status === "PAID").count >= 1);
  const cpt = await call("GET", "/reference/procedure-codes?q=venipuncture", { token: provider });
  assert.equal(cpt.body[0].code, "36415");
  const carc = await call("GET", "/reference/adjustment-codes?q=197", { token: biller });
  assert.ok(carc.body.some((c) => c.code === "197"));
  const pos = await call("GET", "/reference/pos", { token: fd });
  assert.ok(pos.body.some((c) => c.code === "11"));
  const coll = await call("GET", "/reports/collections?groupBy=payer", { token: manager });
  assert.equal(coll.status, 200, JSON.stringify(coll.body));
});
