// Compiles data/schema.prisma + spec/api/** into api/openapi.yaml (OpenAPI 3.1) and checks API coverage.
//   node tools/build-openapi.mjs          build and check
//   node tools/build-openapi.mjs --check  check only (no write)
// Coverage rules: every screen is served by >=1 operation; every states.yaml transition is performed by >=1 operation;
// every gateway is used by >=1 operation; all ids referenced by operations resolve; Prisma status enums match states.yaml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import internals from "@prisma/internals";
import { loadUi, walkScreen } from "./ui-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = f => fs.readFileSync(path.join(root, f), "utf8");
const ld = f => yaml.load(rd(f));
const checkOnly = process.argv.includes("--check");
const errors = [];
const err = m => errors.push(m);

// ---------------------------------------------------------------- inputs
const dmmf = await internals.getDMMF({ datamodel: rd("data/schema.prisma") });
const models = new Map(dmmf.datamodel.models.map(m => [m.name, m]));
const enums = new Map(dmmf.datamodel.enums.map(e => [e.name, e]));
const params = ld("spec/api/params.yaml");
const dto = ld("spec/api/dto.yaml");
const fhir = ld("spec/api/fhir.yaml");
const { screens } = ld("spec/screens.yaml");
const { roles } = ld("spec/roles.yaml");
const { flows } = ld("spec/flows.yaml");
const { machines } = ld("spec/states.yaml");
const { invariants } = ld("spec/invariants.yaml");
const { gateways } = ld("spec/integrations.yaml");

const routeFiles = fs.readdirSync(path.join(root, "spec/api/routes")).filter(f => f.endsWith(".yaml")).sort();
const tags = [];
const ops = [];
for (const f of routeFiles) {
  const doc = ld(`spec/api/routes/${f}`);
  tags.push({ name: doc.tag, description: doc.description });
  for (const o of doc.ops) ops.push({ ...doc.defaults, ...o, tag: doc.tag, prefix: "/api/v1", file: f });
}

// ---------------------------------------------------------------- schema generation
const schemas = {};
const need = new Set();
const ref = name => { need.add(name); return { $ref: `#/components/schemas/${name}` }; };
const tagsOf = doc => new Set((doc || "").match(/@[a-z-]+/g) || []);
const stripTags = doc => (doc || "").replace(/@(phi|encrypted|secret|server)\b/g, "").replace(/\s+/g, " ").trim();

function scalar(f) {
  const nt = f.nativeType?.[0];
  switch (f.type) {
    case "String": return nt === "Uuid" ? { type: "string", format: "uuid" } : { type: "string" };
    case "Int": return { type: "integer" };
    case "BigInt": return { type: "string", pattern: "^-?\\d+$" };
    case "Float": return { type: "number" };
    case "Decimal": return { type: "string", pattern: "^-?\\d+(\\.\\d+)?$", description: "decimal" };
    case "Boolean": return { type: "boolean" };
    case "DateTime": return nt === "Date" ? { type: "string", format: "date" } : { type: "string", format: "date-time" };
    case "Json": return {};
    case "Bytes": return { type: "string", contentEncoding: "base64" };
    default: return ref(f.type); // enum
  }
}
const isServer = f => {
  const t = tagsOf(f.documentation);
  return t.has("@server") || t.has("@secret") || f.isUpdatedAt || f.isId || f.name === "createdAt" || f.name === "practiceId" || f.name === "version";
};
function modelSchema(name, mode) {
  const m = models.get(name);
  const props = {}, required = [];
  for (const f of m.fields) {
    if (f.kind === "object") continue;
    const t = tagsOf(f.documentation);
    if (t.has("@secret")) continue;
    if (mode !== "read" && isServer(f)) continue;
    if (mode === "update" && (f.name === "patientId" || f.name === "encounterId")) continue; // re-pointing a record to another patient is a merge, not an edit
    let s = scalar(f);
    if (f.isList) s = { type: "array", items: s };
    if (!f.isRequired) s = s.$ref ? { oneOf: [s, { type: "null" }] } : { ...s, type: [s.type ?? "object", "null"].filter(Boolean) };
    const d = stripTags(f.documentation);
    if (d) s.description = d;
    if (t.has("@phi")) s["x-phi"] = true;
    if (t.has("@encrypted")) s["x-encrypted"] = true;
    if (mode === "read" && isServer(f)) s.readOnly = true;
    props[f.name] = s;
    if (mode === "read" ? f.isRequired : mode === "create" && f.isRequired && !f.hasDefaultValue && !f.isList) required.push(f.name);
  }
  const mt = tagsOf(m.documentation);
  const out = { type: "object", properties: props };
  if (required.length) out.required = required;
  const d = stripTags((m.documentation || "").replace(/@(tenant|append-only|versioned|reference)\b|@fhir \w+/g, ""));
  if (d) out.description = d;
  if (mode === "update") out.description = `Merge-patch of ${name}. Send If-Match with the current ETag.`;
  if (mode === "read") {
    const fh = (m.documentation || "").match(/@fhir (\w+)/);
    if (fh) out["x-fhir-resource"] = fh[1];
    if (mt.has("@append-only")) out["x-append-only"] = true;
    if (mt.has("@versioned")) out["x-versioned"] = true;
    if (mt.has("@tenant")) out["x-tenant"] = true;
  }
  return out;
}

// DTO grammar (see header of spec/api/dto.yaml)
const PRIM = {
  string: { type: "string" }, text: { type: "string", maxLength: 20000 }, uuid: { type: "string", format: "uuid" },
  int: { type: "integer" }, number: { type: "number" }, bool: { type: "boolean" },
  money: { type: "string", pattern: "^-?\\d+\\.\\d{2}$", description: "decimal amount, 2 places" },
  date: { type: "string", format: "date" }, datetime: { type: "string", format: "date-time" }, time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
  email: { type: "string", format: "email" }, phone: { type: "string", pattern: "^\\+[1-9]\\d{6,14}$", description: "E.164" },
  uri: { type: "string", format: "uri" }, password: { type: "string", format: "password", writeOnly: true, maxLength: 256 },
  binary: { type: "string", contentEncoding: "base64" }, json: {},
};
function parseType(raw, where) {
  if (raw && typeof raw === "object") return { schema: dtoObject(raw, where), optional: false };
  let s = String(raw).trim(), optional = false, array = false;
  if (s.endsWith("?")) { optional = true; s = s.slice(0, -1); }
  if (s.endsWith("[]")) { array = true; s = s.slice(0, -2); }
  let schema;
  if (s.startsWith("{")) schema = dtoObject(yaml.load(s), where);
  else if (s.startsWith("=")) schema = { const: s.slice(1) };
  else if (s.includes("|")) schema = { type: "string", enum: s.split("|") };
  else if (PRIM[s]) schema = { ...PRIM[s] };
  else if (dto[s] || models.has(s) || enums.has(s) || derived(s)) schema = ref(s);
  else { err(`${where}: unknown type '${s}'`); schema = {}; }
  if (array) schema = { type: "array", items: schema };
  return { schema, optional };
}
function dtoObject(def, where) {
  const props = {}, required = [];
  let out = { type: "object" };
  for (const [k, v] of Object.entries(def)) {
    if (k === "_") { out.description = v; continue; }
    if (k === "_phi") { out["x-phi"] = v; continue; }
    if (k === "_base") continue;
    const { schema, optional } = parseType(v, `${where}.${k}`);
    props[k] = schema;
    if (!optional) required.push(k);
  }
  out.properties = props;
  if (required.length) out.required = required;
  if (def._base) {
    const base = parseType(def._base, `${where}._base`).schema;
    const { description, ...rest } = out;
    out = { allOf: [base, rest] };
    if (description) out.description = description;
  }
  return out;
}
function derived(name) {
  const m = name.match(/^(\w+?)(Create|Update)$/);
  return m && models.has(m[1]) ? m : null;
}
function materialise() {
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of [...need]) {
      if (schemas[n]) continue;
      changed = true;
      if (dto[n]) schemas[n] = dtoObject(dto[n], `dto ${n}`);
      else if (enums.has(n)) schemas[n] = { type: "string", enum: enums.get(n).values.map(v => v.name) };
      else if (models.has(n)) schemas[n] = modelSchema(n, "read");
      else if (derived(n)) { const [, b, k] = derived(n); schemas[n] = modelSchema(b, k.toLowerCase()); }
      else { err(`unresolved schema '${n}'`); schemas[n] = {}; }
    }
  }
}

// ---------------------------------------------------------------- shared components
const shared = {
  Problem: {
    type: "object", description: "RFC 9457 problem details. `code` is stable and machine-readable; `blockers` lists what must be fixed (e.g. sign preflight).",
    required: ["type", "title", "status", "code"],
    properties: {
      type: { type: "string", format: "uri" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" },
      instance: { type: "string" }, code: { type: "string" }, requestId: { type: "string" },
      errors: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
      blockers: { type: "array", items: { type: "object", properties: { code: { type: "string" }, text: { type: "string" }, invariant: { type: "string" } } } },
      allowedTransitions: { type: "array", items: { type: "string" } },
    },
  },
  Accepted: { type: "object", required: ["requestId"], properties: { requestId: { type: "string" }, status: { type: "string", enum: ["accepted", "queued"] } } },
  FhirResource: { type: "object", required: ["resourceType"], properties: { resourceType: { type: "string" }, id: { type: "string" }, meta: { type: "object" } }, additionalProperties: true, description: "FHIR R4 resource (JSON). Validated against the US Core profile named in x-fhir-profile." },
  FhirBundle: { type: "object", required: ["resourceType", "type"], properties: { resourceType: { const: "Bundle" }, type: { type: "string", enum: ["searchset", "history", "collection"] }, total: { type: "integer" }, link: { type: "array", items: { type: "object" } }, entry: { type: "array", items: { type: "object", properties: { fullUrl: { type: "string" }, resource: { $ref: "#/components/schemas/FhirResource" }, search: { type: "object" } } } } }, additionalProperties: true },
  OperationOutcome: { type: "object", required: ["resourceType", "issue"], properties: { resourceType: { const: "OperationOutcome" }, issue: { type: "array", items: { type: "object" } } }, additionalProperties: true },
};
const problemRes = (desc, codes) => ({ description: desc + (codes ? ` Codes: ${codes}.` : ""), content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } });
const responses = {
  BadRequest: problemRes("Malformed request."),
  Unauthorized: problemRes("Missing or expired credentials.", "unauthenticated, session_expired, session_idle_timeout"),
  Forbidden: problemRes("Authenticated but not allowed (role, patient restriction, Part 2 consent, tenant).", "forbidden, restricted_record, step_up_required, mfa_required"),
  NotFound: problemRes("Not found or not visible to the caller (no existence leak)."),
  Conflict: problemRes("State conflict: transition not allowed from the current state, duplicate, or lock held.", "invalid_transition, duplicate, locked, already_signed"),
  PreconditionFailed: problemRes("If-Match does not match the current version (someone else changed it).", "version_mismatch"),
  PreconditionRequired: problemRes("If-Match header missing on an update."),
  Unprocessable: problemRes("Validation or business rule failed; see errors/blockers.", "validation_failed, guard_failed, invariant_blocked"),
  Locked: problemRes("Account locked after repeated failures.", "account_locked"),
  TooManyRequests: { ...problemRes("Rate limited.", "rate_limited"), headers: { "Retry-After": { schema: { type: "integer" } } } },
  BadGateway: problemRes("Integration partner failed or timed out; the action is queued or must be retried.", "integration_unavailable"),
};
const headers = {
  ETag: { description: "Current version of the resource (W/\"<version>\").", schema: { type: "string" } },
  Location: { description: "URL of the created resource or job.", schema: { type: "string" } },
  RequestId: { description: "Correlation id, also recorded on the AuditEvent.", schema: { type: "string" } },
};
const parameters = {
  IfMatch: { name: "If-Match", in: "header", required: true, description: "ETag from the last read (optimistic concurrency).", schema: { type: "string" } },
  IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, description: "Client-generated key; repeats within 24h return the first result (INV-OPS-01).", schema: { type: "string", maxLength: 128 } },
  Cursor: { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque cursor from the previous page's nextCursor." },
  Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  ActingPatient: { name: "X-Emergency-Access", in: "header", required: false, description: "EmergencyAccessGrant id when reading a restricted record under break-glass.", schema: { type: "string", format: "uuid" } },
};
const securitySchemes = {
  staffAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Staff access token (5-15 min) issued only after password + MFA. Refresh token rotates via httpOnly cookie at /auth/token/refresh. Idle and absolute timeouts from practice security settings." },
  enrollmentToken: { type: "http", scheme: "bearer", description: "Short-lived token from acceptInvitation or a login without a factor; valid only for MFA enrolment endpoints." },
  portalAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Patient/proxy access token. Patient scope is enforced per path {patientId} against PortalAccess." },
  smart: {
    type: "oauth2", description: "SMART App Launch 2.0 (patient and user apps, PKCE) and SMART Backend Services (client_credentials + private_key_jwt).",
    flows: {
      authorizationCode: { authorizationUrl: "/oauth2/authorize", tokenUrl: "/oauth2/token", refreshUrl: "/oauth2/token", scopes: { "openid": "OpenID Connect", "fhirUser": "Signed-in user's FHIR resource", "launch/patient": "Patient context at launch", "offline_access": "Refresh token", "patient/*.rs": "Read/search the patient's data", "user/*.rs": "Read/search data the user may access" } },
      clientCredentials: { tokenUrl: "/oauth2/token", scopes: { "system/*.rs": "Backend read/search (Bulk Data)" } },
    },
  },
  webhookSignature: { type: "apiKey", in: "header", name: "X-Signature", description: "HMAC-SHA256 of the raw body with the connection's webhook secret, plus X-Timestamp (5-minute window). Vendor-specific header names are mapped by the adapter." },
  twilioSignature: { type: "apiKey", in: "header", name: "X-Twilio-Signature", description: "Twilio request signature over URL + sorted form params." },
};
const securityFor = o => {
  switch (o.auth) {
    case "none": return [];
    case "staff": return [{ staffAuth: [] }];
    case "portal": return [{ portalAuth: [] }];
    case "staff-or-enrollment": return [{ staffAuth: [] }, { enrollmentToken: [] }];
    case "webhook": return o.integ === "MessagingGateway" && /twilio/.test(o.p) ? [{ twilioSignature: [] }] : [{ webhookSignature: [] }];
    case "smart": return [{ smart: [] }, { staffAuth: [] }, { portalAuth: [] }];
    default: err(`${o.id}: unknown auth '${o.auth}'`); return [];
  }
};

// ---------------------------------------------------------------- operation build
const json = s => ({ "application/json": { schema: s } });
function bodyFor(o) {
  const b = o.body;
  if (!b) return undefined;
  if (b === "multipart") return { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", contentMediaType: "application/octet-stream" }, meta: { type: "string", description: "JSON metadata" } } } } } };
  if (b === "raw") return { required: true, description: "Vendor payload, stored verbatim (encrypted) before processing.", content: { "application/json": { schema: {} }, "application/octet-stream": { schema: { type: "string" } }, "text/plain": { schema: { type: "string" } } } };
  if (b === "form") return { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object", additionalProperties: { type: "string" } } } } };
  const [kind, name] = b.includes(":") ? b.split(":") : ["dto", b];
  if (kind === "create") return { required: true, content: json(ref(`${name}Create`)) };
  if (kind === "update") return { required: true, content: { "application/merge-patch+json": { schema: ref(`${name}Update`) } } };
  if (kind === "list") return { required: true, content: json({ type: "array", items: ref(name) }) };
  return { required: true, content: json(parseType(name, `${o.id}.body`).schema) };
}
function successFor(o) {
  const r = o.res || "none";
  const withHeaders = (res, extra = {}) => ({ ...res, headers: { "X-Request-Id": { $ref: "#/components/headers/RequestId" }, ...extra } });
  if (r === "none") return ["204", withHeaders({ description: "Done." })];
  if (r === "accepted") return ["202", withHeaders({ description: "Accepted for asynchronous processing.", content: json({ $ref: "#/components/schemas/Accepted" }) })];
  if (r === "job") return ["202", withHeaders({ description: "Job started; poll the Location.", content: json(ref("Job")) }, { Location: { $ref: "#/components/headers/Location" } })];
  if (r === "file") return ["200", withHeaders({ description: "File content. Served through the API (never a public URL); Content-Disposition set.", content: { "application/pdf": { schema: { type: "string", contentMediaType: "application/pdf" } }, "application/octet-stream": { schema: { type: "string" } } } })];
  if (r === "redirect") return ["302", { description: "Redirect to the client's redirect_uri (or to sign-in). A 200 HTML page is returned instead when the user must sign in or approve scopes.", headers: { Location: { $ref: "#/components/headers/Location" } } }];
  if (r === "twiml") return ["200", withHeaders({ description: "TwiML reply.", content: { "application/xml": { schema: { type: "string" } } } })];
  const [kind, name] = r.includes(":") ? r.split(":") : ["one", r];
  const one = parseType(name, `${o.id}.res`).schema;
  if (kind === "page") return ["200", withHeaders({ description: "Page of results.", content: json({ type: "object", required: ["data", "hasMore"], properties: { data: { type: "array", items: one }, nextCursor: { type: ["string", "null"] }, hasMore: { type: "boolean" } } }) })];
  if (kind === "list") return ["200", withHeaders({ description: "Results.", content: json({ type: "array", items: one }) })];
  if (kind === "created") return ["201", withHeaders({ description: "Created.", content: json(one) }, { Location: { $ref: "#/components/headers/Location" }, ETag: { $ref: "#/components/headers/ETag" } })];
  return ["200", withHeaders({ description: "OK.", content: json(one) }, models.has(name) ? { ETag: { $ref: "#/components/headers/ETag" } } : {})];
}
const pathParamSchema = n => {
  if (params.path_params[n]) return params.path_params[n];
  if (/Id$/.test(n)) return { schema: { type: "string", format: "uuid" } };
  return null;
};
function buildOperation(o, fullPath) {
  const op = {
    operationId: o.id, summary: o.sum, tags: [o.tag],
    security: securityFor(o),
    parameters: [],
    responses: {},
  };
  for (const n of (fullPath.match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1))) {
    const p = pathParamSchema(n);
    if (!p) err(`${o.id}: path param '${n}' has no schema (add to params.yaml path_params)`);
    if (p?.schema?.$ref) need.add(p.schema.$ref.split("/").pop());
    op.parameters.push({ name: n, in: "path", required: true, ...(p || { schema: { type: "string" } }) });
  }
  for (const n of o.q || []) {
    const p = params.query[n];
    if (!p) { err(`${o.id}: unknown query param '${n}'`); continue; }
    if (p.schema?.$ref) need.add(p.schema.$ref.split("/").pop());
    op.parameters.push({ name: n, in: "query", required: false, ...p });
  }
  if ((o.res || "").startsWith("page:")) op.parameters.push({ $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" });
  if (o.m === "PATCH") op.parameters.push({ $ref: "#/components/parameters/IfMatch" });
  const mutating = o.m !== "GET";
  if (mutating && (o.integ || /payment|pay$/i.test(o.id) || o.auth === "webhook")) op.parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  if (o.phi !== false && o.auth === "staff" && /\{patientId\}/.test(fullPath) && !mutating) op.parameters.push({ $ref: "#/components/parameters/ActingPatient" });
  if (!op.parameters.length) delete op.parameters;
  const body = bodyFor(o);
  if (body) op.requestBody = body;
  const [code, res] = successFor(o);
  op.responses[code] = res;
  if (code === "302") op.responses["200"] = { description: "Sign-in or scope approval page.", content: { "text/html": { schema: { type: "string" } } } };
  const e = new Set(["400"]);
  if (o.auth !== "none") e.add("401").add("403");
  if (o.stepup) e.add("403");
  if (/\{/.test(fullPath)) e.add("404");
  if (o.tr || o.m === "PATCH" || o.m === "PUT") e.add("409");
  if (o.m === "PATCH") e.add("412").add("428");
  if (body) e.add("422");
  if (o.auth === "none" || o.auth === "webhook") e.add("429");
  if (o.integ) e.add("502");
  for (const x of o.errors || []) e.add(String(x));
  const map = { 400: "BadRequest", 401: "Unauthorized", 403: "Forbidden", 404: "NotFound", 409: "Conflict", 412: "PreconditionFailed", 422: "Unprocessable", 423: "Locked", 428: "PreconditionRequired", 429: "TooManyRequests", 502: "BadGateway" };
  for (const c of [...e].sort()) {
    if (!map[c]) { err(`${o.id}: no standard response for ${c}`); continue; }
    op.responses[c] = { $ref: `#/components/responses/${map[c]}` };
  }
  // traceability
  const x = {
    "x-screens": o.screens, "x-flow-steps": o.flows, "x-transitions": o.tr, "x-roles": o.roles,
    "x-audit": o.audit, "x-invariants": o.inv, "x-integration": o.integ, "x-step-up": o.stepup, "x-phi": o.phi,
  };
  for (const [k, v] of Object.entries(x)) if (v !== undefined && !(Array.isArray(v) && !v.length)) op[k] = v;
  if (o.stepup) op.description = `${op.description ? op.description + " " : ""}Requires a recent step-up (auth.step-up); otherwise 403 step_up_required.`;
  if (o.audit) op.description = `${op.description ? op.description + " " : ""}Writes AuditEvent action ${o.audit}.`;
  return op;
}

// ---------------------------------------------------------------- FHIR
const fhirOps = [];
const fhirTag = { name: "FHIR R4", description: `Read-only FHIR ${fhir.version} facade (US Core ${fhir.us_core}) over the relational store. Only ACTIVE (not staged) rows; restricted and Part 2 data filtered by scopes and consent. Every read writes an AuditEvent (QUERY/READ) with the client id.` };
const oauthTag = { name: "OAuth", description: "SMART on FHIR authorization server endpoints." };
for (const [type, r] of Object.entries(fhir.resources)) {
  const base = { auth: "smart", tag: fhirTag.name, phi: type !== "Organization" && type !== "Location" && type !== "Practitioner", audit: "QUERY", prefix: fhir.base, model: r.model, profile: r.profile };
  fhirOps.push({ ...base, id: `fhirSearch${type}`, m: "GET", p: `/${type}`, sum: `Search ${type}`, fhirSearch: r.search, fhirRes: "bundle" });
  fhirOps.push({ ...base, id: `fhirRead${type}`, m: "GET", p: `/${type}/{id}`, sum: `Read ${type}`, audit: "READ", fhirRes: "resource" });
  fhirOps.push({ ...base, id: `fhirVread${type}`, m: "GET", p: `/${type}/{id}/_history/{vid}`, sum: `Read a version of ${type} (ResourceVersion)`, audit: "READ", fhirRes: "resource" });
  fhirOps.push({ ...base, id: `fhirHistory${type}`, m: "GET", p: `/${type}/{id}/_history`, sum: `History of ${type} (ResourceVersion)`, audit: "READ", fhirRes: "history" });
}
for (const o of fhir.operations) fhirOps.push({ auth: "smart", phi: true, ...o, tag: fhirTag.name, prefix: fhir.base, fhirRes: o.id.includes("Capability") ? "resource" : o.id.includes("Smart") ? "json" : o.id.includes("Export") && !o.id.includes("Status") && !o.id.includes("Cancel") ? "kickoff" : o.id.includes("Status") ? "status" : o.id.includes("Cancel") ? "none" : o.id.includes("BulkFile") ? "ndjson" : o.id.includes("Binary") ? "binary" : "bundle" });
for (const o of fhir.oauth) ops.push({ phi: false, ...o, tag: oauthTag.name, prefix: "", file: "fhir.yaml" });

const fhirJson = s => ({ "application/fhir+json": { schema: s } });
function buildFhirOperation(o, fullPath) {
  const op = { operationId: o.id, summary: o.sum, tags: [o.tag], security: securityFor(o), parameters: [], responses: {} };
  for (const n of (fullPath.match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1))) op.parameters.push({ name: n, in: "path", required: true, ...(pathParamSchema(n) || { schema: { type: "string" } }) });
  for (const s of o.fhirSearch || []) op.parameters.push({ name: s, in: "query", required: false, schema: { type: "string" } });
  if (o.fhirSearch) op.parameters.push({ name: "_count", in: "query", schema: { type: "integer" } }, { name: "_include", in: "query", schema: { type: "string" } }, { name: "_revinclude", in: "query", schema: { type: "string" } });
  if (o.fhirRes === "kickoff") op.parameters.push({ name: "Prefer", in: "header", required: true, schema: { const: "respond-async" } }, { name: "_type", in: "query", schema: { type: "string" } }, { name: "_since", in: "query", schema: { type: "string", format: "date-time" } });
  if (!op.parameters.length) delete op.parameters;
  const rs = {
    bundle: ["200", { description: "Bundle.", content: fhirJson({ $ref: "#/components/schemas/FhirBundle" }) }],
    history: ["200", { description: "History bundle.", content: fhirJson({ $ref: "#/components/schemas/FhirBundle" }) }],
    resource: ["200", { description: "Resource.", headers: { ETag: { $ref: "#/components/headers/ETag" } }, content: fhirJson({ $ref: "#/components/schemas/FhirResource" }) }],
    json: ["200", { description: "Discovery document.", content: json({ type: "object", additionalProperties: true }) }],
    kickoff: ["202", { description: "Export started.", headers: { "Content-Location": { schema: { type: "string" }, description: "Status URL" } } }],
    status: ["200", { description: "Complete: manifest. 202 while in progress (X-Progress).", content: json({ type: "object", properties: { transactionTime: { type: "string" }, request: { type: "string" }, requiresAccessToken: { type: "boolean" }, output: { type: "array", items: { type: "object", properties: { type: { type: "string" }, url: { type: "string" } } } }, error: { type: "array", items: { type: "object" } } } }) }],
    none: ["202", { description: "Cancelled." }],
    ndjson: ["200", { description: "NDJSON.", content: { "application/fhir+ndjson": { schema: { type: "string" } } } }],
    binary: ["200", { description: "Binary content.", content: { "application/octet-stream": { schema: { type: "string" } }, "application/fhir+json": { schema: { $ref: "#/components/schemas/FhirResource" } } } }],
  }[o.fhirRes];
  op.responses[rs[0]] = rs[1];
  if (o.fhirRes === "status") op.responses["202"] = { description: "In progress.", headers: { "X-Progress": { schema: { type: "string" } } } };
  const oo = d => ({ description: d, content: fhirJson({ $ref: "#/components/schemas/OperationOutcome" }) });
  op.responses["400"] = oo("Invalid request or search parameter.");
  if (o.auth !== "none") { op.responses["401"] = oo("Missing or invalid token."); op.responses["403"] = oo("Scope or consent does not permit this."); }
  if (/\{/.test(fullPath)) op.responses["404"] = oo("Not found or not visible.");
  if (o.model) op["x-model"] = o.model;
  if (o.profile) op["x-fhir-profile"] = o.profile;
  op["x-audit"] = o.audit || "READ";
  op["x-phi"] = o.phi;
  if (o.screens) op["x-screens"] = o.screens;
  return op;
}

// ---------------------------------------------------------------- assemble
const paths = {};
const seenIds = new Set(), seenRoutes = new Set();
const add = (o, builder) => {
  const full = (o.prefix || "") + o.p;
  if (seenIds.has(o.id)) err(`duplicate operationId ${o.id}`); seenIds.add(o.id);
  const rk = `${o.m} ${full.replace(/\{\w+\}/g, "{}")}`;
  if (seenRoutes.has(rk)) err(`duplicate route ${rk} (${o.id})`); seenRoutes.add(rk);
  paths[full] ??= {};
  const built = builder(o, full);
  const order = ["operationId", "summary", "description", "tags", "security", "parameters", "requestBody", "responses"];
  paths[full][o.m.toLowerCase()] = Object.fromEntries(Object.entries(built).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
};
for (const o of ops) add(o, buildOperation);
for (const o of fhirOps) add(o, buildFhirOperation);
materialise();

// ---------------------------------------------------------------- coverage and reference checks
const screenIds = new Set(screens.map(s => s.id));
const roleIds = new Set(roles.map(r => r.id));
const invIds = new Set(invariants.map(i => i.id));
const gwIds = new Set(gateways.map(g => g.id));
const stepIds = new Set();
for (const f of flows) { stepIds.add(`flow:${f.id}`); for (const s of f.steps) stepIds.add(`flow:${f.id}/${s.id}`); }
const trKeys = new Set();
for (const m of machines) for (const t of m.transitions) for (const f of t.from) trKeys.add(`${m.id}:${f}->${t.to}`);

const servedScreens = new Set(), coveredTr = new Set(), usedGw = new Set();
for (const o of [...ops, ...fhirOps]) {
  const w = `op ${o.id}`;
  for (const s of o.screens || []) { screenIds.has(s) ? servedScreens.add(s) : err(`${w}: unknown screen '${s}'`); }
  for (const r of o.roles || []) roleIds.has(r) || err(`${w}: unknown role '${r}'`);
  for (const i of o.inv || []) invIds.has(i) || err(`${w}: unknown invariant '${i}'`);
  for (const f of o.flows || []) stepIds.has(f) || err(`${w}: unknown flow step '${f}'`);
  for (const t of o.tr || []) { trKeys.has(t) ? coveredTr.add(t) : err(`${w}: unknown transition '${t}'`); }
  if (o.integ) gwIds.has(o.integ) ? usedGw.add(o.integ) : err(`${w}: unknown gateway '${o.integ}'`);
  if (o.audit && !enums.get("AuditAction").values.some(v => v.name === o.audit)) err(`${w}: unknown audit action '${o.audit}'`);
}
for (const s of screenIds) if (!servedScreens.has(s)) err(`screen ${s} is not served by any operation (x-screens)`);
for (const t of trKeys) if (!coveredTr.has(t)) err(`transition ${t} is not performed by any operation (x-transitions)`);
for (const g of gateways) if (g.id && !usedGw.has(g.id)) err(`gateway ${g.id} is not used by any operation (x-integration)`);
// every UI element that performs a transition on screen S has an operation that serves S and performs it
const ui = loadUi(root);
const trByScreen = new Map();
for (const o of [...ops, ...fhirOps]) for (const sc of o.screens || []) for (const t of o.tr || []) {
  if (!trByScreen.has(sc)) trByScreen.set(sc, new Set());
  trByScreen.get(sc).add(t);
}
for (const [sid, s] of Object.entries(ui.screens)) for (const x of walkScreen(sid, s)) {
  if (x.kind !== "el" || !x.el.tr) continue;
  for (const t of [].concat(x.el.tr)) if (!trByScreen.get(sid)?.has(t)) err(`ui ${sid}/${x.el.id}: transition ${t} has no operation serving this screen`);
}
// status enums mirror states.yaml
const enumFor = { appointment: "AppointmentStatus", note: "NoteStatus", order: "OrderStatus", claim: "ClaimStatus", task: "TaskStatus", referral: "ReferralStatus", prescription: "MedicationRequestStatus" };
for (const m of machines) {
  const e = enums.get(enumFor[m.id]);
  if (!e) { err(`machine ${m.id}: no Prisma enum ${enumFor[m.id]}`); continue; }
  const want = m.states.map(s => s.id).filter(s => s !== "new").map(s => s.toUpperCase().replace(/-/g, "_")).sort().join(",");
  const have = e.values.map(v => v.name).sort().join(",");
  if (want !== have) err(`enum ${e.name} [${have}] != states.yaml#${m.id} [${want}]`);
}

if (errors.length) { console.error(errors.map(e => "  - " + e).join("\n")); console.error(`api: ${errors.length} error(s)`); process.exit(1); }

const doc = {
  openapi: "3.1.0",
  info: {
    title: "Clinic EHR API", version: "1.0.0", license: { name: "Proprietary", identifier: "LicenseRef-Proprietary" },
    description: [
      "Generated by tools/build-openapi.mjs from data/schema.prisma and spec/api/**. Do not edit by hand.",
      "",
      "Conventions: JSON over TLS 1.2+; ids are UUIDs; money is a decimal string; dates are ISO 8601 in the practice time zone.",
      "Updates use PATCH with application/merge-patch+json and If-Match (ETag = version). State changes are explicit action endpoints",
      "(x-transitions lists the states.yaml transitions each performs); the server rejects any transition not in states.yaml.",
      "Every operation that reads or writes PHI writes an AuditEvent (x-audit). x-screens and x-flow-steps tie each operation to spec/ui and spec/flows.",
      "Errors are application/problem+json with a stable `code`.",
    ].join("\n"),
  },
  servers: [{ url: "https://{host}", variables: { host: { default: "ehr.example.com" } } }],
  tags: [...tags, oauthTag, fhirTag],
  security: [{ staffAuth: [] }],
  paths,
  components: {
    securitySchemes, parameters, headers, responses,
    schemas: Object.fromEntries([...Object.entries(shared), ...Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))]),
  },
};
const total = ops.length + fhirOps.length;
const summary = `api ok: ${total} operations (${ops.length} app + ${fhirOps.length} FHIR), ${Object.keys(doc.components.schemas).length} schemas; ${servedScreens.size}/${screenIds.size} screens served, ${coveredTr.size}/${trKeys.size} transitions, ${usedGw.size} gateways`;
if (!checkOnly) {
  fs.mkdirSync(path.join(root, "api"), { recursive: true });
  // docs/12-screen-api-map.md: which operations serve each screen
  const { modules } = ld("spec/modules.yaml");
  const byScreen = new Map();
  for (const o of [...ops, ...fhirOps]) for (const sc of o.screens || []) {
    if (!byScreen.has(sc)) byScreen.set(sc, []);
    byScreen.get(sc).push(o);
  }
  const title = new Map(screens.map(s => [s.id, s.name || s.title || s.id]));
  const lines = ["# Screen → API map", "", "Generated by `tools/build-openapi.mjs` from `x-screens` in `api/openapi.yaml`. Do not edit.", "",
    "For each screen: the operations it calls (vendor callbacks that change its data are listed last). `→` marks state transitions, `⚑` step-up, `⇄` an integration gateway.", ""];
  for (const m of modules) {
    lines.push(`## ${m.name || m.id}`, "");
    for (const g of m.groups) for (const sid of g.screens) {
      lines.push(`### \`${sid}\` ${title.get(sid) !== sid ? "— " + title.get(sid) : ""}`.trimEnd(), "");
      const list = (byScreen.get(sid) || []).slice().sort((a, b) => (a.auth === "webhook") - (b.auth === "webhook"));
      for (const o of list) {
        const marks = [o.tr?.length ? `→ ${o.tr.join(", ")}` : "", o.stepup ? "⚑" : "", o.integ ? `⇄ ${o.integ}` : ""].filter(Boolean).join(" ");
        const wh = o.auth === "webhook" ? " _(vendor callback; not called by the UI — updates data this screen shows)_" : "";
        lines.push(`- \`${o.m} ${(o.prefix || "") + o.p}\` ${o.id}${marks ? " — " + marks : ""}${wh}`);
      }
      lines.push("");
    }
  }
  fs.writeFileSync(path.join(root, "docs/12-screen-api-map.md"), lines.join("\n"));
  fs.writeFileSync(path.join(root, "api/openapi.yaml"), "# GENERATED by tools/build-openapi.mjs. Edit spec/api/** or data/schema.prisma, then run npm run api.\n" + yaml.dump(doc, { lineWidth: 140, noRefs: true }));
}
console.log(summary);
