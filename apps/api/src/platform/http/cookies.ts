import { getEnv } from "../../env.js";

export const REFRESH_COOKIE = "emr_refresh";
export const PORTAL_REFRESH_COOKIE = "emr_portal_refresh";

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Refresh tokens live only in an httpOnly, SameSite=Strict cookie scoped to the auth paths (SessionTokens DTO). */
export function refreshCookie(
  name: string,
  value: string,
  path: string,
  maxAgeSeconds: number,
): string {
  const secure = getEnv().NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie(name: string, path: string): string {
  return `${name}=; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0`;
}
