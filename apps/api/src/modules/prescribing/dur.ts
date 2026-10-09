import type {
  AllergyIntolerance,
  CdsSeverity,
  DurAlert,
  DurAlertType,
  MedicationRequest,
  Prisma,
  Tx,
} from "../../db.js";
import { getDrugConcept } from "../../gateways/referenceData/index.js";
import type { DrugConceptData } from "../../gateways/referenceData/rxnav.js";
import { ALLERGY_CLASSES, KNOWN_INGREDIENTS, severeInteraction } from "./interactions.js";

/**
 * Drug utilisation review (flow:encounter/05, INV-SAFE-06). Ours, not the vendor's:
 *   - drug-allergy: the drug's RxNorm ingredients against the patient's active allergies -- RxNorm-coded allergies by
 *     ingredient RXCUI, SNOMED drug classes through ALLERGY_CLASSES, uncoded medication allergies by ingredient name.
 *     Always INTERRUPTIVE.
 *   - drug-drug: the curated severe table (interactions.ts) against active medications and the patient's other
 *     draft/active prescriptions. INTERRUPTIVE.
 *   - duplicate therapy: a shared RxNorm ingredient with an active medication. PASSIVE (acknowledged at signing).
 * Dose range checking needs a licensed knowledge base and is not done (OPEN-Q19).
 *
 * DurAlert is append-only. A check inserts a `pending` row per finding the first time it is seen; a decision inserts a
 * new row with the outcome (`evidence.decides` = the pending row). The current state of a finding is its latest row,
 * matched by `evidence.key`, which includes the drug's RXCUI: changing the drug produces new findings that need new
 * decisions, while re-checking the same drug keeps earlier decisions.
 */

export interface Finding {
  key: string;
  type: DurAlertType;
  severity: CdsSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

interface OtherMed {
  source: "MedicationStatement" | "MedicationRequest";
  id: string;
  display: string;
  rxcui: string | null;
}

const ACTIVE_STATEMENT = ["ACTIVE", "INTENDED", "ON_HOLD", "UNKNOWN"] as const;

async function ingredientsOfMed(
  tx: Tx,
  med: OtherMed,
): Promise<{ rxcuis: string[]; names: string[] }> {
  if (med.rxcui) {
    try {
      const c = await getDrugConcept(tx, med.rxcui);
      if (c)
        return { rxcuis: c.ingredientRxcuis, names: c.ingredientNames.map((n) => n.toLowerCase()) };
    } catch {
      /* RxNav unavailable: fall back to the text */
    }
  }
  const text = med.display.toLowerCase();
  const names = KNOWN_INGREDIENTS.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
  return { rxcuis: [], names };
}

function reactionText(a: AllergyIntolerance): string | null {
  const r = a.reactions as { items?: Array<{ manifestation?: string; severity?: string }> } | null;
  const first = r?.items?.[0];
  return first ? [first.manifestation, first.severity].filter(Boolean).join(" · ") : null;
}

function allergyMatch(
  concept: DrugConceptData,
  a: AllergyIntolerance,
): { via: string; ingredient: string } | null {
  const names = concept.ingredientNames.map((n) => n.toLowerCase());
  if (a.substanceSystem === "RXNORM") {
    const i = concept.ingredientRxcuis.indexOf(a.substanceCode);
    if (i >= 0) return { via: "ingredient", ingredient: names[i] ?? a.substanceDisplay };
  }
  if (a.substanceSystem === "SNOMEDCT") {
    const cls = ALLERGY_CLASSES[a.substanceCode];
    const hit = cls && names.find((n) => cls.ingredients.includes(n));
    if (hit) return { via: `class:${cls.name}`, ingredient: hit };
  }
  // Uncoded or unmapped medication allergy: whole-word ingredient name in the allergy text.
  if (a.category === "MEDICATION" || a.category === "BIOLOGIC") {
    const text = a.substanceDisplay.toLowerCase();
    const hit = names.find((n) => n.length > 3 && new RegExp(`\\b${n}\\b`).test(text));
    if (hit) return { via: "name", ingredient: hit };
  }
  return null;
}

/** Runs DUR for one prescription. Throws DrugTerminologyUnavailableError when the drug can't be resolved. */
export async function durFindings(
  tx: Tx,
  rx: MedicationRequest,
  concept: DrugConceptData,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const drug = concept.name;

  const allergies = await tx.allergyIntolerance.findMany({
    where: {
      patientId: rx.patientId,
      stagingStatus: "ACTIVE",
      clinicalStatus: "ACTIVE",
      verificationStatus: { notIn: ["REFUTED", "ENTERED_IN_ERROR"] },
    },
  });
  for (const a of allergies) {
    const m = allergyMatch(concept, a);
    if (!m) continue;
    const reaction = reactionText(a);
    findings.push({
      key: `DRUG_ALLERGY:${rx.rxnormCode}:${a.id}`,
      type: "DRUG_ALLERGY",
      severity: "INTERRUPTIVE",
      message:
        m.via.startsWith("class:") && m.ingredient !== a.substanceDisplay.toLowerCase()
          ? `${capitalise(m.ingredient)} is a ${m.via.slice(6)}`
          : `Allergy to ${a.substanceDisplay}`,
      evidence: {
        allergyId: a.id,
        allergy: a.substanceDisplay,
        reaction,
        criticality: a.criticality,
        verificationStatus: a.verificationStatus,
        recordedAt: a.createdAt.toISOString(),
        recordedById: a.recordedById,
        ingredient: m.ingredient,
        match: m.via,
      },
    });
  }

  // Other medications: the active list and this patient's other open prescriptions (renewals exclude the original).
  const [statements, requests] = await Promise.all([
    tx.medicationStatement.findMany({
      where: {
        patientId: rx.patientId,
        stagingStatus: "ACTIVE",
        status: { in: [...ACTIVE_STATEMENT] },
        ...(rx.priorPrescriptionId ? { NOT: { prescriptionId: rx.priorPrescriptionId } } : {}),
      },
    }),
    tx.medicationRequest.findMany({
      where: {
        patientId: rx.patientId,
        id: { notIn: [rx.id, ...(rx.priorPrescriptionId ? [rx.priorPrescriptionId] : [])] },
        status: { in: ["DRAFT", "ACTIVE"] },
      },
    }),
  ]);
  const listed = new Set(statements.map((s) => s.prescriptionId).filter(Boolean));
  const others: OtherMed[] = [
    ...statements.map((s) => ({
      source: "MedicationStatement" as const,
      id: s.id,
      display: s.display,
      rxcui: s.rxnormCode,
    })),
    ...requests
      .filter((r) => !listed.has(r.id))
      .map((r) => ({
        source: "MedicationRequest" as const,
        id: r.id,
        display: r.display,
        rxcui: r.rxnormCode,
      })),
  ];
  const mine = concept.ingredientNames.map((n) => n.toLowerCase());
  for (const o of others) {
    const theirs = await ingredientsOfMed(tx, o);
    const rule = severeInteraction(mine, theirs.names);
    if (rule)
      findings.push({
        key: `DRUG_DRUG:${rx.rxnormCode}:${o.id}`,
        type: "DRUG_DRUG",
        severity: "INTERRUPTIVE",
        message: `${drug} interacts with ${o.display}`,
        evidence: { with: o.display, withType: o.source, withId: o.id, effect: rule.effect },
      });
    const shared =
      (o.rxcui && o.rxcui === rx.rxnormCode) ||
      theirs.rxcuis.some((i) => concept.ingredientRxcuis.includes(i)) ||
      theirs.names.some((n) => mine.includes(n));
    if (shared)
      findings.push({
        key: `DUPLICATE_THERAPY:${rx.rxnormCode}:${o.id}`,
        type: "DUPLICATE_THERAPY",
        severity: "PASSIVE",
        message: `Same ingredient as ${o.display}`,
        evidence: { with: o.display, withType: o.source, withId: o.id },
      });
  }
  return findings;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const keyOf = (a: Pick<DurAlert, "evidence">) =>
  ((a.evidence ?? {}) as { key?: string }).key ?? "";

/** Latest row per finding key for a prescription (the current state of each finding). */
export async function currentAlerts(tx: Tx, rxId: string): Promise<Map<string, DurAlert>> {
  const rows = await tx.durAlert.findMany({
    where: { medicationRequestId: rxId },
    orderBy: { decidedAt: "asc" },
  });
  const out = new Map<string, DurAlert>();
  for (const r of rows) out.set(keyOf(r), r);
  return out;
}

/**
 * Records the findings (a pending row for each one not seen before) and returns the current row for each finding,
 * interruptive first.
 */
export async function recordFindings(
  tx: Tx,
  rx: MedicationRequest,
  findings: Finding[],
): Promise<DurAlert[]> {
  const current = await currentAlerts(tx, rx.id);
  const out: DurAlert[] = [];
  for (const f of findings) {
    let row = current.get(f.key);
    if (!row) {
      row = await tx.durAlert.create({
        data: {
          practiceId: rx.practiceId,
          medicationRequestId: rx.id,
          type: f.type,
          severity: f.severity,
          message: f.message,
          evidence: { key: f.key, ...f.evidence } as Prisma.InputJsonValue,
          outcome: "pending",
        },
      });
    }
    out.push(row);
  }
  const rank = (s: CdsSeverity) => ["HARD_STOP", "INTERRUPTIVE", "PASSIVE", "INFO"].indexOf(s);
  return out.sort((a, b) => rank(a.severity) - rank(b.severity));
}

export const isInterruptive = (a: Pick<DurAlert, "severity">) =>
  a.severity === "INTERRUPTIVE" || a.severity === "HARD_STOP";
