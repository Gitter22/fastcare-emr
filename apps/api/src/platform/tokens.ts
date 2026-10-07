import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "../env.js";

/**
 * Compact HS256 JWTs signed with SESSION_SECRET (the same secret agile-emr uses for sessions; no new env var).
 * Access tokens are short-lived; revocation and idle timeout are enforced per request against Redis + Session.
 */
export type TokenType = "staff" | "portal" | "enroll" | "challenge";

export interface TokenClaims {
  typ: TokenType;
  sub: string;
  /** practice (staff, enrolment) */
  pid?: string;
  /** Session id */
  sid?: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function key(): Buffer {
  return createHash("sha256").update(`jwt:${getEnv().SESSION_SECRET}`).digest();
}

export function signToken(claims: Omit<TokenClaims, "iat" | "exp">, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac("sha256", key()).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

export function verifyToken(token: string, typ: TokenType): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const expected = createHmac("sha256", key()).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return null;
  }
  if (claims.typ !== typ || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/** Opaque random secret (refresh tokens, invitation links, reset links). Only its sha256 is stored. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
