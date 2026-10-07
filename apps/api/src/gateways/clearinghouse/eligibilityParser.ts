/**
 * Pure 271 -> EligibilityCheckResult mapping, kept free of env/network
 * imports so it can be unit-tested against fixtures (test/eligibility_parse_test.mjs).
 *
 * X12 271 EB-segment codes used (Stedi returns them as `benefitsInformation[]`):
 *   1 active coverage, 6 inactive, A co-insurance, B co-payment, C deductible,
 *   G out-of-pocket (stop loss). EB06 time qualifier 29 = "Remaining".
 *
 * Payers return partly non-compliant values, so every access is defensive:
 * anything missing becomes null, never a thrown error and never a guess.
 */
export type EligibilityStatusValue = "Active" | "Inactive" | "Error";

export interface EligibilityCheckResult {
  status: EligibilityStatusValue;
  /** Decimal strings with 2 places, or null when the payer did not say. */
  copayAmount: string | null;
  deductibleRemaining: string | null;
  coinsurancePct: string | null;
  outOfPocketRemaining: string | null;
  errorCode: string | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(asObject).filter((v): v is Json => v !== null) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function money(value: unknown): string | null {
  const text = str(value) ?? (typeof value === "number" ? String(value) : null);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : null;
}

function serviceTypes(entry: Json): string[] {
  return Array.isArray(entry.serviceTypeCodes)
    ? entry.serviceTypeCodes.filter((c): c is string => typeof c === "string")
    : [];
}

function inNetwork(entry: Json): boolean {
  const indicator = str(entry.inPlanNetworkIndicatorCode);
  return indicator === "Y" || indicator === "W";
}

/** Only these service types describe a physician office visit. A 271 lists
 * co-pays/co-insurance for every service type (physical therapy, chiropractic,
 * emergency...); showing one of those as "the visit co-pay" would be wrong,
 * so unrelated types are ignored entirely. 98 = professional office visit,
 * 96 = professional (physician), 30 = general medical. */
const VISIT_SERVICE_TYPE_WEIGHT: Record<string, number> = { "98": 30, "96": 20, "30": 10 };

function visitWeight(entry: Json): number {
  return Math.max(0, ...serviceTypes(entry).map((t) => VISIT_SERVICE_TYPE_WEIGHT[t] ?? 0));
}

/** Prefer the most specific visit service type, then in-network, then
 * individual over family coverage level. */
function rank(entry: Json): number {
  return (
    visitWeight(entry) +
    (inNetwork(entry) ? 2 : 0) +
    (str(entry.coverageLevelCode) === "IND" ? 1 : 0)
  );
}

function best(entries: Json[]): Json | null {
  return [...entries].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

const isVisitBenefit = (entry: Json) => visitWeight(entry) > 0;

function collectErrors(response: Json): Json[] {
  const subscriber = asObject(response.subscriber);
  return [
    ...asArray(response.errors),
    ...asArray(subscriber?.aaaErrors),
    ...asArray(response.aaaErrors),
  ];
}

export function parse271(response: unknown): EligibilityCheckResult {
  const root = asObject(response);
  const empty = {
    copayAmount: null,
    deductibleRemaining: null,
    coinsurancePct: null,
    outOfPocketRemaining: null,
  };
  if (!root) return { status: "Error", ...empty, errorCode: "UNPARSEABLE_RESPONSE" };

  const benefits = asArray(root.benefitsInformation);
  const planStatus = asArray(root.planStatus);
  const codes = new Set([
    ...benefits.map((b) => str(b.code)),
    ...planStatus.map((p) => str(p.statusCode) ?? str(p.code)),
  ]);

  const errors = collectErrors(root);
  const hasActive = codes.has("1");
  const hasInactive = codes.has("6");

  // A payer rejection with no coverage evidence means we could NOT verify.
  // It must never be reported as Inactive.
  if (!hasActive && !hasInactive) {
    const first = errors[0];
    return {
      status: "Error",
      ...empty,
      errorCode: (first && (str(first.code) ?? str(first.description))) || "NO_COVERAGE_INFO",
    };
  }

  if (hasInactive && !hasActive) {
    return { status: "Inactive", ...empty, errorCode: null };
  }

  const copay = best(
    benefits.filter((b) => str(b.code) === "B" && isVisitBenefit(b) && money(b.benefitAmount)),
  );
  const deductible = best(
    benefits.filter(
      (b) => str(b.code) === "C" && str(b.timeQualifierCode) === "29" && money(b.benefitAmount),
    ),
  );
  const outOfPocket = best(
    benefits.filter(
      (b) => str(b.code) === "G" && str(b.timeQualifierCode) === "29" && money(b.benefitAmount),
    ),
  );
  const coinsurance = best(
    benefits.filter((b) => str(b.code) === "A" && isVisitBenefit(b) && str(b.benefitPercent)),
  );

  let coinsurancePct: string | null = null;
  if (coinsurance) {
    const raw = Number(str(coinsurance.benefitPercent));
    // X12 EB08 is a decimal fraction ("0.2" = 20%); tolerate payers sending 20.
    if (Number.isFinite(raw) && raw >= 0) coinsurancePct = (raw <= 1 ? raw * 100 : raw).toFixed(2);
  }

  return {
    status: "Active",
    copayAmount: copay ? money(copay.benefitAmount) : null,
    deductibleRemaining: deductible ? money(deductible.benefitAmount) : null,
    coinsurancePct,
    outOfPocketRemaining: outOfPocket ? money(outOfPocket.benefitAmount) : null,
    errorCode: null,
  };
}
