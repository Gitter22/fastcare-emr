import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { getEnv } from "../env.js";
import {
  decryptField,
  decryptOptionalField,
  encryptField,
  encryptOptionalField,
} from "../encryption.js";

/**
 * Helpers on top of encryption.ts (the agile-emr PHI field-encryption model, copied unchanged: AES-256-GCM,
 * `v1:iv:tag:ciphertext`, key PHI_ENCRYPTION_KEY). Same algorithm and key for every encrypted field; these only adapt
 * it to the column types the spec schema uses (Bytes, Json) and add a keyed blind index for search.
 */
export { decryptField, decryptOptionalField, encryptField, encryptOptionalField };

/** For `Bytes` columns tagged @encrypted (SSN, TOTP seed). */
export function encryptToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(encryptField(plaintext), "utf8"));
}

export function decryptFromBytes(stored: Uint8Array | null | undefined): string | null {
  if (!stored) return null;
  return decryptField(Buffer.from(stored).toString("utf8"));
}

/** For `Json` columns tagged @encrypted (ResourceVersion.snapshot): stored as {"enc": "v1:..."}. */
export function encryptJson(value: unknown): { enc: string } {
  return { enc: encryptField(JSON.stringify(value)) };
}

export function decryptJson<T = unknown>(stored: unknown): T | null {
  if (
    stored &&
    typeof stored === "object" &&
    "enc" in stored &&
    typeof (stored as { enc: unknown }).enc === "string"
  ) {
    return JSON.parse(decryptField((stored as { enc: string }).enc)) as T;
  }
  return (stored as T) ?? null;
}

let indexKey: Buffer | undefined;
/**
 * Keyed blind index (HMAC-SHA256) so encrypted phone/email remain searchable by exact value
 * (PatientContactPoint.valueIndex). The index key is derived from PHI_ENCRYPTION_KEY, so no new secret is needed.
 */
export function blindIndex(kind: "phone" | "email", value: string): string {
  if (!indexKey) {
    indexKey = createHash("sha256")
      .update(Buffer.from(getEnv().PHI_ENCRYPTION_KEY, "base64"))
      .update("blind-index-v1")
      .digest();
  }
  return createHmac("sha256", indexKey)
    .update(`${kind}:${normaliseContact(kind, value)}`)
    .digest("hex");
}

export function normaliseContact(kind: "phone" | "email", value: string): string {
  if (kind === "email") return value.trim().toLowerCase();
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * Envelope encryption for files (docs/09-data-model.md#files): each file gets its own AES-256-GCM data key; the data
 * key is wrapped with the master key (PHI_ENCRYPTION_KEY, OPEN-Q12 safe default "single master key from the secret
 * store") and stored in FileObject.wrappedDataKey.
 */
export const MASTER_KEY_ID = "phi-master-v1";

export function newDataKey(): { dataKey: Buffer; wrapped: Uint8Array<ArrayBuffer> } {
  const dataKey = randomBytes(32);
  return {
    dataKey,
    wrapped: new Uint8Array(Buffer.from(encryptField(dataKey.toString("base64")), "utf8")),
  };
}

export function unwrapDataKey(wrapped: Uint8Array): Buffer {
  return Buffer.from(decryptField(Buffer.from(wrapped).toString("utf8")), "base64");
}

/** File body layout: 12-byte IV | 16-byte tag | ciphertext. */
export function encryptBlob(dataKey: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decryptBlob(dataKey: Buffer, blob: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", dataKey, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
