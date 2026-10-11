/**
 * Simulated payer responses for the fake clearinghouse (dev and tests only). They are built in the JSON shape the
 * ported Stedi parsers read (claimParsers.ts), so acknowledgements and remittances go through exactly the same
 * parsing and posting code as a real Stedi report.
 *
 * Deterministic by member ID: "REJECT" -> 277CA rejection (A7:164, member ID not recognised); "DENY" -> 835 denial
 * (CO-197, no prior authorisation); "UNDERPAY" -> paid 20% under the contracted rate; anything else is paid at the
 * contracted rate (or 80% of billed without a contract) less a $25 copay (PR-3).
 */

export interface SimulatedAckInput {
  patientControlNumber: string;
  memberId: string;
}

export function simulated277(claims: SimulatedAckInput[]) {
  return {
    transactions: claims.map((c) => ({
      claimStatus: {
        patientAccountNumber: c.patientControlNumber,
        informationClaimStatuses: [
          {
            informationStatuses: [
              c.memberId.toUpperCase().includes("REJECT")
                ? { healthCareClaimStatusCategoryCode: "A7", statusCode: "164" }
                : { healthCareClaimStatusCategoryCode: "A2", statusCode: "20" },
            ],
          },
        ],
      },
    })),
  };
}

export interface SimulatedRemitClaim {
  patientControlNumber: string;
  payerClaimControlNumber: string;
  memberId: string;
  billed: number;
  /** Contracted allowed amount for the claim's lines, or null without a contract fee schedule. */
  contractAllowed: number | null;
}

const m = (n: number) => n.toFixed(2);

export function simulated835(input: {
  traceNumber: string;
  paymentDate: string; // YYYY-MM-DD
  payerName: string;
  payerId: string;
  claims: SimulatedRemitClaim[];
  providerAdjustments?: Array<{ reasonCode: string; reference: string; amount: number }>;
}) {
  let total = 0;
  const detail = input.claims.map((c) => {
    const id = c.memberId.toUpperCase();
    if (id.includes("DENY")) {
      return {
        claimPaymentInfo: {
          patientControlNumber: c.patientControlNumber,
          claimStatusCode: "4",
          totalClaimChargeAmount: m(c.billed),
          claimPaymentAmount: "0.00",
          patientResponsibilityAmount: "0.00",
          payerClaimControlNumber: c.payerClaimControlNumber,
        },
        claimAdjustments: [
          {
            claimAdjustmentGroupCode: "CO",
            adjustmentReasonCode1: "197",
            adjustmentAmount1: m(c.billed),
          },
        ],
        claimSupplementalInformation: { allowedActual: "0.00" },
      };
    }
    const fullAllowed = Math.min(c.billed, c.contractAllowed ?? Math.round(c.billed * 80) / 100);
    const allowed = id.includes("UNDERPAY") ? Math.round(fullAllowed * 80) / 100 : fullAllowed;
    const copay = Math.min(25, allowed);
    const paid = Math.round((allowed - copay) * 100) / 100;
    total += paid;
    return {
      claimPaymentInfo: {
        patientControlNumber: c.patientControlNumber,
        claimStatusCode: "1",
        totalClaimChargeAmount: m(c.billed),
        claimPaymentAmount: m(paid),
        patientResponsibilityAmount: m(copay),
        payerClaimControlNumber: c.payerClaimControlNumber,
      },
      claimAdjustments: [
        ...(c.billed - allowed > 0.004
          ? [
              {
                claimAdjustmentGroupCode: "CO",
                adjustmentReasonCode1: "45",
                adjustmentAmount1: m(c.billed - allowed),
              },
            ]
          : []),
        ...(copay > 0
          ? [
              {
                claimAdjustmentGroupCode: "PR",
                adjustmentReasonCode1: "3",
                adjustmentAmount1: m(copay),
              },
            ]
          : []),
      ],
      claimSupplementalInformation: { allowedActual: m(allowed) },
    };
  });
  const plb = input.providerAdjustments ?? [];
  total -= plb.reduce((s, p) => s + p.amount, 0);
  return {
    transactions: [
      {
        financialInformation: {
          totalActualProviderPaymentAmount: m(Math.round(total * 100) / 100),
          paymentMethodCode: "ACH",
          checkIssueOrEFTEffectiveDate: input.paymentDate.replaceAll("-", ""),
        },
        paymentAndRemitReassociationDetails: { checkOrEFTTraceNumber: input.traceNumber },
        payer: { name: input.payerName, payerIdentificationNumber: input.payerId },
        detailInfo: [{ paymentInfo: detail }],
        ...(plb.length
          ? {
              providerAdjustments: [
                {
                  adjustments: plb.map((p) => ({
                    adjustmentReasonCode: p.reasonCode,
                    providerAdjustmentIdentifier: p.reference,
                    providerAdjustmentAmount: m(p.amount),
                  })),
                },
              ],
            }
          : {}),
      },
    ],
  };
}
