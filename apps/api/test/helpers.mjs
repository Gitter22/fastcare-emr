// Test harness: builds the app (dist) in NODE_ENV=test against the local database from the repo .env, and signs in
// seeded users (prisma/seed.ts) with the documented fixed TOTP secret.
import { readFileSync } from "node:fs";
import { authenticator } from "otplib";

const envFile = new URL("../../../.env", import.meta.url);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
process.env.NODE_ENV = "test";

export const PASSWORD = "TestPassword123!";
export const TOTP_SECRET = "MIPW6N3DPZVXGHJ7";

let appPromise;
export async function getApp() {
  appPromise ??= import("../dist/app.js").then((m) => m.buildApp());
  return appPromise;
}

export async function closeApp() {
  if (!appPromise) return;
  const app = await appPromise;
  await app.close();
  const { prisma } = await import("../dist/db.js");
  await prisma.$disconnect();
  const { getRedis } = await import("../dist/redis.js");
  getRedis().disconnect();
}

export async function call(method, url, { token, body, headers = {} } = {}) {
  const app = await getApp();
  const res = await app.inject({
    method,
    url: url.startsWith("/api") ? url : `/api/v1${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, body: json, headers: res.headers, raw: res };
}

/** Full sign-in (password + TOTP). Returns the access token. */
export async function signIn(email, { role } = {}) {
  const login = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login ${email}: ${login.status} ${JSON.stringify(login.body)}`);
  const verify = await call("POST", "/auth/mfa/verify", {
    body: { challengeId: login.body.challengeId, factorId: login.body.defaultFactorId, code: authenticator.generate(TOTP_SECRET) },
  });
  if (verify.status !== 200) throw new Error(`mfa ${email}: ${verify.status} ${JSON.stringify(verify.body)}`);
  let token = verify.body.accessToken;
  if (role) {
    const sw = await call("POST", "/auth/me/active-role", { token, body: { role } });
    if (sw.status !== 200) throw new Error(`switch role: ${sw.status}`);
  }
  return token;
}

/** Re-authenticate (step-up) for x-step-up operations. */
export async function stepUp(token) {
  const r = await call("POST", "/auth/step-up", { token, body: { password: PASSWORD, code: authenticator.generate(TOTP_SECRET), purpose: "test" } });
  if (r.status !== 200) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
}

export const unique = (p = "t") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Run fn(tx) as the app role inside the tenant of a seeded user (RLS applies, like a request). */
export async function asTenantOf(email, fn) {
  const { prisma } = await import("../dist/db.js");
  const { withTenant } = await import("../dist/platform/tenant.js");
  const rows = await prisma.$queryRaw`SELECT "practiceId" FROM find_staff_users_for_login(${email})`;
  return withTenant(rows[0].practiceId, fn);
}

const NIL = "00000000-0000-0000-0000-000000000000";
/** A registration body for a distinct, fictional person (random name, DOB and phone so duplicate checks pass). */
export function newPatientBody(extra = {}) {
  const r = (n) => Math.floor(Math.random() * n);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const word = (n) => Array.from({ length: n }, () => letters[r(26)]).join("");
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const dob = `${1940 + r(70)}-${String(1 + r(12)).padStart(2, "0")}-${String(1 + r(28)).padStart(2, "0")}`;
  const phone = `312-${String(200 + r(700))}-${String(r(10000)).padStart(4, "0")}`;
  const { patient, ...rest } = extra;
  return {
    patient: { firstName: cap(word(6)), lastName: cap(word(8)), birthDate: dob, administrativeGender: r(2) ? "FEMALE" : "MALE", ...(patient ?? {}) },
    contactPoints: [{ patientId: NIL, system: "PHONE", use: "MOBILE", value: phone }],
    ...rest,
  };
}
