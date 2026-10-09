import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../env.js";
import { formularyFor, type FormularyResult } from "./formulary.js";

export type { FormularyResult };

/**
 * ErxGateway (spec/integrations.yaml, LogiCoy over NCPDP SCRIPT). We never build SCRIPT messages ourselves
 * (docs/ehr-spec/CLAUDE.md: certified eRx/EPCS functions go through a vendor): the gateway takes structured
 * prescriptions and the vendor encodes them.
 *
 * LogiCoy is not contracted yet (OPEN-Q2) and agile-emr only had a stub, so -- like LabGateway -- the only
 * implementation is a simulated pharmacy network, connected only outside production. In production with no vendor,
 * `erxGateway()` is null: prescriptions can be drafted and checked, but "Sign & send" is disabled with the reason.
 */

export interface ErxPrescription {
  /** Our MedicationRequest id; the vendor message is idempotent on it. */
  prescriptionId: string;
  patient: { mrn: string; lastName: string; firstName: string; birthDate: string; sex: string };
  prescriber: { npi: string | null; lastName: string; firstName: string; dea: string | null };
  pharmacyNcpdpId: string;
  drug: { rxcui: string; ndc: string | null; description: string; deaSchedule: string | null };
  sig: string;
  quantity: string;
  quantityUnit: string;
  refills: number;
  daysSupply: number | null;
  substitutionAllowed: boolean;
  noteToPharmacist: string | null;
  diagnosisCodes: string[];
  /** EPCS: when the two-factor signing happened (controlled substances only). */
  epcsSignedAt: string | null;
}

export interface ErxSendResult {
  status: "accepted" | "error";
  /** Vendor message id (MedicationRequest.erxMessageId). */
  messageId: string | null;
  error?: string;
}

export interface ErxRequestResponse {
  /** Vendor id of the pharmacy's RxRenewalRequest / RxChangeRequest. */
  requestMessageId: string;
  kind: "renewal" | "change";
  decision: "approved" | "denied";
  reason?: string | null;
  /** The new prescription for an approval. */
  prescription?: ErxPrescription;
}

export interface ErxFill {
  prescriptionId: string;
  filledAt: string;
  pharmacy: string;
  quantity: number;
  daysSupply: number;
  prescriber: string | null;
}

export interface ErxGateway {
  readonly vendor: "simulated";
  sendNewRx(rx: ErxPrescription): Promise<ErxSendResult>;
  sendCancelRx(input: {
    prescriptionId: string;
    originalMessageId: string;
    reason: string;
  }): Promise<ErxSendResult>;
  sendRequestResponse(input: ErxRequestResponse): Promise<ErxSendResult>;
  /** Formulary and real-time benefit check for the patient's pharmacy benefit (null = no benefit data). */
  formulary(input: {
    rxcui: string;
    ingredientNames: string[];
    tty: string;
    payerName: string | null;
  }): Promise<FormularyResult | null>;
}

export class ErxUnavailableError extends Error {
  code = "ERX_UNAVAILABLE";
}

/**
 * Simulated pharmacy network. `down` makes every call fail like an outage (INV-OPS-01 tests). Idempotent per
 * prescription id, like the vendor: a resend returns the original message id.
 */
export class SimulatedErxGateway implements ErxGateway {
  readonly vendor = "simulated" as const;
  down = false;
  /** Pharmacies (NCPDP id) that reject new prescriptions, to exercise the error path. */
  readonly rejecting = new Set<string>();
  private readonly sent = new Map<string, string>();

  private id(prefix: string) {
    return `${prefix}${String(randomInt(10_000_000, 99_999_999))}`;
  }

  private guard() {
    if (this.down) throw new ErxUnavailableError("The e-prescribing network is not responding.");
  }

  async sendNewRx(rx: ErxPrescription): Promise<ErxSendResult> {
    this.guard();
    if (this.rejecting.has(rx.pharmacyNcpdpId))
      return { status: "error", messageId: null, error: "Pharmacy not accepting e-prescriptions" };
    if (rx.drug.deaSchedule && !rx.epcsSignedAt)
      return {
        status: "error",
        messageId: null,
        error: "Controlled substance without EPCS signature",
      };
    const existing = this.sent.get(rx.prescriptionId);
    if (existing) return { status: "accepted", messageId: existing };
    const messageId = this.id("SIMRX");
    this.sent.set(rx.prescriptionId, messageId);
    return { status: "accepted", messageId };
  }

  async sendCancelRx(input: { prescriptionId: string; originalMessageId: string }) {
    this.guard();
    const key = `cancel:${input.prescriptionId}`;
    const messageId = this.sent.get(key) ?? this.id("SIMCX");
    this.sent.set(key, messageId);
    return { status: "accepted" as const, messageId };
  }

  async sendRequestResponse(input: ErxRequestResponse): Promise<ErxSendResult> {
    this.guard();
    const key = `resp:${input.requestMessageId}`;
    const messageId = this.sent.get(key) ?? this.id("SIMRR");
    this.sent.set(key, messageId);
    if (input.prescription) this.sent.set(input.prescription.prescriptionId, messageId);
    return { status: "accepted", messageId };
  }

  async formulary(input: {
    rxcui: string;
    ingredientNames: string[];
    tty: string;
    payerName: string | null;
  }) {
    this.guard();
    return formularyFor(input);
  }
}

let instance: SimulatedErxGateway | null = null;

export function isErxConnected(): boolean {
  return getEnv().NODE_ENV !== "production";
}

export function erxGateway(): ErxGateway | null {
  if (!isErxConnected()) return null;
  return (instance ??= new SimulatedErxGateway());
}

/** Test and dev access to the simulated network (outage switch, rejecting pharmacies). */
export function simulatedErx(): SimulatedErxGateway {
  return (instance ??= new SimulatedErxGateway());
}

/**
 * Inbound webhook signature: `x-logicoy-signature: sha256=<hex HMAC of the raw body>`, keyed per connection and
 * derived from SESSION_SECRET until a vendor secret is stored (same scheme as the lab webhook).
 */
function webhookKey(connectionId: string): Buffer {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(`logicoy-webhook:${connectionId}`)
    .digest();
}

export function signErxPayload(connectionId: string, raw: Buffer | string): string {
  return `sha256=${createHmac("sha256", webhookKey(connectionId)).update(raw).digest("hex")}`;
}

export function verifyErxSignature(
  connectionId: string,
  raw: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const want = Buffer.from(signErxPayload(connectionId, raw));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Inbound vendor event (JSON, the shape our LogiCoy adapter will map SCRIPT messages into). The simulated network
 * and the dev scenario script post these.
 */
export type ErxInboundEvent =
  | {
      type: "RxRenewalRequest" | "RxChangeRequest";
      eventId: string;
      practiceId: string;
      pharmacyNcpdpId: string;
      /** Our prescription the pharmacy refers to (the vendor echoes our id). */
      prescriptionId: string | null;
      patient: { mrn: string; lastName: string; firstName: string; birthDate: string };
      requested?: {
        rxcui?: string;
        description?: string;
        quantity?: number;
        daysSupply?: number;
        refills?: number;
        reason?: string;
      };
    }
  | {
      type: "Status" | "Error";
      eventId: string;
      practiceId: string;
      messageId: string;
      code?: string;
      description?: string;
    };
