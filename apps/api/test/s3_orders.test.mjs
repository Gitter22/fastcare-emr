// S3: orders and results. INV-SAFE-01 (only providers sign orders), INV-ID-03 (sign compares patient context),
// INV-SAFE-08 (orders need a diagnosis), INV-SAFE-03 (unmatched results never auto-file), INV-SAFE-04 (critical results
// need documented communication), INV-SAFE-07 (overdue orders surface), INV-OPS-01 (interface failures create work
// and resend without duplicates).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, getApp, newPatientBody, signIn, stepUp } from "./helpers.mjs";

let fd, ma, provider, manager, rao, location, practiceId, connId, lab;
before(async () => {
  [fd, ma, provider, manager] = await Promise.all(
    ["frontdesk", "ma", "provider", "manager"].map((u) => signIn(`${u}@example.com`)),
  );
  const practitioners = (await call("GET", "/practitioners", { token: fd })).body;
  rao = practitioners.find((p) => p.credential === "MD");
  location = (await call("GET", "/locations", { token: fd })).body.find(
    (l) => l.placeOfService === "11",
  );
  await stepUp(manager);
  lab = await import("../dist/gateways/lab/index.js");
  const { connectionFor } = await import("../dist/platform/integrations.js");
  await asTenantOf("provider@example.com", async (tx) => {
    practiceId = (await tx.practice.findFirst()).id;
    connId = (await connectionFor(tx, practiceId, "HEALTH_GORILLA")).id;
  });
});
after(closeApp);

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
      reason: "Labs",
    },
  });
  assert.equal(enc.status, 201, JSON.stringify(enc.body));
  const dx = await call("POST", `/encounters/${enc.body.id}/diagnoses`, {
    token: provider,
    body: { icd10Code: "E11.9" },
  });
  assert.equal(dx.status, 200, JSON.stringify(dx.body));
  return { enc: enc.body, dx: dx.body };
}

async function labItem(q) {
  const r = await call("GET", `/order-catalog?q=${encodeURIComponent(q)}&category=lab`, {
    token: provider,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const item = r.body.find((i) => i.kind === "lab");
  assert.ok(item, `no compendium item for ${q}`);
  return item;
}

async function order(patient, enc, q, { reasons = [], aoeAnswers, token = provider } = {}) {
  const item = await labItem(q);
  const r = await call("POST", `/encounters/${enc.id}/service-requests`, {
    token,
    body: {
      patientId: patient.id,
      category: "LAB",
      codeSystem: "LOINC",
      code: item.code,
      display: item.display,
      labCompendiumItemId: item.id,
      reasonConditionIds: reasons,
      ...(aoeAnswers ? { aoeAnswers } : {}),
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const signOrders = (enc, patientId, ids, extra = {}, token = provider) =>
  call("POST", `/encounters/${enc.id}/service-requests/sign`, {
    token,
    body: { patientId, ids, acknowledgedWarnings: ["duplicate"], ...extra },
  });

async function signedLabOrder(q = "Potassium") {
  const patient = await newPatient();
  const { enc, dx } = await visit(patient);
  const sr = await order(patient, enc, q, { reasons: [dx.id] });
  const s = await signOrders(enc, patient.id, [sr.id]);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { patient, enc, dx, sr: s.body[0] };
}

async function postOru(raw, { signature } = {}) {
  const app = await getApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/labs/health-gorilla",
    headers: {
      "content-type": "x-application/hl7-v2+er7",
      "x-lab-signature": signature ?? lab.signLabPayload(connId, raw),
    },
    payload: raw,
  });
  return { status: res.statusCode, body: res.json() };
}

function oruFor(patient, sr, { values, status, identity } = {}) {
  return lab.fakeOru(
    {
      placerOrderNumber: sr.placerOrderNumber,
      accessionNumber: sr.accessionNumber ?? "",
      testCode: sr.code,
      display: sr.display,
      loincCode: sr.code,
      collectedAt: new Date(),
    },
    {
      practiceId,
      lab: sr.performerLab ?? "QUEST",
      values,
      status,
      at: new Date(Date.now() + Math.floor(Math.random() * 1e6)),
      patient: identity ?? {
        mrn: patient.mrn,
        lastName: patient.lastName,
        firstName: patient.firstName,
        birthDate: patient.birthDate,
        sex: "F",
      },
    },
  );
}

const reportsOf = async (patientId) =>
  (await call("GET", `/patients/${patientId}/diagnostic-reports`, { token: provider })).body.data;

test("orders need a diagnosis and required AOE answers before signing (INV-SAFE-08)", async () => {
  const patient = await newPatient();
  const { enc, dx } = await visit(patient);
  const lipid = await order(patient, enc, "Lipid panel");
  const v = await call("GET", `/encounters/${enc.id}/service-requests/validation`, {
    token: provider,
  });
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, false);
  const codes = v.body.issues.filter((i) => i.serviceRequestId === lipid.id).map((i) => i.code);
  assert.ok(codes.includes("missing-dx"), JSON.stringify(v.body));
  assert.ok(codes.includes("aoe"), JSON.stringify(v.body));
  const blocked = await signOrders(enc, patient.id, [lipid.id]);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "orders_not_ready");

  const comp = (await call("GET", "/lab-compendium?q=Lipid", { token: provider })).body.data[0];
  const aoeCode = comp.aoeQuestions.items[0].code;
  const fixed = await call("PATCH", `/service-requests/${lipid.id}`, {
    token: provider,
    headers: { "if-match": `"${lipid.version}"` },
    body: { reasonConditionIds: [dx.id], aoeAnswers: { [aoeCode]: true } },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.reasons.length, 1);
  assert.ok(fixed.body.expectedBy, "every order has an expected-by date (INV-SAFE-07)");
  const ok = await signOrders(enc, patient.id, [lipid.id]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body[0].status, "SENT", "the simulated lab accepts the order");
  assert.ok(ok.body[0].accessionNumber);
});

test("only providers sign orders, and only for the patient on screen (INV-SAFE-01, INV-ID-03)", async () => {
  const patient = await newPatient();
  const other = await newPatient();
  const { enc, dx } = await visit(patient);
  const sr = await order(patient, enc, "Potassium", { reasons: [dx.id], token: ma });
  const byMa = await signOrders(enc, patient.id, [sr.id], {}, ma);
  assert.equal(byMa.status, 403);
  const wrong = await signOrders(enc, other.id, [sr.id]);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "patient_context_mismatch");
  const mismatch = await call("POST", `/encounters/${enc.id}/service-requests`, {
    token: provider,
    body: {
      patientId: other.id,
      category: "LAB",
      codeSystem: "LOINC",
      code: "x",
      display: "x",
      reasonConditionIds: [],
    },
  });
  assert.equal(mismatch.status, 409);
});

test("a lab outage leaves the order signed with a work item; resend sends it once (INV-OPS-01)", async () => {
  const patient = await newPatient();
  const { enc, dx } = await visit(patient);
  const sr = await order(patient, enc, "TSH", { reasons: [dx.id] });
  lab.fakeLab().down = true;
  let signed;
  try {
    signed = await signOrders(enc, patient.id, [sr.id]);
  } finally {
    lab.fakeLab().down = false;
  }
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body[0].status, "SIGNED");
  const { msg, task } = await asTenantOf("manager@example.com", async (tx) => ({
    msg: await tx.interfaceMessage.findUnique({ where: { idempotencyKey: `orm:${sr.id}` } }),
    task: await tx.task.findFirst({ where: { type: "INTERFACE_FAILURE", focusId: sr.id } }),
  }));
  assert.equal(msg.status, "FAILED");
  assert.ok(task, "an interface failure creates a work item");
  const resend = await call("POST", `/interface-messages/${msg.id}/resend`, { token: manager });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  const after = await call("GET", `/patients/${patient.id}/service-requests`, { token: provider });
  const row = after.body.data.find((r) => r.id === sr.id);
  assert.equal(row.status, "SENT");
  const msgs = await asTenantOf("manager@example.com", (tx) =>
    tx.interfaceMessage.findMany({ where: { correlationId: sr.id } }),
  );
  assert.equal(msgs.length, 1, "resend reuses the same message (no duplicate order at the lab)");
  const closed = await asTenantOf("manager@example.com", (tx) =>
    tx.task.findUnique({ where: { id: task.id } }),
  );
  assert.equal(closed.status, "COMPLETED");
});

test("a matching result files to the chart, once, and routes for review", async () => {
  const { patient, sr } = await signedLabOrder("Potassium");
  const coll = await call("POST", `/service-requests/${sr.id}/specimens`, {
    token: ma,
    body: {
      serviceRequestIds: [sr.id],
      collectedAt: new Date().toISOString(),
      type: "serum",
      printLabels: true,
    },
  });
  assert.equal(coll.status, 200, JSON.stringify(coll.body));
  assert.equal(coll.body.status, "COLLECTED");
  const raw = oruFor(patient, coll.body);
  const bad = await postOru(raw, { signature: "sha256=00" });
  assert.equal(bad.status, 401);
  const r1 = await postOru(raw);
  assert.equal(r1.status, 202, JSON.stringify(r1.body));
  const r2 = await postOru(raw);
  assert.equal(r2.status, 202);
  const reports = await reportsOf(patient.id);
  assert.equal(reports.length, 1, "a re-delivered message does not file twice");
  assert.equal(reports[0].status, "FINAL");
  const detail = await call("GET", `/diagnostic-reports/${reports[0].id}`, { token: provider });
  assert.equal(detail.body.serviceRequest.status, "RESULTED_FINAL");
  assert.ok(detail.body.observations.length >= 1);
  const inbox = await call("GET", "/inbox/results", { token: provider });
  assert.ok(inbox.body.data.some((i) => i.report.id === reports[0].id));
  const review = await call("POST", `/diagnostic-reports/${reports[0].id}/review`, {
    token: provider,
    body: { version: detail.body.version, patientComment: "Normal.", release: true },
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.serviceRequest.status, "REVIEWED");
  assert.ok(review.body.releasedToPortalAt);
});

test("a result whose patient doesn't match the order goes to reconciliation, never the chart (INV-SAFE-03)", async () => {
  const { patient, sr } = await signedLabOrder("Creatinine");
  const raw = oruFor(patient, sr, {
    identity: {
      mrn: patient.mrn,
      lastName: "Someoneelse",
      firstName: "Pat",
      birthDate: "1950-01-01",
      sex: "F",
    },
  });
  assert.equal((await postOru(raw)).status, 202);
  assert.equal((await reportsOf(patient.id)).length, 0, "nothing filed in the chart");
  const queue = await call("GET", "/inbound-results", { token: ma });
  const item = queue.body.data.find((i) => i.placerOrderNumber === sr.placerOrderNumber);
  assert.ok(item, JSON.stringify(queue.body));
  assert.equal(item.matchStatus, "UNMATCHED");
  const task = await asTenantOf("ma@example.com", (tx) =>
    tx.task.findFirst({ where: { type: "UNMATCHED_RESULT", focusId: item.id } }),
  );
  assert.ok(task);
  const detail = await call("GET", `/inbound-results/${item.id}`, { token: ma });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.ok(detail.body.rawPreview.includes("Someoneelse"));

  const noReason = await call("POST", `/inbound-results/${item.id}/match`, {
    token: ma,
    body: { patientId: patient.id, serviceRequestId: sr.id, reason: " " },
  });
  assert.equal(noReason.status, 422);
  const matched = await call("POST", `/inbound-results/${item.id}/match`, {
    token: ma,
    body: {
      patientId: patient.id,
      serviceRequestId: sr.id,
      reason: "Lab confirmed by phone: name typo",
    },
  });
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  assert.equal((await reportsOf(patient.id)).length, 1);
  const again = await call("POST", `/inbound-results/${item.id}/reject`, {
    token: ma,
    body: { reason: "x" },
  });
  assert.equal(again.status, 409);

  const unknown = oruFor(patient, { ...sr, placerOrderNumber: "AE000000999999" });
  assert.equal((await postOru(unknown)).status, 202);
  const q2 = await call("GET", "/inbound-results", { token: ma });
  assert.ok(q2.body.data.some((i) => i.placerOrderNumber === "AE000000999999"));
});

test("a critical result can't be signed off until the call is documented (INV-SAFE-04)", async () => {
  const { patient, sr } = await signedLabOrder("Potassium");
  assert.equal((await postOru(oruFor(patient, sr, { values: { "2823-3": 6.6 } }))).status, 202);
  const [rep] = await reportsOf(patient.id);
  assert.equal(rep.flag, "CRITICAL");
  const task = await asTenantOf("provider@example.com", (tx) =>
    tx.task.findFirst({ where: { type: "CRITICAL_RESULT", focusId: rep.id } }),
  );
  assert.ok(task, "critical value creates a task");
  assert.equal(task.priority, "URGENT");
  const detail = await call("GET", `/diagnostic-reports/${rep.id}`, { token: provider });
  const early = await call("POST", `/diagnostic-reports/${rep.id}/review`, {
    token: provider,
    body: { version: detail.body.version },
  });
  assert.equal(early.status, 422);
  assert.equal(early.body.code, "critical_contact_required");

  const voicemail = await call("POST", `/diagnostic-reports/${rep.id}/critical-contacts`, {
    token: ma,
    body: {
      diagnosticReportId: rep.id,
      reached: false,
      method: "voicemail",
      contactedAt: new Date().toISOString(),
    },
  });
  assert.equal(voicemail.status, 201, JSON.stringify(voicemail.body));
  const stillBlocked = await call("POST", `/diagnostic-reports/${rep.id}/review`, {
    token: provider,
    body: { version: detail.body.version },
  });
  assert.equal(stillBlocked.status, 422);

  // Not reached within the hour: the sweep escalates and the task stays open.
  const { escalateCriticalResults } = await import("../dist/modules/results/ingest.js");
  const n = await asTenantOf("provider@example.com", (tx) =>
    escalateCriticalResults(tx, practiceId, new Date(Date.now() + 2 * 3_600_000)),
  );
  assert.ok(n >= 1);
  const escalated = await asTenantOf("provider@example.com", (tx) =>
    tx.task.findUnique({ where: { id: task.id } }),
  );
  assert.equal(escalated.status, "ESCALATED");

  const reached = await call("POST", `/diagnostic-reports/${rep.id}/critical-contacts`, {
    token: provider,
    body: {
      diagnosticReportId: rep.id,
      reached: true,
      spokeWith: "patient",
      method: "phone",
      contactedAt: new Date().toISOString(),
      instructions: "Go to the ED now",
      readBack: true,
    },
  });
  assert.equal(reached.status, 201);
  const ok = await call("POST", `/diagnostic-reports/${rep.id}/review`, {
    token: provider,
    body: { version: detail.body.version },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const done = await asTenantOf("provider@example.com", (tx) =>
    tx.task.findUnique({ where: { id: task.id } }),
  );
  assert.equal(done.status, "COMPLETED");
  const bulk = await call("POST", "/diagnostic-reports/review-bulk", {
    token: provider,
    body: { ids: [rep.id] },
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.failed.length, 1, "critical results are not bulk-reviewed");
});

test("a corrected result reopens review on an already-reviewed order", async () => {
  const { patient, sr } = await signedLabOrder("Creatinine");
  await postOru(oruFor(patient, sr));
  const [rep] = await reportsOf(patient.id);
  const d = await call("GET", `/diagnostic-reports/${rep.id}`, { token: provider });
  assert.equal(
    (
      await call("POST", `/diagnostic-reports/${rep.id}/review`, {
        token: provider,
        body: { version: d.body.version },
      })
    ).status,
    200,
  );
  assert.equal(
    (await postOru(oruFor(patient, sr, { status: "C", values: { "2160-0": 1.9 } }))).status,
    202,
  );
  const after = await call("GET", `/diagnostic-reports/${rep.id}`, { token: provider });
  assert.equal(after.body.status, "CORRECTED");
  assert.equal(after.body.serviceRequest.status, "RESULTED_FINAL");
  assert.equal(after.body.observations[0].valueQuantity, "1.90");
  const ack = await call("POST", `/diagnostic-reports/${rep.id}/acknowledge-correction`, {
    token: provider,
  });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.ok(ack.body.correctionAcknowledgedAt);
});

test("orders past their expected-by date surface for follow-up, once (INV-SAFE-07)", async () => {
  const { patient, sr } = await signedLabOrder("Vitamin B12");
  await asTenantOf("provider@example.com", (tx) =>
    tx.serviceRequest.update({
      where: { id: sr.id },
      data: { expectedBy: new Date(Date.now() - 5 * 86_400_000) },
    }),
  );
  const list = await call("GET", "/service-requests/overdue?limit=200", { token: ma });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.data.find((r) => r.serviceRequest.id === sr.id);
  assert.ok(row);
  assert.ok(row.daysOverdue >= 4);
  assert.equal(row.patient.id, patient.id);
  const { flagOverdueOrders } = await import("../dist/modules/orders/tracking.js");
  await asTenantOf("provider@example.com", (tx) => flagOverdueOrders(tx, practiceId));
  await asTenantOf("provider@example.com", (tx) => flagOverdueOrders(tx, practiceId));
  const tasks = await asTenantOf("provider@example.com", (tx) =>
    tx.task.findMany({ where: { type: "OVERDUE_ORDER", focusId: sr.id } }),
  );
  assert.equal(tasks.length, 1);
  const past = await call("POST", `/service-requests/${sr.id}/expected-date`, {
    token: ma,
    body: { expectedBy: "2020-01-01" },
  });
  assert.equal(past.status, 422);
  const ext = await call("POST", `/service-requests/${sr.id}/expected-date`, {
    token: ma,
    body: { expectedBy: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) },
  });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  const closed = await asTenantOf("provider@example.com", (tx) =>
    tx.task.findUnique({ where: { id: tasks[0].id } }),
  );
  assert.equal(closed.status, "COMPLETED");
});

test("requisition and labels print with the patient's identity; order sets apply with default diagnoses", async () => {
  const { sr, patient } = await signedLabOrder("Hemoglobin A1c");
  const req = await call("GET", `/service-requests/${sr.id}/requisition`, { token: ma });
  assert.equal(req.status, 200);
  assert.equal(req.headers["content-type"], "application/pdf");
  const labels = await call("GET", `/service-requests/${sr.id}/labels`, { token: ma });
  assert.equal(labels.status, 200);
  const sets = (await call("GET", "/order-sets", { token: provider })).body;
  const diabetes = sets.find((s) => /diabetes/i.test(s.name));
  const { enc } = await visit(patient);
  const applied = await call("POST", `/encounters/${enc.id}/order-sets/${diabetes.id}/apply`, {
    token: provider,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.ok(applied.body.length >= 3);
  assert.ok(applied.body.every((o) => o.status === "PENDED"));
});
