/**
 * Ported unchanged from agile-emr (providers/clearinghouseParsers.ts) up to the "emr-v2 additions" marker.
 * Pure parsers for Stedi's JSON renderings of the two inbound claim responses:
 *   - 835 ERA  (payment + adjustments)      -> parseEra835
 *   - 277CA    (claim acknowledgement)       -> parseClaimAck277
 * Kept free of env/network imports so they can be unit-tested against fixtures
 * (test/clearinghouse_parsers_test.mjs).
 *
 * VERIFICATION STATUS -- READ BEFORE TRUSTING THESE SHAPES
 * The field names below come from Stedi's published docs and examples, NOT from
 * a response we received. The sandbox account used during development returns
 * HTTP 400 `ACCOUNT_NOT_PROVISIONED` for claims and transaction polling: test
 * claims (and therefore their mock 277CA/835 responses) are not enabled on it,
 * so these parsers have never seen a real Stedi payload. They are written
 * defensively (recursive search, tolerant of missing keys, never throw) so a
 * naming difference degrades to "nothing parsed / flagged for review" rather
 * than to a wrong payment. Re-verify against real sandbox responses as soon as
 * Stedi enables claims on the account.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

/** "500" / 500 / "500.5" -> "500.00"; anything unparseable -> null. */
function money(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/** Depth-first walk yielding every object that satisfies `match`. */
function collect(node: unknown, match: (obj: Json) => boolean, out: Json[] = []): Json[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, out);
  } else {
    const obj = asObject(node);
    if (obj) {
      if (match(obj)) out.push(obj);
      for (const child of Object.values(obj)) collect(child, match, out);
    }
  }
  return out;
}

// ---- 835 ERA ----------------------------------------------------------------

export interface ParsedEraAdjustment {
  /** CO contractual, PR patient responsibility, OA other, PI payer initiated, CR correction. */
  groupCode: string;
  /** CARC, e.g. "45", "1", "2", "3". */
  reasonCode: string;
  amount: string;
}

export interface ParsedEraClaim {
  patientControlNumber: string;
  /** 835 CLP02: 1/2/3 processed as primary/secondary/tertiary, 4 denied,
   * 19/20/21 forwarded to another payer, 22 reversal. */
  claimStatusCode: string;
  billedAmount: string | null;
  paidAmount: string | null;
  patientResponsibilityAmount: string | null;
  payerClaimControlNumber: string | null;
  /** Check or EFT trace number (TRN02) of the payment this claim was part of. */
  traceNumber: string | null;
  adjustments: ParsedEraAdjustment[];
}

/** Every adjustment object carries a group code plus up to six
 * (reason code, amount) pairs: adjustmentReasonCode1..6 / adjustmentAmount1..6. */
function adjustmentsFrom(paymentInfo: Json): ParsedEraAdjustment[] {
  const out: ParsedEraAdjustment[] = [];
  for (const adj of collect(paymentInfo, (o) => typeof o.claimAdjustmentGroupCode === "string")) {
    const groupCode = str(adj.claimAdjustmentGroupCode);
    if (!groupCode) continue;
    for (let n = 1; n <= 6; n++) {
      const reasonCode = str(adj[`adjustmentReasonCode${n}`]);
      const amount = money(adj[`adjustmentAmount${n}`]);
      if (reasonCode && amount !== null) out.push({ groupCode, reasonCode, amount });
    }
  }
  return out;
}

export function parseEra835(response: unknown): ParsedEraClaim[] {
  const root = asObject(response);
  if (!root) return [];
  const claims: ParsedEraClaim[] = [];

  for (const transaction of collect(root, (o) => Array.isArray(o.detailInfo))) {
    const financial = asObject(transaction.financialInformation);
    const traceNumber = str(financial?.checkOrEFTTraceNumber);
    for (const paymentInfo of collect(
      transaction.detailInfo,
      (o) => asObject(o.claimPaymentInfo) !== null,
    )) {
      const info = asObject(paymentInfo.claimPaymentInfo) as Json;
      const patientControlNumber = str(info.patientControlNumber);
      const claimStatusCode = str(info.claimStatusCode);
      if (!patientControlNumber || !claimStatusCode) continue;
      claims.push({
        patientControlNumber,
        claimStatusCode,
        billedAmount: money(info.totalClaimChargeAmount),
        paidAmount: money(info.claimPaymentAmount),
        patientResponsibilityAmount: money(info.patientResponsibilityAmount),
        payerClaimControlNumber: str(info.payerClaimControlNumber),
        traceNumber,
        adjustments: adjustmentsFrom(paymentInfo),
      });
    }
  }
  return claims;
}

// ---- 277CA claim acknowledgement ------------------------------------------------

export interface ParsedClaimAck {
  patientControlNumber: string;
  outcome: "Accepted" | "Rejected" | "Unknown";
  /** Category + status codes only (e.g. "A3:164") -- never free text, which
   * could echo patient details. */
  reasonCodes: string[];
}

/** 277CA claim-status category codes. A1/A2 acknowledge receipt/acceptance;
 * A3 (returned unprocessable) and A6/A7/A8 (rejected: missing / invalid /
 * relational-field information) mean the claim was NOT entered into
 * adjudication. */
const ACCEPTED_CATEGORIES = new Set(["A1", "A2"]);
const REJECTED_CATEGORIES = new Set(["A3", "A6", "A7", "A8"]);

export function parseClaimAck277(response: unknown): ParsedClaimAck[] {
  const acks: ParsedClaimAck[] = [];
  for (const holder of collect(response, (o) => asObject(o.claimStatus) !== null)) {
    const claimStatus = asObject(holder.claimStatus) as Json;
    const patientControlNumber =
      str(claimStatus.patientAccountNumber) ?? str(claimStatus.referencedTransactionTraceNumber);
    if (!patientControlNumber) continue;

    const statuses = collect(
      claimStatus,
      (o) => typeof o.healthCareClaimStatusCategoryCode === "string",
    );
    const categories = statuses.map((s) => str(s.healthCareClaimStatusCategoryCode) as string);
    const reasonCodes = statuses.map((s) => {
      const category = str(s.healthCareClaimStatusCategoryCode);
      const code = str(s.statusCode);
      return code ? `${category}:${code}` : (category as string);
    });

    const outcome = categories.some((c) => REJECTED_CATEGORIES.has(c))
      ? "Rejected"
      : categories.some((c) => ACCEPTED_CATEGORIES.has(c))
        ? "Accepted"
        : "Unknown";
    acks.push({ patientControlNumber, outcome, reasonCodes });
  }
  return acks;
}

// ---- emr-v2 additions ------------------------------------------------------------
// parseEra835 above flattens every claim in a report. Posting needs each payment (one 835 transaction = one
// check/EFT) with its header, its claims and its provider-level adjustments (PLB), plus the allowed amount for
// underpayment detection. Same defensive style: unknown shapes yield nothing rather than a wrong payment.

export interface ParsedProviderAdjustment {
  /** PLB03-1 reason, e.g. WO overpayment recovery, L6 interest, FB forwarding balance. */
  reasonCode: string;
  /** PLB03-2 reference, usually the source claim's control number. */
  reference: string | null;
  /** Positive = the payer withheld money from this payment (recoupment); negative = added (interest). */
  amount: string;
}

export interface ParsedRemittance {
  traceNumber: string;
  paymentAmount: string;
  /** BPR04: ACH, CHK, NON … */
  paymentMethod: string;
  /** YYYY-MM-DD */
  paymentDate: string | null;
  payerName: string | null;
  payerId: string | null;
  claims: Array<ParsedEraClaim & { allowedAmount: string | null }>;
  providerAdjustments: ParsedProviderAdjustment[];
}

const isoFromYyyymmdd = (s: string | null) =>
  s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;

function allowedFrom(paymentInfo: Json): string | null {
  const amounts = collect(paymentInfo, (o) => o.allowedActual !== undefined)
    .map((o) => money(o.allowedActual))
    .filter((v): v is string => v !== null);
  if (!amounts.length) return null;
  return amounts.reduce((sum, v) => sum + Number(v), 0).toFixed(2);
}

export function parseRemittances(response: unknown): ParsedRemittance[] {
  const out: ParsedRemittance[] = [];
  for (const transaction of collect(response, (o) => Array.isArray(o.detailInfo))) {
    const financial = asObject(transaction.financialInformation);
    const reassoc = asObject(transaction.paymentAndRemitReassociationDetails);
    const payer = asObject(transaction.payer);
    const traceNumber =
      str(reassoc?.checkOrEFTTraceNumber) ?? str(financial?.checkOrEFTTraceNumber);
    const paymentAmount =
      money(financial?.totalActualProviderPaymentAmount) ?? money(financial?.paymentAmount);
    if (!traceNumber || paymentAmount === null) continue;
    const claims: ParsedRemittance["claims"] = [];
    for (const paymentInfo of collect(
      transaction.detailInfo,
      (o) => asObject(o.claimPaymentInfo) !== null,
    )) {
      const info = asObject(paymentInfo.claimPaymentInfo) as Json;
      const patientControlNumber = str(info.patientControlNumber);
      const claimStatusCode = str(info.claimStatusCode);
      if (!patientControlNumber || !claimStatusCode) continue;
      claims.push({
        patientControlNumber,
        claimStatusCode,
        billedAmount: money(info.totalClaimChargeAmount),
        paidAmount: money(info.claimPaymentAmount),
        patientResponsibilityAmount: money(info.patientResponsibilityAmount),
        payerClaimControlNumber: str(info.payerClaimControlNumber),
        traceNumber,
        adjustments: adjustmentsFrom(paymentInfo),
        allowedAmount: allowedFrom(paymentInfo),
      });
    }
    const providerAdjustments: ParsedProviderAdjustment[] = [];
    for (const adj of collect(
      transaction.providerAdjustments ?? [],
      (o) => o.providerAdjustmentAmount !== undefined,
    )) {
      const reasonCode = str(adj.adjustmentReasonCode);
      const amount = money(adj.providerAdjustmentAmount);
      if (reasonCode && amount !== null)
        providerAdjustments.push({
          reasonCode,
          reference: str(adj.providerAdjustmentIdentifier),
          amount,
        });
    }
    out.push({
      traceNumber,
      paymentAmount,
      paymentMethod: str(financial?.paymentMethodCode) ?? "NON",
      paymentDate: isoFromYyyymmdd(str(financial?.checkIssueOrEFTEffectiveDate)),
      payerName: str(payer?.name),
      payerId:
        str(payer?.payerIdentificationNumber) ??
        str(payer?.centersForMedicareAndMedicaidServicesPlanId),
      claims,
      providerAdjustments,
    });
  }
  return out;
}
