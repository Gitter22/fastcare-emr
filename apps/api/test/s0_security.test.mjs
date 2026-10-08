// S0 security invariants: INV-SEC-01 (append-only audit of PHI reads), INV-SEC-02 (tenant isolation), invite + MFA.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";
import { asTenantOf, call, closeApp, signIn, stepUp, unique } from "./helpers.mjs";

let manager, admin2, frontdesk;
before(async () => {
  manager = await signIn("manager@example.com");
  admin2 = await signIn("admin2@example.com");
  frontdesk = await signIn("frontdesk@example.com");
});
after(closeApp);

test("INV-SEC-01: reading a chart writes an audit row; the audit table has no UPDATE/DELETE grant", async () => {
  const search = await call("GET", "/patients?q=Patel", { token: frontdesk });
  const id = search.body.data[0].id;
  assert.equal((await call("GET", `/patients/${id}`, { token: frontdesk })).status, 200);
  const rows = await asTenantOf("frontdesk@example.com", (tx) =>
    tx.auditEvent.findMany({ where: { patientId: id, action: "READ", operationId: "getPatient" } }),
  );
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.hash && r.hash.length === 64));
  const { prisma } = await import("../dist/db.js");
  const grants =
    await prisma.$queryRaw`SELECT has_table_privilege('app_api', '"AuditEvent"', 'UPDATE') AS u, has_table_privilege('app_api', '"AuditEvent"', 'DELETE') AS d, has_table_privilege('app_api', '"LedgerEntry"', 'UPDATE') AS lu`;
  assert.deepEqual(grants[0], { u: false, d: false, lu: false });
});

test("INV-SEC-01: the audit chain verifies (tamper evidence)", async () => {
  const { verifyChain } = await import("../dist/platform/audit.js");
  const rows = await asTenantOf("frontdesk@example.com", (tx) =>
    tx.auditEvent.findMany({ orderBy: { id: "asc" } }),
  );
  assert.ok(rows.length > 5);
  assert.deepEqual(verifyChain(rows), { ok: true });
  const tampered = rows.map((r, i) => (i === 2 ? { ...r, action: "DELETE" } : r));
  assert.equal(verifyChain(tampered).ok, false);
});

test("INV-SEC-02: a patient id from another practice is 404, not 403", async () => {
  const search = await call("GET", "/patients?q=Patel", { token: frontdesk });
  const id = search.body.data[0].id;
  const r = await call("GET", `/patients/${id}`, { token: admin2 });
  assert.equal(r.status, 404);
  const s = await call("GET", "/patients?q=Patel", { token: admin2 });
  assert.equal(s.body.data.length, 0);
});

test("INV-SEC-02: a query without the tenant setting returns zero rows (RLS fails closed)", async () => {
  const { prisma } = await import("../dist/db.js");
  const n = await prisma.patient.count();
  assert.equal(n, 0);
  const users = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "User"`;
  assert.equal(users[0].n, 0);
});

test("x-roles: a front desk token cannot list users (403 and a DENIED audit row)", async () => {
  const r = await call("GET", "/users", { token: frontdesk });
  assert.equal(r.status, 403);
  const denied = await asTenantOf("frontdesk@example.com", (tx) =>
    tx.auditEvent.findFirst({ where: { operationId: "listUsers", outcome: "DENIED" } }),
  );
  assert.ok(denied);
});

test("INV-SEC-04: invited user sets a password, must enrol MFA, then gets recovery codes and a session", async () => {
  const { capturedMessages } = await import("../dist/gateways/messaging/index.js");
  const email = `${unique("new")}@example.com`;
  const invite = await call("POST", "/users/invitations", {
    token: manager,
    body: { name: "New Person", email, roles: ["MA"], locationIds: [] },
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.status, "INVITED");
  await new Promise((r) => setTimeout(r, 50));
  const msg = capturedMessages.sent.find((m) => m.to === email && m.template === "staff-invite");
  assert.ok(msg);
  const token = /invite\/([\w-]+)/.exec(msg.body)[1];
  const info = await call("GET", `/auth/invitations/${token}`);
  assert.equal(info.status, 200);
  const weak = await call("POST", `/auth/invitations/${token}/accept`, {
    body: { password: "password123", acceptTerms: true },
  });
  assert.equal(weak.status, 422);
  const accepted = await call("POST", `/auth/invitations/${token}/accept`, {
    body: { password: "Correct-Horse-Battery-9", acceptTerms: true },
  });
  assert.equal(accepted.status, 200);
  const enrollToken = accepted.body.enrollmentToken;
  // Signing in before enrolment yields only an enrolment token, never a session.
  const login = await call("POST", "/auth/login", {
    body: { email, password: "Correct-Horse-Battery-9" },
  });
  assert.equal(login.body.next, "enroll");
  const start = await call("POST", "/auth/mfa/enrollments", {
    token: enrollToken,
    body: { type: "TOTP" },
  });
  assert.equal(start.status, 200);
  const confirm = await call("POST", `/auth/mfa/enrollments/${start.body.factorId}/confirm`, {
    token: enrollToken,
    body: { code: authenticator.generate(start.body.secretBase32) },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.recoveryCodes.length, 10);
  assert.ok(confirm.body.session.accessToken);
  const me = await call("GET", "/auth/me", { token: confirm.body.session.accessToken });
  assert.equal(me.body.activeRole, "MA");
  // Recovery code signs in once and only once.
  const l2 = await call("POST", "/auth/login", {
    body: { email, password: "Correct-Horse-Battery-9" },
  });
  const rc = confirm.body.recoveryCodes[0];
  assert.equal(
    (
      await call("POST", "/auth/mfa/verify", {
        body: { challengeId: l2.body.challengeId, recoveryCode: rc },
      })
    ).status,
    200,
  );
  const l3 = await call("POST", "/auth/login", {
    body: { email, password: "Correct-Horse-Battery-9" },
  });
  assert.equal(
    (
      await call("POST", "/auth/mfa/verify", {
        body: { challengeId: l3.body.challengeId, recoveryCode: rc },
      })
    ).status,
    401,
  );
});

test("settings cannot weaken mandatory MFA; changing security settings needs step-up", async () => {
  const noStep = await call("PUT", "/settings/security.sessionTimeoutMinutes", {
    token: manager,
    body: { value: 20 },
  });
  assert.equal(noStep.status, 403);
  await stepUp(manager);
  const off = await call("PUT", "/settings/security.mfaRequired", {
    token: manager,
    body: { value: false },
  });
  assert.equal(off.status, 422);
  const ok = await call("PUT", "/settings/security.sessionTimeoutMinutes", {
    token: manager,
    body: { value: 15, reason: "test" },
  });
  assert.equal(ok.status, 200);
});

test("role changes need step-up and end the user's sessions", async () => {
  const users = await call("GET", "/users?q=multi", { token: manager });
  const multi = users.body.data[0];
  const multiToken = await signIn("multi@example.com");
  await stepUp(manager);
  const r = await call("PUT", `/users/${multi.id}/roles`, {
    token: manager,
    body: { roles: ["FRONTDESK", "BILLER"], reason: "test: same roles" },
  });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await call("GET", "/auth/me", { token: multiToken })).status, 401);
});
