import { test, after } from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";
import { PASSWORD, TOTP_SECRET, asTenantOf, call, closeApp, signIn } from "./helpers.mjs";

after(closeApp);

test("INV-SEC-04: password alone never yields a session; MFA is required", async () => {
  const login = await call("POST", "/auth/login", {
    body: { email: "frontdesk@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.next, "mfa");
  assert.ok(login.body.challengeId);
  assert.equal(login.body.accessToken, undefined);
  const me = await call("GET", "/auth/me", { token: "not-a-token" });
  assert.equal(me.status, 401);
});

test("wrong password is 401 invalid_credentials and is audited as LOGIN_FAILED", async () => {
  const r = await call("POST", "/auth/login", {
    body: { email: "ma@example.com", password: "wrong-password-123" },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "invalid_credentials");
  const rows = await asTenantOf(
    "ma@example.com",
    (tx) =>
      tx.$queryRaw`SELECT count(*)::int AS n FROM "AuditEvent" WHERE action = 'LOGIN_FAILED' AND "operationId" = 'login'`,
  );
  assert.ok(rows[0].n >= 1);
  // Reset the counter so the shared seed user does not lock across runs.
  await signIn("ma@example.com");
});

test("unknown email gives the same 401 as a wrong password", async () => {
  const r = await call("POST", "/auth/login", {
    body: { email: "nobody@example.com", password: "whatever-123456" },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "invalid_credentials");
});

test("wrong MFA code is rejected; correct TOTP starts a session with a refresh cookie", async () => {
  const login = await call("POST", "/auth/login", {
    body: { email: "provider@example.com", password: PASSWORD },
  });
  const bad = await call("POST", "/auth/mfa/verify", {
    body: { challengeId: login.body.challengeId, code: "000000" },
  });
  assert.equal(bad.status, 401);
  const ok = await call("POST", "/auth/mfa/verify", {
    body: { challengeId: login.body.challengeId, code: authenticator.generate(TOTP_SECRET) },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken);
  assert.match(String(ok.headers["set-cookie"]), /emr_refresh=.*HttpOnly; SameSite=Strict/);
  const me = await call("GET", "/auth/me", { token: ok.body.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.activeRole, "PROVIDER");
  assert.equal(me.body.homeScreen, "home.provider-worklist");
  assert.equal(me.body.canSign.notes, true);
});

test("logout revokes the session immediately", async () => {
  const token = await signIn("biller@example.com");
  assert.equal((await call("GET", "/auth/me", { token })).status, 200);
  assert.equal((await call("POST", "/auth/logout", { token })).status, 204);
  const after = await call("GET", "/auth/me", { token });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, "session_expired");
});

test("role switching: only held roles, and authorisation follows the active role", async () => {
  const token = await signIn("multi@example.com");
  const bad = await call("POST", "/auth/me/active-role", { token, body: { role: "PROVIDER" } });
  assert.equal(bad.status, 403);
  const ok = await call("POST", "/auth/me/active-role", { token, body: { role: "BILLER" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activeRole, "BILLER");
});
