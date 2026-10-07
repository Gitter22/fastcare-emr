import { randomBytes, randomInt } from "node:crypto";
import argon2 from "argon2";
import { authenticator } from "otplib";
import type { MfaFactor, MfaFactorType, Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { messaging } from "../../gateways/messaging/index.js";
import { decryptFromBytes, encryptToBytes } from "../../platform/crypto.js";
import { sha256 } from "../../platform/tokens.js";

/**
 * MfaGateway (built-in): TOTP (RFC 6238, otplib like agile-emr), one-time codes over SMS/email through
 * MessagingGateway, and single-use recovery codes. WebAuthn is not implemented yet (OPEN-Q16): the UI hides it.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
const ISSUER = () => getEnv().APP_NAME;

export function devCodeAccepted(code: string | undefined): boolean {
  const env = getEnv();
  return (
    env.NODE_ENV === "development" && !!env.DEV_STATIC_MFA_CODE && code === env.DEV_STATIC_MFA_CODE
  );
}

export function newTotpSecret(accountName: string): { secret: string; otpauthUri: string } {
  const secret = authenticator.generateSecret();
  return { secret, otpauthUri: authenticator.keyuri(accountName, ISSUER(), secret) };
}

export function verifyTotp(secretCipher: Uint8Array | null, code: string | undefined): boolean {
  if (!code) return false;
  if (devCodeAccepted(code)) return true;
  const secret = decryptFromBytes(secretCipher);
  if (!secret) return false;
  try {
    return authenticator.verify({ token: code.replace(/\s/g, ""), secret });
  } catch {
    return false;
  }
}

export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Sends a one-time code for an SMS/EMAIL factor and returns its hash for MfaChallenge.codeHash. */
export async function sendCode(
  type: MfaFactorType,
  target: string,
  template: "mfa-code" | "portal-code" = "mfa-code",
) {
  const code = sixDigitCode();
  await messaging.send(type === "SMS" ? "SMS" : "EMAIL", target, template, { code });
  return sha256(code);
}

export function codeMatches(codeHash: string | null, code: string | undefined): boolean {
  if (!code) return false;
  if (devCodeAccepted(code)) return true;
  return !!codeHash && sha256(code.trim()) === codeHash;
}

export function maskTarget(
  type: MfaFactorType,
  target: string | null | undefined,
): string | undefined {
  if (!target) return undefined;
  if (type === "SMS") return `•••-•••-${target.replace(/\D/g, "").slice(-4)}`;
  if (type === "EMAIL") {
    const [u, d] = target.split("@");
    return `${(u ?? "").slice(0, 1)}•••@${d ?? ""}`;
  }
  return undefined;
}

export function factorInfo(f: MfaFactor, defaultId: string | null) {
  return {
    id: f.id,
    type: f.type,
    label: f.label ?? labelFor(f.type),
    ...(maskTarget(f.type, f.phone) ? { maskedTarget: maskTarget(f.type, f.phone) } : {}),
    isDefault: f.id === defaultId,
    createdAt: f.createdAt.toISOString(),
    ...(f.lastUsedAt ? { lastUsedAt: f.lastUsedAt.toISOString() } : {}),
  };
}

const labelFor = (t: MfaFactorType) =>
  ({
    TOTP: "Authenticator app",
    SMS: "Text message",
    EMAIL: "Email",
    WEBAUTHN: "Security key",
    PUSH: "Push",
    RECOVERY_CODE: "Recovery codes",
  })[t];

/** Verified, usable sign-in factors (recovery codes are a fallback, not listed as a factor). */
export function usableFactors(factors: MfaFactor[]): MfaFactor[] {
  return factors
    .filter((f) => f.verifiedAt && f.type !== "RECOVERY_CODE")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function issueRecoveryCodes(
  tx: Tx,
  owner: { userId?: string; portalUserId?: string; practiceId?: string | null },
): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => {
    const h = randomBytes(5).toString("hex");
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  const hashes = await Promise.all(codes.map((c) => argon2.hash(c, { type: argon2.argon2id })));
  const where = owner.userId ? { userId: owner.userId } : { portalUserId: owner.portalUserId };
  await tx.mfaFactor.deleteMany({ where: { ...where, type: "RECOVERY_CODE" } });
  await tx.mfaFactor.create({
    data: {
      ...where,
      practiceId: owner.practiceId ?? null,
      type: "RECOVERY_CODE",
      label: "Recovery codes",
      secret: encryptToBytes(JSON.stringify(hashes)),
      verifiedAt: new Date(),
    },
  });
  return codes;
}

/** Consumes a recovery code if it matches; the used hash is removed so it can never be reused. */
export async function consumeRecoveryCode(
  tx: Tx,
  factors: MfaFactor[],
  code: string | undefined,
): Promise<boolean> {
  if (!code) return false;
  const rc = factors.find((f) => f.type === "RECOVERY_CODE");
  if (!rc) return false;
  const hashes = JSON.parse(decryptFromBytes(rc.secret) ?? "[]") as string[];
  for (let i = 0; i < hashes.length; i++) {
    if (await argon2.verify(hashes[i]!, code.trim().toLowerCase()).catch(() => false)) {
      const rest = [...hashes.slice(0, i), ...hashes.slice(i + 1)];
      await tx.mfaFactor.update({
        where: { id: rc.id },
        data: { secret: encryptToBytes(JSON.stringify(rest)), lastUsedAt: new Date() },
      });
      return true;
    }
  }
  return false;
}
