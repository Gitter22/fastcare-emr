import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { getEnv } from "./env.js";
import { handlers } from "./modules/index.js";
import { registerOperations } from "./platform/http/router.js";
import { Problem } from "./platform/problem.js";

/**
 * Builds the Fastify app without starting the listener, so tests can inject requests without binding a port.
 * Every route comes from the spec's operation registry (platform/http/router.ts).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level:
        getEnv().NODE_ENV === "production"
          ? "info"
          : getEnv().NODE_ENV === "test"
            ? "warn"
            : "debug",
      // Never log credentials or bodies (x-phi operations, docs/10-hipaa-controls.md rule 3). Fastify's default
      // request log has method, url, status and request id only; these headers are the remaining risk.
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
    ajv: {
      customOptions: {
        strict: false,
        coerceTypes: "array",
        removeAdditional: true,
        allErrors: true,
      },
    },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: getEnv().NODE_ENV === "production" ? false : true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  // Keep the raw body for webhook signature verification; parse JSON and merge-patch JSON the same way.
  const jsonParser = (
    req: unknown,
    body: Buffer,
    done: (err: Error | null, value?: unknown) => void,
  ) => {
    (req as { rawBody?: Buffer }).rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch {
      done(new Problem(400, "bad_request", "The request body is not valid JSON."));
    }
  };
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, jsonParser);
  app.addContentTypeParser("application/merge-patch+json", { parseAs: "buffer" }, jsonParser);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as { rawBody?: Buffer }).rawBody = body as Buffer;
      done(null, Object.fromEntries(new URLSearchParams((body as Buffer).toString("utf8"))));
    },
  );
  for (const t of [
    "application/xml",
    "text/plain",
    "application/octet-stream",
    "application/edi-x12",
    "x-application/hl7-v2+er7",
  ]) {
    app.addContentTypeParser(t, { parseAs: "buffer" }, (req, body, done) => {
      (req as { rawBody?: Buffer }).rawBody = body as Buffer;
      done(null, {});
    });
  }

  app.setErrorHandler((err: FastifyError | Problem, req, reply) => {
    const requestId = (reply.getHeader("X-Request-Id") as string | undefined) ?? req.id;
    if (err instanceof Problem) {
      if (err.status >= 500 && err.status !== 501) req.log.error({ err, requestId }, err.code);
      return reply.code(err.status).type("application/problem+json").send(err.toJSON(requestId));
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      const errors = fe.validation.map((v) => ({
        field: `${fe.validationContext ?? "body"}${v.instancePath.replace(/\//g, ".")}${
          (v.params as { missingProperty?: string }).missingProperty
            ? `.${(v.params as { missingProperty: string }).missingProperty}`
            : ""
        }`,
        code: v.keyword,
        message: v.message ?? "invalid",
      }));
      return reply
        .code(422)
        .type("application/problem+json")
        .send(
          new Problem(422, "validation_failed", "Some fields need attention.", { errors }).toJSON(
            requestId,
          ),
        );
    }
    if (fe.statusCode === 429) {
      return reply
        .code(429)
        .type("application/problem+json")
        .send(
          new Problem(429, "rate_limited", "Too many requests. Wait a moment.").toJSON(requestId),
        );
    }
    if (fe.statusCode && fe.statusCode < 500) {
      return reply
        .code(fe.statusCode)
        .type("application/problem+json")
        .send(
          new Problem(fe.statusCode, "bad_request", "The request could not be read.").toJSON(
            requestId,
          ),
        );
    }
    // Unknown errors: log the error object (no request body), answer without detail.
    req.log.error({ err, requestId }, "unhandled error");
    return reply
      .code(500)
      .type("application/problem+json")
      .send(
        new Problem(500, "internal_error", "Something went wrong. Try again.").toJSON(requestId),
      );
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .type("application/problem+json")
      .send(new Problem(404, "not_found", "No such endpoint.").toJSON(req.id));
  });

  const { implemented, missing } = registerOperations(app, handlers);
  app.log.info(
    { implemented: implemented.length, missing: missing.length },
    "operations registered",
  );
  return app;
}
