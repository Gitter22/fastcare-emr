import { getEnv } from "../../env.js";
import { type EligibilityCheckResult, parse271 } from "./eligibilityParser.js";
import {
  StediApiError,
  StediUnavailableError,
  isStediConfigured,
  stediRequest,
} from "./stediClient.js";

/**
 * ClearinghouseGateway (ADR-005): X12 270/271 eligibility, 837P claims, 999/277CA acks, 276/277 status and 835 ERA
 * through Stedi (agile-emr's vendor; stediClient.ts and eligibilityParser.ts are copied unchanged). Domain code
 * depends on this interface only. The fake is used unless STEDI_API_KEY is set, so CI and local dev never need the
 * network.
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

export interface ClearinghouseGateway {
  readonly vendor: "stedi" | "fake";
  checkEligibility(input: EligibilityInput): Promise<EligibilityOutcome>;
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
}

/**
 * Deterministic fake (same convention as agile-emr's stub): a member ID containing "INACTIVE" is inactive,
 * "ERROR" fails to verify, "DOWN" simulates an outage; anything else is active with fixed benefits.
 */
export class FakeClearinghouse implements ClearinghouseGateway {
  readonly vendor = "fake" as const;
  down = false;
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

export const clearinghouse: ClearinghouseGateway =
  isStediConfigured() && getEnv().NODE_ENV !== "test"
    ? new StediClearinghouse()
    : new FakeClearinghouse();

export type { EligibilityCheckResult };
