import { isValidNpi } from "@agile-emr/shared";
import { getEnv } from "../../env.js";
import { buildStediClaimRequest, type ClaimData } from "./claimBuilder.js";
import { type EligibilityCheckResult, parse271 } from "./eligibilityParser.js";
import {
  StediApiError,
  StediUnavailableError,
  isStediConfigured,
  stediRequest,
} from "./stediClient.js";

/**
 * ClearinghouseGateway (ADR-005): X12 270/271 eligibility, 837P claims, 999/277CA acks, 276/277 status and 835 ERA
 * through Stedi, agile-emr's vendor. stediClient.ts and eligibilityParser.ts are copied unchanged; the claim
 * submission, report fetch, claimBuilder.ts and claimParsers.ts are ported from agile-emr's clearinghouseProvider,
 * claimBuilder and clearinghouseParsers (claims there were never verified end to end: OPEN-Q25). Domain code depends
 * on this interface only. Without STEDI_API_KEY the fake answers eligibility and, outside production, acts as the
 * simulated clearinghouse for claims (simulated.ts); tests always use the fake.
 */
export interface EligibilityInput {
  payerId: string;
  memberId: string;
  subscriber: { firstName: string; lastName: string; dateOfBirth: string | null };
  dependent?: { firstName: string; lastName: string; dateOfBirth: string | null };
  provider: { npi: string; name: string };
  dateOfService?: string;
  serviceTypeCodes?: string[];
}

export interface EligibilityOutcome {
  result: EligibilityCheckResult;
  /** Full 271 (PHI): callers store it only as an encrypted file. Null for the fake or when Stedi never answered. */
  raw: unknown | null;
  vendorRef: string | null;
}

export interface ClaimSubmission {
  claim: ClaimData;
  /** Our claim id on the wire (max 17 alphanumerics); echoed on the 277CA and 835. */
  patientControlNumber: string;
  /** Stedi de-duplicates on this key for 24 hours, so a retry is never delivered twice. */
  idempotencyKey: string;
}

/**
 * Immediate answer to a submission. Stedi's JSON API validates synchronously, which is our 999: "accepted" means
 * the clearinghouse took the claim for delivery (the payer's 277CA decides later), "rejected" means the claim was
 * refused before delivery with the reasons in `errors`.
 */
export interface ClaimSubmitOutcome {
  status: "accepted" | "rejected";
  vendorRef: string | null;
  errors: Array<{ code: string | null; description: string }>;
}

export interface ClaimStatusOutcome {
  /** 277 claim status category (A1 received, A2 accepted, F1 paid, F2 denied, P1 pending …). */
  category: string | null;
  code: string | null;
  description: string;
}

export type ReportSet = "277" | "835";

export interface ClearinghouseGateway {
  readonly vendor: "stedi" | "fake";
  checkEligibility(input: EligibilityInput): Promise<EligibilityOutcome>;
  /** 837P. Throws ClearinghouseUnavailableError for anything that says nothing about the claim (outage, auth). */
  submitClaim(input: ClaimSubmission): Promise<ClaimSubmitOutcome>;
  /** 276/277 real-time claim status. */
  claimStatus(input: {
    claim: ClaimData;
    patientControlNumber: string;
  }): Promise<ClaimStatusOutcome>;
  /** Inbound report referenced by a webhook event (277CA acknowledgement or 835 ERA), as Stedi's JSON. */
  fetchReport(transactionId: string, set: ReportSet): Promise<unknown>;
}

/** The clearinghouse could not be reached, refused our credentials, or is not provisioned for claims. */
export class ClearinghouseUnavailableError extends Error {
  code = "CLEARINGHOUSE_UNAVAILABLE";
}

const ACCOUNT_NOT_PROVISIONED = "ACCOUNT_NOT_PROVISIONED";
/** Stedi's claims and report endpoints are version-prefixed (agile-emr, providers/clearinghouseProvider.ts). */
const API_VERSION = "/2024-04-01";

function unavailable(error: unknown): never {
  if (error instanceof StediApiError)
    throw new ClearinghouseUnavailableError(
      error.code === ACCOUNT_NOT_PROVISIONED
        ? "The Stedi account is not provisioned for claims."
        : `Stedi HTTP ${error.status}${error.code ? ` ${error.code}` : ""}`,
    );
  if (error instanceof StediUnavailableError)
    throw new ClearinghouseUnavailableError("Stedi did not respond.");
  throw error;
}

const toYyyymmdd = (iso: string) => iso.replaceAll("-", "");

class StediClearinghouse implements ClearinghouseGateway {
  readonly vendor = "stedi" as const;
  async checkEligibility(input: EligibilityInput): Promise<EligibilityOutcome> {
    const body = {
      tradingPartnerServiceId: input.payerId,
      provider: { npi: input.provider.npi, organizationName: input.provider.name },
      subscriber: {
        firstName: input.subscriber.firstName,
        lastName: input.subscriber.lastName,
        memberId: input.memberId,
        ...(input.subscriber.dateOfBirth
          ? { dateOfBirth: toYyyymmdd(input.subscriber.dateOfBirth) }
          : {}),
      },
      ...(input.dependent
        ? {
            dependents: [
              {
                firstName: input.dependent.firstName,
                lastName: input.dependent.lastName,
                ...(input.dependent.dateOfBirth
                  ? { dateOfBirth: toYyyymmdd(input.dependent.dateOfBirth) }
                  : {}),
              },
            ],
          }
        : {}),
      encounter: {
        serviceTypeCodes: input.serviceTypeCodes?.length ? input.serviceTypeCodes : ["30", "98"],
        ...(input.dateOfService ? { dateOfService: toYyyymmdd(input.dateOfService) } : {}),
      },
    };
    try {
      const response = await stediRequest<{ controlNumber?: string }>(
        "/change/medicalnetwork/eligibility/v3",
        { body },
      );
      return {
        result: parse271(response),
        raw: response,
        vendorRef: response?.controlNumber ?? null,
      };
    } catch (error) {
      // Unreachable payer / outage / auth failure means "could not verify", never "inactive". Status code only.
      const errorCode =
        error instanceof StediApiError
          ? `STEDI_HTTP_${error.status}`
          : error instanceof StediUnavailableError
            ? "STEDI_UNAVAILABLE"
            : "STEDI_ERROR";
      return {
        result: {
          status: "Error",
          copayAmount: null,
          deductibleRemaining: null,
          coinsurancePct: null,
          outOfPocketRemaining: null,
          errorCode,
        },
        raw: null,
        vendorRef: null,
      };
    }
  }

  // Ported from agile-emr StediClearinghouseProvider.submitClaim: a 4xx validation failure rejects THIS claim
  // (staff fix and resubmit); not provisioned, auth, rate limit, 5xx and network say nothing about the claim and
  // are thrown so the claim stays ready and the interface monitor retries.
  async submitClaim(input: ClaimSubmission): Promise<ClaimSubmitOutcome> {
    const body = buildStediClaimRequest(input.claim, {
      patientControlNumber: input.patientControlNumber,
      usageIndicator: getEnv().STEDI_CLAIMS_MODE === "production" ? "P" : "T",
    });
    try {
      const response = await stediRequest<{
        claimReference?: { claimId?: string; correlationId?: string; status?: string };
        claimSubmissionStatus?: string;
      }>(`${API_VERSION}/change/medicalnetwork/professionalclaims/v3/submission`, {
        body,
        idempotencyKey: input.idempotencyKey,
      });
      const ref = response.claimReference;
      const vendorRef = ref?.claimId ?? ref?.correlationId ?? input.patientControlNumber;
      const status = (response.claimSubmissionStatus ?? ref?.status ?? "").toUpperCase();
      if (status.includes("REJECT"))
        return {
          status: "rejected",
          vendorRef,
          errors: [{ code: null, description: "Rejected by the clearinghouse before delivery" }],
        };
      return { status: "accepted", vendorRef, errors: [] };
    } catch (error) {
      if (
        error instanceof StediApiError &&
        error.code !== ACCOUNT_NOT_PROVISIONED &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 403, 429].includes(error.status)
      )
        return {
          status: "rejected",
          vendorRef: null,
          errors: error.details.length
            ? error.details.slice(0, 5)
            : [
                {
                  code: error.code,
                  description: `Rejected by the clearinghouse (HTTP ${error.status})`,
                },
              ],
        };
      return unavailable(error);
    }
  }

  // NOT verified against Stedi (agile-emr never used 276/277): request shape from Stedi's claim status docs.
  async claimStatus(input: { claim: ClaimData; patientControlNumber: string }) {
    const c = input.claim;
    const dates = c.lines.map((l) => l.serviceDate.replaceAll("-", "")).sort();
    try {
      const response = await stediRequest<unknown>("/change/medicalnetwork/claimstatus/v2", {
        body: {
          tradingPartnerServiceId: c.payer.stediPayerId,
          providers: [
            {
              organizationName: c.billing.organizationName,
              npi: c.billing.npi,
              providerType: "BillingProvider",
            },
          ],
          subscriber: {
            memberId: c.subscriber.memberId,
            firstName: c.subscriber.firstName,
            lastName: c.subscriber.lastName,
            dateOfBirth: c.subscriber.dob.replaceAll("-", ""),
          },
          encounter: {
            beginningDateOfService: dates[0],
            endDateOfService: dates[dates.length - 1],
          },
        },
      });
      const found = findStatus(response);
      return (
        found ?? { category: null, code: null, description: "No status returned by the payer." }
      );
    } catch (error) {
      return unavailable(error);
    }
  }

  async fetchReport(transactionId: string, set: ReportSet): Promise<unknown> {
    try {
      return await stediRequest<unknown>(
        `${API_VERSION}/change/medicalnetwork/reports/v2/${encodeURIComponent(transactionId)}/${set}`,
      );
    } catch (error) {
      return unavailable(error);
    }
  }
}

function findStatus(node: unknown): ClaimStatusOutcome | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findStatus(n);
      if (f) return f;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  const category = o.statusCategoryCode ?? o.healthCareClaimStatusCategoryCode;
  if (typeof category === "string")
    return {
      category,
      code: typeof o.statusCode === "string" ? o.statusCode : null,
      description:
        typeof o.statusCategoryCodeValue === "string"
          ? o.statusCategoryCodeValue
          : `Status ${category}`,
    };
  for (const v of Object.values(o)) {
    const f = findStatus(v);
    if (f) return f;
  }
  return null;
}

/**
 * Deterministic fake (same convention as agile-emr's stub): a member ID containing "INACTIVE" is inactive,
 * "ERROR" fails to verify, "DOWN" simulates an outage; anything else is active with fixed benefits.
 */
export class FakeClearinghouse implements ClearinghouseGateway {
  readonly vendor = "fake" as const;
  down = false;
  /** Inbound reports a webhook can fetch (simulated clearinghouse and tests put them here). */
  readonly reports = new Map<string, unknown>();
  private readonly accepted = new Map<string, ClaimSubmitOutcome>();

  /**
   * Simulated 837P: the same synchronous checks Stedi was seen to run (agile-emr probing: an NPI failing the check
   * digit is rejected with code 33), plus a member ID containing "REJECT999" for a front-end rejection.
   * Idempotent per key like Stedi.
   */
  async submitClaim(input: ClaimSubmission): Promise<ClaimSubmitOutcome> {
    if (this.down) throw new ClearinghouseUnavailableError("The clearinghouse is not responding.");
    const prior = this.accepted.get(input.idempotencyKey);
    if (prior) return prior;
    const c = input.claim;
    const errors: ClaimSubmitOutcome["errors"] = [];
    if (!isValidNpi(c.billing.npi))
      errors.push({ code: "33", description: "Invalid billing provider NPI" });
    if (c.rendering && !isValidNpi(c.rendering.npi))
      errors.push({ code: "33", description: "Invalid rendering provider NPI" });
    if (c.subscriber.memberId.toUpperCase().includes("REJECT999"))
      errors.push({ code: "164", description: "Subscriber member ID is invalid for this payer" });
    if (!c.lines.length) errors.push({ code: "21", description: "Claim has no service lines" });
    const out: ClaimSubmitOutcome = errors.length
      ? { status: "rejected", vendorRef: null, errors }
      : { status: "accepted", vendorRef: `FAKE-837-${input.patientControlNumber}`, errors: [] };
    this.accepted.set(input.idempotencyKey, out);
    return out;
  }

  async claimStatus(): Promise<ClaimStatusOutcome> {
    if (this.down) throw new ClearinghouseUnavailableError("The clearinghouse is not responding.");
    return { category: "A2", code: "20", description: "Accepted for processing" };
  }

  async fetchReport(transactionId: string): Promise<unknown> {
    if (this.down) throw new ClearinghouseUnavailableError("The clearinghouse is not responding.");
    const r = this.reports.get(transactionId);
    if (r === undefined) throw new ClearinghouseUnavailableError("Unknown transaction.");
    return r;
  }
  async checkEligibility(input: EligibilityInput): Promise<EligibilityOutcome> {
    const id = input.memberId.toUpperCase();
    const none = {
      copayAmount: null,
      deductibleRemaining: null,
      coinsurancePct: null,
      outOfPocketRemaining: null,
    };
    if (this.down || id.includes("DOWN"))
      return {
        result: { status: "Error", ...none, errorCode: "STEDI_UNAVAILABLE" },
        raw: null,
        vendorRef: null,
      };
    if (id.includes("ERROR"))
      return {
        result: { status: "Error", ...none, errorCode: "FAKE_ERROR" },
        raw: null,
        vendorRef: null,
      };
    if (id.includes("INACTIVE"))
      return {
        result: { status: "Inactive", ...none, errorCode: null },
        raw: null,
        vendorRef: `fake-${Date.now()}`,
      };
    return {
      result: {
        status: "Active",
        copayAmount: "25.00",
        deductibleRemaining: "340.00",
        coinsurancePct: "20.00",
        outOfPocketRemaining: "2500.00",
        errorCode: null,
      },
      raw: null,
      vendorRef: `fake-${Date.now()}`,
    };
  }
}

const fakeInstance = new FakeClearinghouse();
const useStedi = isStediConfigured() && getEnv().NODE_ENV !== "test";

/** Eligibility keeps S1 behaviour: Stedi when configured, otherwise the fake. */
export const clearinghouse: ClearinghouseGateway = useStedi
  ? new StediClearinghouse()
  : fakeInstance;

/**
 * Claims (837P/277CA/835) are connected when Stedi is configured, or outside production through the simulated
 * clearinghouse (same convention as the simulated lab). In production with no key, claims cannot be sent and the
 * UI shows submission as unavailable (Me.connectedGateways).
 */
export function isClearinghouseConnected(): boolean {
  return useStedi || getEnv().NODE_ENV !== "production";
}

export function clearinghouseGateway(): ClearinghouseGateway | null {
  if (useStedi) return clearinghouse;
  return isClearinghouseConnected() ? fakeInstance : null;
}

/** Test and dev access to the simulated clearinghouse (outage switch, report store). */
export function fakeClearinghouse(): FakeClearinghouse {
  return fakeInstance;
}

export type { ClaimData };

export type { EligibilityCheckResult };
