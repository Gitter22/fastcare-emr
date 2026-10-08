// S3: interface monitor (admin.interfaces). INV-OPS-01: every message visible, retries idempotent, nothing faked.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { asTenantOf, call, closeApp, signIn, stepUp, unique } from "./helpers.mjs";

let manager, frontdesk, conn;
before(async () => {
  [manager, frontdesk] = await Promise.all(
    ["manager", "frontdesk"].map((u) => signIn(`${u}@example.com`)),
  );
  const list = await call("GET", "/integrations", { token: manager });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  conn = list.body.find((c) => c.kind === "FAX");
  assert.ok(conn);
  const retry = await import("../dist/platform/interfaceRetry.js");
  // A gateway-style resender: re-runs the call under the same idempotency key.
  retry.registerResender("TEST_RESENDABLE", async (tx, m) => {
    await tx.interfaceMessage.update({
      where: { id: m.id },
      data: {
        attempts: { increment: 1 },
        status: "ACKNOWLEDGED",
        error: null,
        completedAt: new Date(),
      },
    });
  });
});
after(closeApp);

const seedMessage = (messageType, status = "FAILED") =>
  asTenantOf("manager@example.com", async (tx) =>
    tx.interfaceMessage.create({
      data: {
        practiceId: (await tx.practice.findFirst()).id,
        connectionId: conn.id,
        direction: "OUTBOUND",
        messageType,
        idempotencyKey: unique("idem"),
        status,
        attempts: 1,
        error: "TIMEOUT",
      },
    }),
  );

test("manager only: other roles cannot read the monitor", async () => {
  const r = await call("GET", "/integrations", { token: frontdesk });
  assert.equal(r.status, 403);
});

test("list shows failures24h and queueDepth from InterfaceMessage", async () => {
  const before = (await call("GET", "/integrations", { token: manager })).body.find(
    (c) => c.id === conn.id,
  );
  await seedMessage("TEST_UNKNOWN", "FAILED");
  await seedMessage("TEST_UNKNOWN", "QUEUED");
  const after = (await call("GET", "/integrations", { token: manager })).body.find(
    (c) => c.id === conn.id,
  );
  assert.equal(after.failures24h, before.failures24h + 1);
  assert.equal(after.queueDepth, before.queueDepth + 1);
});

test("update and rotate need step-up; secret is write-only", async () => {
  const d = (await call("GET", `/integrations/${conn.id}`, { token: manager })).body;
  const noStep = await call("PATCH", `/integrations/${conn.id}`, {
    token: manager,
    headers: { "if-match": `W/"${d.version}"` },
    body: { baaOnFile: true, version: d.version },
  });
  assert.equal(noStep.status, 403);
  assert.equal(noStep.body.code, "step_up_required");
  const noStepSecret = await call("PUT", `/integrations/${conn.id}/secret`, {
    token: manager,
    body: { value: "s3cret-value" },
  });
  assert.equal(noStepSecret.status, 403);
  await stepUp(manager);
  const upd = await call("PATCH", `/integrations/${conn.id}`, {
    token: manager,
    headers: { "if-match": `W/"${d.version}"` },
    body: { baaOnFile: true, version: d.version },
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.baaOnFile, true);
  const stale = await call("PATCH", `/integrations/${conn.id}`, {
    token: manager,
    headers: { "if-match": `W/"${d.version}"` },
    body: { enabled: true, version: d.version },
  });
  assert.equal(stale.status, 412);
  const rot = await call("PUT", `/integrations/${conn.id}/secret`, {
    token: manager,
    body: { value: "s3cret-value" },
  });
  assert.equal(rot.status, 204, JSON.stringify(rot.body));
  const after = await call("GET", `/integrations/${conn.id}`, { token: manager });
  assert.deepEqual(after.body.secretsSet, ["credentials"]);
  assert.ok(!JSON.stringify(after.body).includes("s3cret-value"));
  assert.equal(after.body.secretRef, undefined);
});

test("resend of a message type with no resender is 409 cannot_resend", async () => {
  const m = await seedMessage("TEST_UNKNOWN");
  const r = await call("POST", `/interface-messages/${m.id}/resend`, { token: manager });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "cannot_resend");
});

test("resend and retry are idempotent: same key, attempts + 1, no duplicates", async () => {
  const m = await seedMessage("TEST_RESENDABLE");
  const r = await call("POST", `/interface-messages/${m.id}/resend`, { token: manager });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "ACKNOWLEDGED");
  assert.equal(r.body.attempts, 2);
  assert.equal(r.body.idempotencyKey, m.idempotencyKey);
  const again = await call("POST", `/interface-messages/${m.id}/resend`, { token: manager });
  assert.equal(again.status, 409, "an acknowledged message is not resent");

  const m2 = await seedMessage("TEST_RESENDABLE");
  const counts = () =>
    asTenantOf("manager@example.com", (tx) =>
      tx.interfaceMessage.count({ where: { connectionId: conn.id } }),
    );
  const total = await counts();
  const first = await call("POST", `/integrations/${conn.id}/retry`, { token: manager });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await call("POST", `/integrations/${conn.id}/retry`, { token: manager });
  assert.ok([200, 409].includes(second.status));
  assert.equal(await counts(), total, "retry creates no new messages");
  const after = await asTenantOf("manager@example.com", (tx) =>
    tx.interfaceMessage.findUnique({ where: { id: m2.id } }),
  );
  assert.equal(after.attempts, 2);
  assert.equal(after.status, "ACKNOWLEDGED");
});

test("test on a gateway with no vendor credentials reports it, health unchanged", async () => {
  const before = (await call("GET", `/integrations/${conn.id}`, { token: manager })).body;
  const r = await call("POST", `/integrations/${conn.id}/test`, { token: manager });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.health, before.health);
  assert.equal(r.body.lastError, "Not connected: no vendor credentials configured");
});

test("messages list paginates by cursor", async () => {
  for (let i = 0; i < 3; i++) await seedMessage("TEST_UNKNOWN");
  const p1 = await call("GET", `/integrations/${conn.id}/messages?limit=2`, { token: manager });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.data.length, 2);
  assert.equal(p1.body.hasMore, true);
  const p2 = await call(
    "GET",
    `/integrations/${conn.id}/messages?limit=2&cursor=${p1.body.nextCursor}`,
    { token: manager },
  );
  assert.equal(p2.status, 200);
  assert.ok(p2.body.data.every((m) => !p1.body.data.some((x) => x.id === m.id)));
});
