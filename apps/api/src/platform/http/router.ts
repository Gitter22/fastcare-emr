import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Ajv } from "ajv";
import {
  operations,
  roleFromEnum,
  type OperationId,
  type OperationMeta,
  type StaffRoleId,
} from "@agile-emr/shared";
import { prisma, type Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { getRedis } from "../../redis.js";
import { writeAuditEntries, type AuditActor, type AuditEntry } from "../audit.js";
import { Problem, forbidden, notImplemented, unauthenticated } from "../problem.js";
import { STEP_UP_WINDOW_MS, touchSession } from "../sessions.js";
import { verifyToken } from "../tokens.js";
import { implementedOperations } from "./capabilities.js";
import type { BinaryResult, Ctx, HandlerMap, Principal, StaffPrincipal } from "./context.js";

import schemasJson from "../../contracts/schemas.json" with { type: "json" };

const schemas = schemasJson as unknown as {
  definitions: Record<string, unknown>;
  operations: Record<
    string,
    {
      params: object | null;
      querystring: object | null;
      body: object | null;
      response: object | null;
    }
  >;
};

/**
 * Registers every app operation in api/openapi.yaml (via the generated registry) on Fastify. The spec's extensions
 * are enforced here, once, instead of in each handler:
 *   security   -> authentication scheme (staff, enrolment, portal, webhook, public)
 *   x-roles    -> authorisation by the caller's active role (403 + DENIED audit)
 *   x-step-up  -> recent re-authentication (403 step_up_required)
 *   tenancy    -> one transaction per request with app.practice_id set (RLS, INV-SEC-02)
 *   x-audit    -> AuditEvent in the same transaction, before the response is sent (INV-SEC-01)
 *   x-phi      -> no body logging (Fastify logs method, url, status and request id only)
 *   Idempotency-Key -> repeats within 24 h return the first result (INV-OPS-01)
 * Operations without a handler answer 501 not_implemented, so the UI can hide them behind a capability check.
 */
export function registerOperations(
  app: FastifyInstance,
  handlers: HandlerMap,
): { implemented: string[]; missing: string[] } {
  app.addSchema({ $id: "schemas.json", definitions: schemas.definitions });
  const responseAjv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  responseAjv.addSchema({ $id: "schemas.json", definitions: schemas.definitions });

  const implemented: string[] = [];
  const missing: string[] = [];
  for (const op of Object.values(operations) as OperationMeta[]) {
    const handler = handlers[op.id as OperationId] as ((ctx: Ctx) => Promise<unknown>) | undefined;
    (handler ? implemented : missing).push(op.id);
    if (handler) implementedOperations.add(op.id);
    const s = schemas.operations[op.id];
    const url = op.path.replace(/\{(\w+)\}/g, ":$1");
    let validateResponse: ((data: unknown) => boolean) | null = null;
    const checkResponses = getEnv().NODE_ENV !== "production" && s?.response;
    app.route({
      method: op.method,
      url,
      schema: {
        ...(s?.params ? { params: s.params } : {}),
        ...(s?.querystring ? { querystring: s.querystring } : {}),
        ...(s?.body ? { body: s.body } : {}),
      },
      config: { operationId: op.id },
      handler: async (req, reply) => {
        if (!handler) throw notImplemented(op.id);
        if (checkResponses && !validateResponse)
          validateResponse = responseAjv.compile(s.response!);
        return runOperation(op, handler, req, reply, validateResponse);
      },
    });
  }
  return { implemented, missing };
}

async function authenticate(op: OperationMeta, req: FastifyRequest): Promise<Principal | null> {
  if (!op.security.length) return null;
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (op.security.includes("webhookSignature") || op.security.includes("twilioSignature"))
    return null; // handler verifies the signature
  if (!token) throw unauthenticated();

  if (op.security.includes("staffAuth")) {
    const claims = verifyToken(token, "staff");
    if (claims?.sid) {
      const live = await touchSession(claims.sid);
      if (!live || !live.userId || !live.practiceId)
        throw unauthenticated("session_expired", "Your session ended. Sign in again.");
      const roles = live.roles.map(roleFromEnum);
      const role = live.activeRole ? roleFromEnum(live.activeRole) : roles[0];
      if (!role) throw forbidden("forbidden", "Your account has no role.");
      return {
        kind: "staff",
        userId: live.userId,
        practiceId: live.practiceId,
        sessionId: live.sessionId,
        role,
        roles,
        practitionerId: live.practitionerId,
        stepUpAt: live.stepUpAt ? new Date(live.stepUpAt) : null,
      };
    }
  }
  if (op.security.includes("enrollmentToken")) {
    const claims = verifyToken(token, "enroll");
    if (claims?.pid) return { kind: "enrollment", userId: claims.sub, practiceId: claims.pid };
  }
  if (op.security.includes("portalAuth")) {
    const claims = verifyToken(token, "portal");
    if (claims?.sid) {
      const live = await touchSession(claims.sid);
      if (!live || !live.portalUserId)
        throw unauthenticated("session_expired", "Your session ended. Sign in again.");
      return { kind: "portal", portalUserId: live.portalUserId, sessionId: live.sessionId };
    }
  }
  throw unauthenticated();
}

function authorise(op: OperationMeta, principal: Principal | null): void {
  if (!principal || principal.kind !== "staff" || !op.roles) return;
  if (!op.roles.includes(principal.role)) {
    throw forbidden("forbidden", "Your role cannot do this.");
  }
}

function actorFor(
  principal: Principal | null,
  practiceId: string | null,
  req: FastifyRequest,
): AuditActor {
  const base = {
    ip: req.ip ?? null,
    userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 300) ?? null,
  };
  if (!principal)
    return {
      practiceId,
      actorType: "system",
      actorId: null,
      actorRole: null,
      sessionId: null,
      ...base,
    };
  if (principal.kind === "staff")
    return {
      practiceId,
      actorType: "staff",
      actorId: principal.userId,
      actorRole: principal.role.toUpperCase() as AuditActor["actorRole"],
      sessionId: principal.sessionId,
      ...base,
    };
  if (principal.kind === "portal")
    return {
      practiceId,
      actorType: "portal",
      actorId: principal.portalUserId,
      actorRole: null,
      sessionId: principal.sessionId,
      ...base,
    };
  return {
    practiceId,
    actorType: "staff",
    actorId: principal.userId,
    actorRole: null,
    sessionId: null,
    ...base,
  };
}

const ETAG_RE = /^(?:W\/)?"?(\d+)"?$/;

async function runOperation(
  op: OperationMeta,
  handler: (ctx: Ctx) => Promise<unknown>,
  req: FastifyRequest,
  reply: FastifyReply,
  validateResponse: ((data: unknown) => boolean) | null,
): Promise<unknown> {
  const requestId =
    (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) || randomUUID();
  reply.header("X-Request-Id", requestId);
  if (op.phi) reply.header("Cache-Control", "no-store");

  const principal = await authenticate(op, req).catch(async (e) => {
    throw e;
  });
  const practiceId = principal && principal.kind !== "portal" ? principal.practiceId : null;

  try {
    authorise(op, principal);
    if (op.stepUp === true) requireStepUp(principal);
  } catch (e) {
    if (e instanceof Problem && practiceId) {
      // Denied attempts are audited too (INV-SEC-01).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`;
        await writeAuditEntries(tx, actorFor(principal, practiceId, req), [
          {
            action: (op.audit as AuditEntry["action"]) ?? "READ",
            outcome: "DENIED",
            operationId: op.id,
            detail: { code: e.code },
          },
        ]);
      });
    }
    throw e;
  }

  // Idempotent replays (INV-OPS-01).
  const idemKey =
    req.method === "POST" ? (req.headers["idempotency-key"] as string | undefined) : undefined;
  const idemRedisKey = idemKey
    ? `idem:${principal ? ("userId" in principal ? principal.userId : principal.portalUserId) : "anon"}:${op.id}:${idemKey.slice(0, 128)}`
    : null;
  if (idemRedisKey) {
    const prior = await getRedis().get(idemRedisKey);
    if (prior) {
      const { status, body } = JSON.parse(prior) as { status: number; body: unknown };
      reply.header("Idempotent-Replay", "true");
      return reply.code(status).send(body);
    }
  }

  const failureWork: Array<(tx: Tx) => Promise<void>> = [];
  const afterCommit: Array<() => Promise<void>> = [];
  let status = op.successStatus;
  const extraHeaders: Record<string, string> = {};
  let boundPractice: string | null = practiceId;

  let file: Ctx["file"] = null;
  if (op.bodyMedia === "multipart/form-data" && req.isMultipart()) {
    const fields: Record<string, string> = {};
    let data: Buffer | null = null;
    let fileName = "upload";
    let contentType = "application/octet-stream";
    for await (const part of req.parts()) {
      if (part.type === "file") {
        data = await part.toBuffer();
        fileName = part.filename;
        contentType = part.mimetype;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (data) file = { fileName, contentType, data, fields };
  }

  const auditState: {
    patientId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    detail?: Record<string, unknown>;
    purpose?: string;
    emergencyAccessId?: string | null;
    suppressed: boolean;
    extra: AuditEntry[];
    actor?: { actorType: "staff" | "portal"; actorId: string; sessionId: string | null };
  } = { suppressed: false, extra: [] };

  const params = (req.params ?? {}) as Record<string, string>;
  const run = async (tx: Tx) => {
    if (boundPractice)
      await tx.$executeRaw`SELECT set_config('app.practice_id', ${boundPractice}, true)`;
    const ctx: Ctx = {
      op,
      requestId,
      ip: req.ip ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      principal,
      practiceId: boundPractice,
      db: tx,
      params: params as never,
      query: (req.query ?? {}) as never,
      body: (file ? file.fields : req.body) as never,
      headers: req.headers as Record<string, string | undefined>,
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody ?? null,
      file,
      async bindTenant(pid: string) {
        boundPractice = pid;
        ctx.practiceId = pid;
        await tx.$executeRaw`SELECT set_config('app.practice_id', ${pid}, true)`;
      },
      audit: {
        patient: (id) => void (auditState.patientId = id ?? null),
        resource: (type, id) => {
          auditState.resourceType = type;
          auditState.resourceId = id ?? null;
        },
        detail: (d) => void (auditState.detail = { ...auditState.detail, ...d }),
        purpose: (p, ea) => {
          auditState.purpose = p;
          auditState.emergencyAccessId = ea ?? null;
        },
        add: (e) => void auditState.extra.push({ operationId: op.id, ...e }),
        suppressDefault: () => void (auditState.suppressed = true),
        actor: (actorType, actorId, sessionId) =>
          void (auditState.actor = { actorType, actorId, sessionId: sessionId ?? null }),
      },
      onFailure: (fn) => void failureWork.push(fn),
      afterCommit: (fn) => void afterCommit.push(fn),
      ifMatch() {
        const h = req.headers["if-match"] as string | undefined;
        if (!h)
          throw new Problem(
            428,
            "precondition_required",
            "Send If-Match with the version you last read.",
          );
        const m = ETAG_RE.exec(h.trim());
        if (!m) throw new Problem(400, "bad_request", "If-Match is not a version.");
        return Number(m[1]);
      },
      checkVersion(current: number, given?: number) {
        const expected = given ?? ctx.ifMatch();
        if (expected !== current)
          throw new Problem(
            412,
            "version_mismatch",
            "Someone else changed this record. Reload and try again.",
            { currentVersion: current },
          );
      },
      requireStepUp: () => requireStepUp(principal),
      setHeader: (n, v) => void (extraHeaders[n] = v),
      setStatus: (s) => void (status = s),
      staff() {
        if (principal?.kind !== "staff") throw forbidden();
        return principal;
      },
      portal() {
        if (principal?.kind !== "portal") throw forbidden();
        return principal;
      },
    };
    // Default patient for the audit row: the {patientId} path parameter.
    if (params.patientId) auditState.patientId = params.patientId;

    const result = await handler(ctx);

    const entries: AuditEntry[] = [...auditState.extra];
    if (op.audit && !auditState.suppressed) {
      entries.unshift({
        action: op.audit as AuditEntry["action"],
        operationId: op.id,
        patientId: auditState.patientId ?? null,
        resourceType: auditState.resourceType ?? null,
        resourceId: auditState.resourceId ?? firstIdParam(params),
        purposeOfUse: auditState.purpose ?? null,
        emergencyAccessId: auditState.emergencyAccessId ?? null,
        detail: auditState.detail ?? null,
      });
    }
    const actor = actorFor(principal, boundPractice, req);
    if (auditState.actor) Object.assign(actor, auditState.actor);
    await writeAuditEntries(tx, actor, entries);
    return result;
  };

  let result: unknown;
  try {
    result = await prisma.$transaction((tx) => run(tx), { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (failureWork.length) {
      await prisma
        .$transaction(async (tx) => {
          if (boundPractice)
            await tx.$executeRaw`SELECT set_config('app.practice_id', ${boundPractice}, true)`;
          for (const fn of failureWork) await fn(tx);
        })
        .catch((err) =>
          req.log.error({ err, operationId: op.id, requestId }, "failure bookkeeping failed"),
        );
    }
    throw e;
  }

  for (const fn of afterCommit) {
    await fn().catch((err) =>
      req.log.error({ err, operationId: op.id, requestId }, "after-commit task failed"),
    );
  }

  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);

  if (result && typeof result === "object" && (result as BinaryResult).__binary) {
    const b = result as BinaryResult;
    reply.header("Content-Type", b.contentType);
    reply.header("Cache-Control", "no-store");
    if (b.fileName)
      reply.header(
        "Content-Disposition",
        `${b.inline ? "inline" : "attachment"}; filename="${b.fileName.replace(/[^\w.\- ]/g, "_")}"`,
      );
    return reply.code(status).send(b.body);
  }

  if (status === 204 || op.responseType === "none")
    return reply.code(status === 200 ? 204 : status).send();

  if (
    req.method === "GET" &&
    result &&
    typeof result === "object" &&
    typeof (result as { version?: unknown }).version === "number"
  ) {
    reply.header("ETag", `W/"${(result as { version: number }).version}"`);
  }

  if (validateResponse && !validateResponse(result)) {
    const errs =
      (
        validateResponse as unknown as {
          errors?: Array<{ instancePath: string; message?: string }>;
        }
      ).errors ?? [];
    // Paths and messages only, never values (no PHI in logs).
    req.log.warn(
      { operationId: op.id, errors: errs.slice(0, 5).map((e) => `${e.instancePath} ${e.message}`) },
      "response does not match api/openapi.yaml",
    );
    if (getEnv().NODE_ENV === "test")
      throw new Problem(
        500,
        "response_contract",
        `${op.id}: ${errs
          .slice(0, 3)
          .map((e) => `${e.instancePath} ${e.message}`)
          .join("; ")}`,
      );
  }

  if (idemRedisKey) {
    await getRedis().set(idemRedisKey, JSON.stringify({ status, body: result }), "EX", 24 * 3600);
  }
  return reply.code(status).send(result);
}

function requireStepUp(principal: Principal | null): void {
  const p = principal as StaffPrincipal | null;
  if (!p || p.kind !== "staff")
    throw forbidden("step_up_required", "Confirm your identity to continue.");
  if (!p.stepUpAt || Date.now() - p.stepUpAt.getTime() > STEP_UP_WINDOW_MS) {
    throw forbidden("step_up_required", "Confirm your identity to continue.");
  }
}

function firstIdParam(params: Record<string, string>): string | null {
  const keys = Object.keys(params).filter((k) => k.endsWith("Id") && k !== "patientId");
  return keys.length ? (params[keys[keys.length - 1]!] ?? null) : null;
}

export type { StaffRoleId };
