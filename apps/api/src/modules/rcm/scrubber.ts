import { isValidNpi } from "@agile-emr/shared";
import type { Claim, ClaimLine, Encounter, Tx } from "../../db.js";
import { type ClaimData, normalizeIcd10 } from "../../gateways/clearinghouse/claimBuilder.js";
import { decryptField } from "../../platform/crypto.js";
import type { CodingEdit } from "./coding.js";

/**
 * Claim scrubber (flow:rcm/02-03, INV-FIN-03): a charge reaches a claim only with a rendering provider NPI, billing
 * NPI/TIN, place of service and at least one diagnosis pointer per line, plus payer rules (prior authorisation),
 * timely filing and the patient/subscriber data an 837P needs. The same checks run at release and again at submit.
 */

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export interface ClaimContext {
  enc: Encounter;
  practice: {
    legalName: string;
    groupNpi: string | null;
    tin: string;
    taxonomyCode: string | null;
  };
  rendering: {
    id: string;
    npi: string | null;
    firstName: string;
    lastName: string;
    isBillingProvider: boolean;
  };
  pos: string | null;
  coverage: Awaited<ReturnType<typeof primaryCoverage>>;
}

export async function primaryCoverage(tx: Tx, patientId: string) {
  return tx.coverage.findFirst({
    where: { patientId, status: "active" },
    orderBy: { order: "asc" },
    include: { payer: true, eligibilityChecks: { orderBy: { requestedAt: "desc" }, take: 1 } },
  });
}

export async function loadClaimContext(tx: Tx, enc: Encounter): Promise<ClaimContext> {
  const [practice, pr, location, coverage] = await Promise.all([
    tx.practice.findUniqueOrThrow({ where: { id: enc.practiceId } }),
    tx.practitioner.findUniqueOrThrow({ where: { id: enc.practitionerId } }),
    enc.locationId ? tx.location.findUnique({ where: { id: enc.locationId } }) : null,
    primaryCoverage(tx, enc.patientId),
  ]);
  return {
    enc,
    practice: {
      legalName: practice.legalName,
      groupNpi: practice.groupNpi,
      tin: decryptField(practice.tin),
      taxonomyCode: practice.taxonomyCode,
    },
    rendering: pr,
    pos: enc.placeOfService ?? location?.placeOfService ?? null,
    coverage,
  };
}

export const billingNpiOf = (c: ClaimContext) => c.practice.groupNpi ?? c.rendering.npi ?? null;

/** Claim-level edits for an encounter's charges (line edits come from coding.ts). */
export async function claimEdits(
  tx: Tx,
  c: ClaimContext,
  codes: string[],
  serviceDate: Date,
): Promise<CodingEdit[]> {
  const out: CodingEdit[] = [];
  const inv = "INV-FIN-03";
  if (!c.rendering.npi || !isValidNpi(c.rendering.npi))
    out.push({
      key: "npi-rendering",
      rule: "provider",
      severity: "error",
      text: `Rendering provider ${c.rendering.firstName} ${c.rendering.lastName} has no valid NPI on file.`,
      invariant: inv,
    });
  const billingNpi = billingNpiOf(c);
  if (!billingNpi || !isValidNpi(billingNpi))
    out.push({
      key: "npi-billing",
      rule: "provider",
      severity: "error",
      text: "The practice has no valid billing (group) NPI.",
      invariant: inv,
    });
  if (digits(c.practice.tin).length !== 9)
    out.push({
      key: "tin",
      rule: "provider",
      severity: "error",
      text: "The practice tax ID (TIN) is missing or not 9 digits.",
      invariant: inv,
    });
  const pos = c.pos
    ? await tx.codeConcept.findFirst({ where: { system: "POS", code: c.pos, active: true } })
    : null;
  if (!pos)
    out.push({
      key: "pos",
      rule: "pos",
      severity: "error",
      text: c.pos
        ? `Place of service ${c.pos} is not a valid CMS POS code.`
        : "The visit has no place of service.",
      invariant: inv,
    });
  const cov = c.coverage;
  if (cov) {
    const elig = cov.eligibilityChecks[0];
    if (elig?.status === "INACTIVE")
      out.push({
        key: "coverage-inactive",
        rule: "coverage",
        severity: "warning",
        text: `The last eligibility check found ${cov.payer.name} coverage inactive.`,
      });
    if (!cov.payer.claimsSupported)
      out.push({
        key: "payer-no-edi",
        rule: "coverage",
        severity: "error",
        text: `${cov.payer.name} does not accept electronic claims through the clearinghouse.`,
      });
    const rules = (cov.payer.claimRules ?? {}) as { authRequiredCodes?: string[] };
    const needAuth = codes.filter((code) => rules.authRequiredCodes?.includes(code));
    if (needAuth.length && !(await priorAuthNumber(tx, c.enc.patientId, cov.id, serviceDate)))
      out.push({
        key: "auth",
        rule: "auth",
        severity: "error",
        text: `${cov.payer.name} requires prior authorisation for ${needAuth.join(", ")}; none is approved for this date.`,
      });
    const deadline = new Date(serviceDate.getTime() + cov.payer.timelyFilingDays * 86_400_000);
    if (deadline < new Date())
      out.push({
        key: "filing",
        rule: "filing",
        severity: "error",
        text: `The ${cov.payer.timelyFilingDays}-day filing limit for ${cov.payer.name} has passed.`,
      });
    const addr = await tx.patientAddress.findFirst({ where: { patientId: c.enc.patientId } });
    if (!addr)
      out.push({
        key: "patient-address",
        rule: "coverage",
        severity: "error",
        text: "The patient has no address; an 837P needs the subscriber address.",
      });
  }
  return out;
}

export async function priorAuthNumber(
  tx: Tx,
  patientId: string,
  coverageId: string,
  on: Date,
): Promise<string | null> {
  const a = await tx.authorization.findFirst({
    where: {
      patientId,
      coverageId,
      status: "APPROVED",
      number: { not: null },
      OR: [{ validFrom: null }, { validFrom: { lte: on } }],
      AND: [{ OR: [{ validTo: null }, { validTo: { gte: on } }] }],
    },
  });
  return a?.number ?? null;
}

/** INV-FIN-03 on a stored claim (submit and resubmit re-check after corrections). */
export function scrubStoredClaim(claim: Claim & { lines: ClaimLine[] }): CodingEdit[] {
  const out: CodingEdit[] = [];
  const inv = "INV-FIN-03";
  if (!isValidNpi(claim.renderingProviderNpi))
    out.push({
      key: "npi-rendering",
      rule: "provider",
      severity: "error",
      text: "Rendering provider NPI is missing or invalid.",
      invariant: inv,
    });
  if (!isValidNpi(claim.billingProviderNpi))
    out.push({
      key: "npi-billing",
      rule: "provider",
      severity: "error",
      text: "Billing provider NPI is missing or invalid.",
      invariant: inv,
    });
  if (digits(claim.billingTin).length !== 9)
    out.push({
      key: "tin",
      rule: "provider",
      severity: "error",
      text: "Billing TIN is missing or not 9 digits.",
      invariant: inv,
    });
  if (!claim.placeOfService)
    out.push({
      key: "pos",
      rule: "pos",
      severity: "error",
      text: "Place of service is missing.",
      invariant: inv,
    });
  if (!claim.lines.length)
    out.push({
      key: "lines",
      rule: "dx-pointer",
      severity: "error",
      text: "The claim has no lines.",
      invariant: inv,
    });
  for (const l of claim.lines)
    if (!l.dxPointers.length)
      out.push({
        key: `dx:${l.id}`,
        rule: "dx-pointer",
        severity: "error",
        text: `Line ${l.lineNumber} (${l.code}) has no diagnosis pointer.`,
        lineId: l.id,
        invariant: inv,
      });
  return out;
}

const sexCode = (g: string): "M" | "F" | "U" => (g === "MALE" ? "M" : g === "FEMALE" ? "F" : "U");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const REL: Record<string, "01" | "19" | "G8"> = { spouse: "01", child: "19" };

/** 837P data for a stored claim (agile-emr loadClaimData, rebuilt on this schema). Throws a list of what is missing. */
export async function claimDataFor(
  tx: Tx,
  claim: Claim & { lines: ClaimLine[] },
): Promise<{ ok: true; data: ClaimData } | { ok: false; missing: string[] }> {
  const [practice, patient, coverage, enc] = await Promise.all([
    tx.practice.findUniqueOrThrow({ where: { id: claim.practiceId } }),
    tx.patient.findUniqueOrThrow({ where: { id: claim.patientId }, include: { addresses: true } }),
    tx.coverage.findUniqueOrThrow({ where: { id: claim.coverageId }, include: { payer: true } }),
    claim.encounterId ? tx.encounter.findUnique({ where: { id: claim.encounterId } }) : null,
  ]);
  const rendering = enc
    ? await tx.practitioner.findUnique({ where: { id: enc.practitionerId } })
    : null;
  const missing: string[] = [];
  const a = patient.addresses[0];
  const zip = digits(a?.postalCode);
  if (!a || (zip.length !== 5 && zip.length !== 9))
    missing.push("Patient address with a 5- or 9-digit ZIP");
  const pzip = digits(practice.postalCode);
  if (pzip.length !== 5 && pzip.length !== 9) missing.push("Practice billing address ZIP");
  let phone = digits(practice.phone);
  if (phone.length === 11 && phone.startsWith("1")) phone = phone.slice(1);
  if (phone.length !== 10) missing.push("Practice contact phone (10 digits)");
  const subscriberRp =
    coverage.relationshipToSubscriber !== "self" && coverage.subscriberRelatedPersonId
      ? await tx.relatedPerson.findUnique({ where: { id: coverage.subscriberRelatedPersonId } })
      : null;
  if (coverage.relationshipToSubscriber !== "self" && !subscriberRp?.birthDate)
    missing.push("Subscriber name and date of birth");
  if (missing.length) return { ok: false, missing };
  const address = {
    address1: a!.line1,
    address2: a!.line2,
    city: a!.city,
    state: a!.state.toUpperCase(),
    postalCode: zip,
  };
  // ClaimLine.dxPointers are letters into the claim's diagnosis list; icd10Codes are the same codes resolved.
  const dxOrder: string[] = [];
  for (const l of claim.lines)
    l.dxPointers.forEach((letter, i) => {
      dxOrder[letter.charCodeAt(0) - 65] = l.icd10Codes[i]!;
    });
  const memberId = decryptField(coverage.memberId);
  const data: ClaimData = {
    payer: { stediPayerId: coverage.payer.clearinghousePayerId, name: coverage.payer.name },
    billing: {
      npi: claim.billingProviderNpi,
      taxId: digits(claim.billingTin),
      taxonomyCode: practice.taxonomyCode,
      organizationName: practice.legalName,
      address: {
        address1: practice.addressLine1,
        address2: practice.addressLine2,
        city: practice.city,
        state: practice.state,
        postalCode: pzip,
      },
      phone,
    },
    rendering:
      claim.renderingProviderNpi !== claim.billingProviderNpi
        ? {
            npi: claim.renderingProviderNpi,
            firstName: rendering?.firstName ?? "",
            lastName: rendering?.lastName ?? "",
          }
        : null,
    subscriber: subscriberRp
      ? {
          memberId,
          groupNumber: coverage.groupNumber,
          firstName: subscriberRp.firstName,
          lastName: subscriberRp.lastName,
          dob: iso(subscriberRp.birthDate!),
          sex: "U",
          address,
        }
      : {
          memberId,
          groupNumber: coverage.groupNumber,
          firstName: patient.firstName,
          lastName: patient.lastName,
          dob: iso(patient.birthDate),
          sex: sexCode(patient.administrativeGender),
          address,
        },
    dependent: subscriberRp
      ? {
          firstName: patient.firstName,
          lastName: patient.lastName,
          dob: iso(patient.birthDate),
          sex: sexCode(patient.administrativeGender),
          relationshipCode: REL[coverage.relationshipToSubscriber] ?? "G8",
          address,
        }
      : null,
    diagnoses: dxOrder.map(normalizeIcd10),
    lines: claim.lines
      .sort((x, y) => x.lineNumber - y.lineNumber)
      .map((l) => ({
        procedureCode: l.code,
        modifiers: l.modifiers,
        units: l.units.toString(),
        amount: l.charge.toFixed(2),
        serviceDate: iso(claim.serviceDateFrom),
        diagnosisPointers: l.dxPointers.map((letter) => letter.charCodeAt(0) - 64),
      })),
    // Medicare Part B is "MB", commercial "CI" (agile-emr); Medicaid "MC". OPEN-Q23: per-plan filing code.
    claimFilingCode: /medicare/i.test(coverage.payer.name)
      ? "MB"
      : /medicaid/i.test(coverage.payer.name)
        ? "MC"
        : "CI",
    placeOfServiceCode: claim.placeOfService,
    frequencyCode: (claim.frequencyCode as "1" | "7" | "8") ?? "1",
    originalReference: claim.frequencyCode === "1" ? null : claim.payerClaimControlNumber,
    priorAuthNumber: claim.priorAuthNumber,
    totalCharge: claim.totalBilled.toFixed(2),
  };
  return { ok: true, data };
}

/** Our claim id on the wire: the claim number without separators (max 17 alphanumerics). */
export const pcnOf = (claimNumber: string) => claimNumber.replace(/[^A-Za-z0-9]/g, "").slice(0, 17);
