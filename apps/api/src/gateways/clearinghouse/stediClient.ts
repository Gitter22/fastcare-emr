import { getEnv } from "../../env.js";

/**
 * Thin fetch wrapper shared by the Stedi-backed providers (eligibility,
 * clearinghouse claims, ERA retrieval). Vendor-stub convention: call sites
 * depend on the provider interfaces, never on this client.
 *
 * PHI DISCIPLINE: request and response bodies carry PHI (member IDs, names,
 * DOBs, 271/835 contents). Nothing from a body is ever logged or placed in a
 * thrown error's message. StediApiError's `message` carries only the HTTP status
 * and Stedi's error code; Stedi's own validation wording is kept separately in
 * `details` for callers that must show staff why a request was rejected (see the
 * note on that field).
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** One validation problem Stedi reported for a request. */
export interface StediErrorDetail {
  code: string | null;
  description: string;
}

export class StediApiError extends Error {
  /**
   * Stedi's own explanation of what was wrong (e.g. error 33 "Invalid NPI...").
   * Deliberately NOT part of `message`: these descriptions can echo identifiers
   * from the request, so they must never reach logs or audit metadata by
   * accident. Callers that need them (to tell staff why a claim was rejected)
   * read them explicitly and store them only in the tenant's own database.
   */
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly details: StediErrorDetail[] = [],
  ) {
    super(`Stedi request failed (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "StediApiError";
  }
}

/** Pulls Stedi's validation messages out of an error body. Two shapes exist:
 * claim/eligibility validation returns `errors: [{ code, description }]`;
 * request-schema failures return `code: "INVALID_REQUEST_BODY"` plus a
 * `message` that names only the offending field (no values). */
function detailsFrom(body: unknown): StediErrorDetail[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { errors?: unknown; code?: unknown; message?: unknown };
  if (Array.isArray(b.errors)) {
    return b.errors
      .filter((e): e is { code?: unknown; description?: unknown } => !!e && typeof e === "object")
      .map((e) => ({
        code: typeof e.code === "string" ? e.code : null,
        description: typeof e.description === "string" ? e.description : "",
      }))
      .filter((e) => e.description !== "");
  }
  if (b.code === "INVALID_REQUEST_BODY" && typeof b.message === "string") {
    return [{ code: "INVALID_REQUEST_BODY", description: b.message }];
  }
  return [];
}

export class StediUnavailableError extends Error {
  constructor() {
    super("Stedi request failed (network error or timeout)");
    this.name = "StediUnavailableError";
  }
}

export interface StediRequestOptions {
  /** "healthcare" (default) = eligibility/claims/reports; "core" = account-level
   * APIs such as transaction polling, which Stedi hosts separately. */
  api?: "healthcare" | "core";
  method?: "GET" | "POST";
  body?: unknown;
  /** Stedi de-duplicates claim submissions on this key for 24 hours. */
  idempotencyKey?: string;
}

export function isStediConfigured(): boolean {
  return Boolean(getEnv().STEDI_API_KEY);
}

export async function stediRequest<T>(path: string, options: StediRequestOptions = {}): Promise<T> {
  const env = getEnv();
  if (!env.STEDI_API_KEY) {
    throw new Error("STEDI_API_KEY is not configured");
  }

  const headers: Record<string, string> = {
    Authorization: env.STEDI_API_KEY,
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let response: Response;
  try {
    const baseUrl = options.api === "core" ? env.STEDI_CORE_BASE_URL : env.STEDI_BASE_URL;
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new StediUnavailableError();
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const code =
      parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string"
        ? parsed.code
        : null;
    throw new StediApiError(response.status, code, detailsFrom(parsed));
  }
  return parsed as T;
}
