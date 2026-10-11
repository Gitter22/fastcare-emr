/**
 * 837P request body for Stedi's professional claims API, ported from agile-emr (apps/api/src/claimBuilder.ts,
 * buildStediClaimRequest). Changes from the original: several service lines (modifiers, units, per-line diagnosis
 * pointers) instead of one, the claim frequency code and original payer reference for replacement/void claims
 * (rcm/05, rcm/07), and the prior authorisation number. Pure: ClaimData -> JSON, unit-testable.
 *
 * VERIFICATION STATUS (carried over from agile-emr): the single-line payload passed Stedi's request-schema and
 * business validation on a test claim, but the sandbox account was never provisioned for claim delivery
 * (ACCOUNT_NOT_PROVISIONED), so no submission has been accepted end to end. Treat a rejection as "a field name or
 * rule here is wrong" first.
 */

export interface ClaimAddress {
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export interface ClaimServiceLine {
  procedureCode: string;
  /** "HC" = CPT/HCPCS. */
  modifiers: string[];
  units: string;
  amount: string;
  serviceDate: string; // YYYY-MM-DD
  /** 1-based pointers into `diagnoses` (max 4 per line). */
  diagnosisPointers: number[];
}

export interface ClaimData {
  payer: { stediPayerId: string; name: string };
  billing: {
    npi: string;
    taxId: string;
    taxonomyCode: string | null;
    organizationName: string;
    address: ClaimAddress;
    phone: string;
  };
  /** Only set when the treating provider's NPI differs from the billing NPI. */
  rendering: { npi: string; firstName: string; lastName: string } | null;
  subscriber: {
    memberId: string;
    groupNumber: string | null;
    firstName: string;
    lastName: string;
    dob: string; // YYYY-MM-DD
    sex: "M" | "F" | "U";
    address: ClaimAddress;
  };
  /** Present only when the patient is not the subscriber. */
  dependent: {
    firstName: string;
    lastName: string;
    dob: string;
    sex: "M" | "F" | "U";
    relationshipCode: "01" | "19" | "G8";
    address: ClaimAddress;
  } | null;
  /** ICD-10-CM without the decimal point; first is the principal diagnosis (max 12). */
  diagnoses: string[];
  lines: ClaimServiceLine[];
  claimFilingCode: string;
  placeOfServiceCode: string;
  /** 1 original, 7 replacement, 8 void. */
  frequencyCode: "1" | "7" | "8";
  /** Payer claim control number of the claim being replaced/voided (required for 7 and 8). */
  originalReference: string | null;
  priorAuthNumber: string | null;
  totalCharge: string;
}

const yyyymmdd = (iso: string) => iso.replaceAll("-", "");

/** ICD-10-CM codes go on the claim without the decimal point. */
export function normalizeIcd10(code: string): string {
  return code.replace(/[.\s]/g, "").toUpperCase();
}

const addressJson = (a: ClaimAddress) => ({
  address1: a.address1,
  ...(a.address2 ? { address2: a.address2 } : {}),
  city: a.city,
  state: a.state,
  postalCode: a.postalCode,
});

/** ClaimData -> Stedi 837P JSON request body. `usageIndicator` "T" marks the claim as TEST data. */
export function buildStediClaimRequest(
  data: ClaimData,
  opts: { patientControlNumber: string; usageIndicator: "T" | "P" },
) {
  const { billing, subscriber, dependent } = data;
  return {
    tradingPartnerServiceId: data.payer.stediPayerId,
    usageIndicator: opts.usageIndicator,
    submitter: {
      organizationName: billing.organizationName,
      contactInformation: { name: billing.organizationName, phoneNumber: billing.phone },
    },
    receiver: { organizationName: data.payer.name },
    subscriber: {
      memberId: subscriber.memberId,
      ...(subscriber.groupNumber ? { groupNumber: subscriber.groupNumber } : {}),
      paymentResponsibilityLevelCode: "P",
      firstName: subscriber.firstName,
      lastName: subscriber.lastName,
      gender: subscriber.sex,
      dateOfBirth: yyyymmdd(subscriber.dob),
      address: addressJson(subscriber.address),
    },
    ...(dependent
      ? {
          dependent: {
            firstName: dependent.firstName,
            lastName: dependent.lastName,
            gender: dependent.sex,
            dateOfBirth: yyyymmdd(dependent.dob),
            relationshipToSubscriberCode: dependent.relationshipCode,
            address: addressJson(dependent.address),
          },
        }
      : {}),
    billing: {
      npi: billing.npi,
      employerId: billing.taxId,
      organizationName: billing.organizationName,
      ...(billing.taxonomyCode ? { taxonomyCode: billing.taxonomyCode } : {}),
      address: addressJson(billing.address),
      contactInformation: { name: billing.organizationName, phoneNumber: billing.phone },
    },
    ...(data.rendering
      ? {
          rendering: {
            npi: data.rendering.npi,
            firstName: data.rendering.firstName,
            lastName: data.rendering.lastName,
          },
        }
      : {}),
    claimInformation: {
      claimFilingCode: data.claimFilingCode,
      claimFrequencyCode: data.frequencyCode,
      // Max 17 alphanumerics; echoed back on the 277CA/835 and the only key that ties a response to our claim.
      patientControlNumber: opts.patientControlNumber,
      claimChargeAmount: data.totalCharge,
      placeOfServiceCode: data.placeOfServiceCode,
      // Clinic policy assertions carried over from agile-emr (accepts assignment, release on file): confirm
      // before production use.
      planParticipationCode: "A",
      benefitsAssignmentCertificationIndicator: "Y",
      releaseInformationCode: "Y",
      signatureIndicator: "Y",
      patientSignatureSourceCode: false,
      ...(data.originalReference || data.priorAuthNumber
        ? {
            claimSupplementalInformation: {
              ...(data.originalReference
                ? { payerClaimControlNumber: data.originalReference }
                : {}),
              ...(data.priorAuthNumber ? { priorAuthorizationNumber: data.priorAuthNumber } : {}),
            },
          }
        : {}),
      healthCareCodeInformation: data.diagnoses.slice(0, 12).map((code, i) => ({
        diagnosisTypeCode: i === 0 ? "ABK" : "ABF",
        diagnosisCode: code,
      })),
      serviceLines: data.lines.map((l) => ({
        professionalService: {
          procedureIdentifier: "HC",
          procedureCode: l.procedureCode,
          ...(l.modifiers.length ? { procedureModifiers: l.modifiers.slice(0, 4) } : {}),
          lineItemChargeAmount: l.amount,
          measurementUnit: "UN",
          serviceUnitCount: l.units,
          compositeDiagnosisCodePointers: {
            diagnosisCodePointers: l.diagnosisPointers.slice(0, 4).map(String),
          },
        },
        serviceDate: yyyymmdd(l.serviceDate),
      })),
    },
  };
}
