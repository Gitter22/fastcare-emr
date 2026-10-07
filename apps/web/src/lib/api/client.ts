import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import {
  operations,
  type OperationId,
  type OperationMeta,
  type OperationTypes,
} from "@agile-emr/shared";

/**
 * Typed client generated from the spec's operation registry (docs/ehr-spec/CLAUDE.md: "generate a typed client from
 * api/openapi.yaml; do not hand-write fetch calls"). One function, `api(operationId, args)`, types params, query,
 * body and response from OperationTypes.
 *
 * Tokens: the access token lives in memory only; the refresh token is an httpOnly cookie the browser sends to
 * /api/v1/auth/token/refresh. On 401 the client refreshes once and retries; on 403 step_up_required it asks the
 * step-up dialog (auth.step-up) to re-authenticate, then retries.
 */
type Has<T> = [T] extends [never] ? false : true;
type Opt<K extends string, T> =
  Has<T> extends true ? ({} extends T ? { [P in K]?: T } : { [P in K]: T }) : { [P in K]?: never };

export type CallArgs<Id extends OperationId> = Opt<"params", OperationTypes[Id]["params"]> &
  Opt<"query", OperationTypes[Id]["query"]> &
  Opt<"body", OperationTypes[Id]["body"]> & {
    /** Version for If-Match on PATCH (ETag). */
    version?: number;
    headers?: Record<string, string>;
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export type ApiResponse<Id extends OperationId> = OperationTypes[Id]["response"];

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: Array<{ field: string; code: string; message: string }>;
  blockers?: Array<{
    code: string;
    message: string;
    link?: string;
    resourceType?: string;
    resourceId?: string;
  }>;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title ?? problem.code);
    this.status = status;
    this.problem = problem;
  }
  get code() {
    return this.problem.code;
  }
}

const http = axios.create({ withCredentials: true });

const tokens: { staff: string | null; portal: string | null; enrollment: string | null } = {
  staff: null,
  portal: null,
  enrollment: null,
};
export const tokenStore = {
  set(kind: keyof typeof tokens, t: string | null) {
    tokens[kind] = t;
  },
  get(kind: keyof typeof tokens) {
    return tokens[kind];
  },
};

type Hooks = {
  onSessionEnded?: (scheme: "staff" | "portal") => void;
  onStepUpRequired?: (purpose: string) => Promise<boolean>;
};
const hooks: Hooks = {};
export function setApiHooks(h: Hooks) {
  Object.assign(hooks, h);
}

function buildPath(op: OperationMeta, params: Record<string, string> | undefined): string {
  return op.path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`${op.id}: missing path parameter ${k}`);
    return encodeURIComponent(v);
  });
}

function schemeFor(op: OperationMeta): "staff" | "portal" | "enrollment" | null {
  if (op.security.includes("staffAuth"))
    return tokens.staff || !op.security.includes("enrollmentToken") ? "staff" : "enrollment";
  if (op.security.includes("enrollmentToken")) return "enrollment";
  if (op.security.includes("portalAuth")) return "portal";
  return null;
}

let refreshing: Record<string, Promise<boolean> | undefined> = {};
async function refresh(scheme: "staff" | "portal"): Promise<boolean> {
  refreshing[scheme] ??= (async () => {
    try {
      const url =
        scheme === "staff" ? "/api/v1/auth/token/refresh" : "/api/v1/portal/auth/token/refresh";
      const r = await http.post(url, {});
      tokens[scheme] = r.data.accessToken;
      return true;
    } catch {
      tokens[scheme] = null;
      return false;
    } finally {
      setTimeout(() => (refreshing = { ...refreshing, [scheme]: undefined }), 0);
    }
  })();
  return refreshing[scheme]!;
}

export async function tryRestoreSession(scheme: "staff" | "portal"): Promise<boolean> {
  if (tokens[scheme]) return true;
  return refresh(scheme);
}

function toProblem(e: AxiosError): Problem {
  const d = e.response?.data as Partial<Problem> | undefined;
  if (d && typeof d === "object" && "code" in d)
    return { status: e.response!.status, ...d } as Problem;
  if (!e.response)
    return {
      status: 0,
      code: "network_error",
      detail: "You appear to be offline. Check your connection.",
    };
  return {
    status: e.response.status,
    code: "http_error",
    detail: "Something went wrong. Try again.",
  };
}

export async function api<Id extends OperationId>(
  id: Id,
  args: CallArgs<Id> = {} as CallArgs<Id>,
): Promise<ApiResponse<Id>> {
  const op = operations[id] as OperationMeta;
  const a = args as CallArgs<Id> & {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  };
  const scheme = schemeFor(op);
  const exec = async (): Promise<ApiResponse<Id>> => {
    const headers: Record<string, string> = { ...(a.headers ?? {}) };
    const tok = scheme ? tokens[scheme] : null;
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (a.version !== undefined && op.method === "PATCH") headers["If-Match"] = `W/"${a.version}"`;
    if (a.idempotencyKey) headers["Idempotency-Key"] = a.idempotencyKey;
    let data: unknown = a.body;
    if (op.bodyMedia === "application/merge-patch+json")
      headers["Content-Type"] = "application/merge-patch+json";
    if (op.bodyMedia === "multipart/form-data" && a.body && !(a.body instanceof FormData)) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(a.body as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        fd.append(k, v instanceof Blob ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      data = fd;
    }
    const config: AxiosRequestConfig = {
      method: op.method,
      url: buildPath(op, a.params),
      params: a.query,
      paramsSerializer: { indexes: null },
      data,
      headers,
      signal: a.signal,
      responseType: op.responseType === "binary" ? "blob" : "json",
    };
    const r = await http.request(config);
    return (op.responseType === "none" ? undefined : r.data) as ApiResponse<Id>;
  };

  try {
    return await exec();
  } catch (err) {
    const e = err as AxiosError;
    let problem = toProblem(e);
    if (
      problem.status === 401 &&
      (scheme === "staff" || scheme === "portal") &&
      !op.path.includes("/auth/")
    ) {
      if (await refresh(scheme)) {
        try {
          return await exec();
        } catch (e2) {
          problem = toProblem(e2 as AxiosError);
        }
      }
      if (problem.status === 401) hooks.onSessionEnded?.(scheme);
    }
    if (problem.status === 403 && problem.code === "step_up_required" && hooks.onStepUpRequired) {
      if (await hooks.onStepUpRequired(op.summary)) return exec();
    }
    throw new ApiError(problem.status, problem);
  }
}

/** Human message for a failed call (what happened + what to do; Pine copy rule 11). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.problem.detail) return e.problem.detail;
    if (e.status === 403) return "Your role can't do this.";
    if (e.status === 404) return "This record no longer exists or you can't see it.";
    if (e.status === 409) return "Someone else changed this. Reload and try again.";
  }
  return "Something went wrong. Try again.";
}
