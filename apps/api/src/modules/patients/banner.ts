import type { Patient, Tx } from "../../db.js";
import { centsToMoney, patientBalanceCents } from "../../platform/ledger.js";
import { RESTRICTED_LABELS } from "../../platform/patientAccess.js";
import type { PatientBanner } from "@agile-emr/shared";
import { ageText, displayName } from "./domain.js";
import { patientFlags } from "./service.js";

/** Banner parts beyond the Patient row (INV-ID-01 identity + allergies, coverage, balance). */
export async function bannerExtras(tx: Tx, p: Patient) {
  const [allergies, pcp, coverage, notes, balance] = await Promise.all([
    tx.allergyIntolerance.findMany({
      where: {
        patientId: p.id,
        stagingStatus: "ACTIVE",
        clinicalStatus: "ACTIVE",
        verificationStatus: { notIn: ["REFUTED", "ENTERED_IN_ERROR"] },
      },
      orderBy: [{ criticality: "desc" }, { substanceDisplay: "asc" }],
    }),
    p.pcpPractitionerId ? tx.practitioner.findUnique({ where: { id: p.pcpPractitionerId } }) : null,
    tx.coverage.findFirst({
      where: { patientId: p.id, status: "active" },
      orderBy: { order: "asc" },
      include: { payer: true, eligibilityChecks: { orderBy: { requestedAt: "desc" }, take: 1 } },
    }),
    tx.clinicalNote.findMany({
      where: { patientId: p.id, NOT: { securityLabels: { isEmpty: true } } },
      select: { securityLabels: true },
    }),
    patientBalanceCents(tx, p.id),
  ]);
  const plan = coverage?.planId
    ? await tx.payerPlan.findUnique({ where: { id: coverage.planId } })
    : null;
  const elig = coverage?.eligibilityChecks[0]?.status;
  const eligText =
    elig === "ACTIVE"
      ? "Eligible"
      : elig === "INACTIVE"
        ? "Inactive"
        : elig === "ERROR"
          ? "Not verified"
          : elig === "PENDING"
            ? "Checking"
            : "Not checked";
  const flags: string[] = [];
  if (!coverage) flags.push("self-pay");
  if (balance > 0) flags.push("balance-due");
  return {
    allergies: allergies.map((a) => ({
      display: a.substanceDisplay,
      ...(a.criticality ? { criticality: a.criticality } : {}),
    })),
    pcp: pcp
      ? `${pcp.credential === "MD" || pcp.credential === "DO" ? "Dr. " : ""}${pcp.firstName} ${pcp.lastName}${pcp.credential && pcp.credential !== "MD" && pcp.credential !== "DO" ? `, ${pcp.credential}` : ""}`
      : undefined,
    primaryCoverage: coverage ? `${plan?.name ?? coverage.payer.name} · ${eligText}` : undefined,
    eligibility: elig,
    balance: centsToMoney(balance),
    restrictedRows: notes.filter((n) => n.securityLabels.some((l) => RESTRICTED_LABELS.includes(l)))
      .length,
    part2Rows: notes.filter((n) => n.securityLabels.includes("42CFRPart2")).length,
    flags,
  };
}

/** PatientBanner (INV-ID-01): name, DOB + age, MRN always; allergies, coverage, balance, flags. */
export async function buildBanner(tx: Tx, p: Patient): Promise<PatientBanner> {
  const extras = await bannerExtras(tx, p);
  return {
    id: p.id,
    mrn: p.mrn,
    name: displayName(p),
    ...(p.preferredName ? { preferredName: p.preferredName } : {}),
    ...(p.pronouns ? { pronouns: p.pronouns } : {}),
    birthDate: p.birthDate.toISOString().slice(0, 10),
    age: ageText(p.birthDate, new Date(), p.deceasedAt),
    ...(p.sexForClinicalUse ? { sexForClinicalUse: p.sexForClinicalUse } : {}),
    ...(p.photoFileId ? { photoFileId: p.photoFileId } : {}),
    allergies: extras.allergies,
    noKnownAllergies: p.noKnownAllergies,
    ...(p.codeStatus ? { codeStatus: p.codeStatus } : {}),
    ...(extras.pcp ? { pcp: extras.pcp } : {}),
    ...(extras.primaryCoverage ? { primaryCoverage: extras.primaryCoverage } : {}),
    ...(extras.eligibility ? { eligibility: extras.eligibility } : {}),
    balance: extras.balance,
    ...(p.preferredLanguage ? { preferredLanguage: p.preferredLanguage } : {}),
    interpreterNeeded: p.interpreterNeeded,
    flags: [...patientFlags(p), ...extras.flags],
    restricted:
      p.securityLabels.some((l) => RESTRICTED_LABELS.includes(l)) || extras.restrictedRows > 0,
    part2: p.securityLabels.includes("42CFRPart2") || extras.part2Rows > 0,
  };
}
