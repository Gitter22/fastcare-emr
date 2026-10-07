/**
 * RFC 9457 problem details with a stable `code` (api/openapi.yaml#/components/schemas/Problem). `detail` never
 * contains PHI (docs/10-hipaa-controls.md, API rule 4).
 */
export interface Blocker {
  code: string;
  message: string;
  /** Screen id (optionally #view) where the blocker is fixed, e.g. "encounter.dx-coding". */
  link?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

const titles: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  412: "Precondition failed",
  422: "Unprocessable",
  423: "Locked",
  428: "Precondition required",
  429: "Too many requests",
  501: "Not implemented",
  502: "Bad gateway",
};

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly extra: { errors?: FieldError[]; blockers?: Blocker[]; [k: string]: unknown } = {},
  ) {
    super(detail ?? code);
  }

  toJSON(requestId?: string) {
    return {
      type: `https://agile-emr/problems/${this.code}`,
      title: titles[this.status] ?? "Error",
      status: this.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(requestId ? { requestId } : {}),
      ...this.extra,
    };
  }
}

export const badRequest = (code = "bad_request", detail?: string) => new Problem(400, code, detail);
export const unauthenticated = (code = "unauthenticated", detail?: string) =>
  new Problem(401, code, detail);
export const forbidden = (code = "forbidden", detail?: string) => new Problem(403, code, detail);
export const notFound = (detail = "Not found or not visible to you.") =>
  new Problem(404, "not_found", detail);
export const conflict = (code: string, detail?: string, extra?: Problem["extra"]) =>
  new Problem(409, code, detail, extra);
export const unprocessable = (code: string, detail?: string, extra?: Problem["extra"]) =>
  new Problem(422, code, detail, extra);
export const validationFailed = (errors: FieldError[], detail = "Some fields need attention.") =>
  new Problem(422, "validation_failed", detail, { errors });
export const invariantBlocked = (blockers: Blocker[], detail = "Fix the listed items first.") =>
  new Problem(422, "invariant_blocked", detail, { blockers });
export const notImplemented = (operationId: string) =>
  new Problem(501, "not_implemented", `Operation ${operationId} is not available yet.`);
export const integrationUnavailable = (
  detail = "The partner system did not respond. The request was queued.",
) => new Problem(502, "integration_unavailable", detail);
