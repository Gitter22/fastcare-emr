import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../env.js";
import { comp, parseMessage } from "./hl7.js";

export * from "./hl7.js";
export { fakeOru, flagFor, analytesFor, type FakeOrder, type FakeResultOptions } from "./fake.js";

/**
 * LabGateway (spec/integrations.yaml): orders out as HL7 v2 ORM, results in as ORU through `labWebhook`.
 * Health Gorilla / Quest / LabCorp are not contracted yet (OPEN-Q2), so the only implementation is the simulated
 * lab, and it is connected only outside production. In production with no vendor, `labGateway()` is null: orders are
 * signed and queued, requisitions print, and the UI shows electronic sending as unavailable.
 */

export interface LabSendResult {
  /** HL7 ACK code: AA accepted, AE error, AR rejected. */
  ack: "AA" | "AE" | "AR";
  accessionNumber: string | null;
  error?: string;
}

export interface LabGateway {
  readonly vendor: "fake";
  send(orm: string): Promise<LabSendResult>;
  /** Order status as the lab sees it (orders.tracking "Check status with lab"). */
  status(placerOrderNumber: string): Promise<"received" | "in-process" | "resulted" | "unknown">;
}

export class LabUnavailableError extends Error {
  code = "LAB_UNAVAILABLE";
}

/** Simulated lab. `down` makes every call fail like an outage (INV-OPS-01 tests). Idempotent per placer number. */
export class FakeLabGateway implements LabGateway {
  readonly vendor = "fake" as const;
  down = false;
  private readonly accessions = new Map<string, string>();
  readonly resulted = new Set<string>();

  async send(orm: string): Promise<LabSendResult> {
    if (this.down) throw new LabUnavailableError("The lab interface is not responding.");
    const segs = parseMessage(orm);
    const placer = comp(
      segs.find((s) => s.name === "OBR"),
      2,
    );
    if (!placer)
      return { ack: "AR", accessionNumber: null, error: "OBR-2 placer order number missing." };
    const existing = this.accessions.get(placer);
    if (existing) return { ack: "AA", accessionNumber: existing };
    const accession = `FK${String(randomInt(10_000_000, 99_999_999))}`;
    this.accessions.set(placer, accession);
    return { ack: "AA", accessionNumber: accession };
  }

  async status(placer: string) {
    if (this.down) throw new LabUnavailableError("The lab interface is not responding.");
    if (this.resulted.has(placer)) return "resulted" as const;
    return this.accessions.has(placer) ? ("in-process" as const) : ("unknown" as const);
  }
}

let instance: FakeLabGateway | null = null;

export function isLabConnected(): boolean {
  return getEnv().NODE_ENV !== "production";
}

export function labGateway(): LabGateway | null {
  if (!isLabConnected()) return null;
  return (instance ??= new FakeLabGateway());
}

/** Test and dev access to the simulated lab (outage switch, resulted set). */
export function fakeLab(): FakeLabGateway {
  return (instance ??= new FakeLabGateway());
}

/**
 * Webhook signature: `x-lab-signature: sha256=<hex HMAC of the raw body>`. The key is per lab connection, derived
 * from SESSION_SECRET until a vendor secret is stored with rotateIntegrationSecret.
 */
export function labWebhookKey(connectionId: string): Buffer {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(`lab-webhook:${connectionId}`)
    .digest();
}

export function signLabPayload(connectionId: string, raw: Buffer | string): string {
  return `sha256=${createHmac("sha256", labWebhookKey(connectionId)).update(raw).digest("hex")}`;
}

export function verifyLabSignature(
  connectionId: string,
  raw: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const want = Buffer.from(signLabPayload(connectionId, raw));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
