import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "./env.js";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;

let cachedKey: Buffer | undefined;

function getPhiKey(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(getEnv().PHI_ENCRYPTION_KEY, "base64");
  }
  return cachedKey;
}

export function isEncryptedField(stored: string): boolean {
  return stored.startsWith(`${VERSION}:`);
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getPhiKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptField(stored: string): string {
  if (!isEncryptedField(stored)) {
    return stored;
  }

  const [version, ivBase64, authTagBase64, ciphertextBase64] = stored.split(":");
  if (version !== VERSION || !ivBase64 || !authTagBase64 || !ciphertextBase64) {
    throw new Error("Invalid encrypted field format");
  }

  const decipher = createDecipheriv(ALGORITHM, getPhiKey(), Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptOptionalField(
  plaintext: string | null | undefined,
): string | null | undefined {
  // An empty string is skipped, not encrypted: AES-GCM's ciphertext for
  // zero-length plaintext is itself zero-length, which round-trips back
  // through decryptField's "did every segment parse" check as falsy and
  // throws -- storing "" verbatim avoids ever producing that unparseable
  // shape (BUG-07: clearing an encrypted field like phone back to blank
  // via a demographics edit is what first surfaced this).
  return plaintext ? encryptField(plaintext) : plaintext;
}

export function decryptOptionalField(stored: string | null | undefined): string | null | undefined {
  return stored == null ? stored : decryptField(stored);
}
