import { roleEnum, roles as roleDefs } from "@agile-emr/shared";
import type { MedicationRequest, Prisma } from "../../db.js";
import { getDrugConcept, isControlledConcept } from "../../gateways/referenceData/index.js";
import {
  DrugTerminologyUnavailableError,
  type DrugConceptData,
} from "../../gateways/referenceData/rxnav.js";
import { getRedis } from "../../redis.js";
import { writeAuditEntries } from "../../platform/audit.js";
import { usableFactors, verifyTotp } from "../auth/mfa.js";
import type { Ctx } from "../../platform/http/context.js";
import {
  type Blocker,
  Problem,
  forbidden,
  integrationUnavailable,
  invariantBlocked,
  unprocessable,
} from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { writeVersion } from "../../platform/versioning.js";
import { currentAlerts, durFindings, isInterruptive } from "./dur.js";

/**
 * Prescription signing (flow:encounter/05, flow:refills/04). Shared by signPrescription and approveRxRequest.
 *   INV-SAFE-01  only roles whose can_sign includes "prescription" (x-roles plus roles.yaml), signer is a practitioner
 *   INV-SAFE-06  every interruptive DUR finding has an override with a stored reason (or the Rx was removed);
 *                passive findings are acknowledged (acknowledgedAlertIds) and the acknowledgement is stored
 *   INV-SAFE-05  controlled substances: EPCS-enabled prescriber with a current DEA registration for the schedule,
 *                a PDMP query for this patient in the last 24 hours or a recorded exception, a fresh step-up
 *                (password + factor) and the EPCS second-factor code at signing (3 wrong codes lock EPCS for 15 min)
 */

export const PDMP_MAX_AGE_MS = 24 * 3600 * 1000; // OPEN-Q21: state look-back rules vary; narrowest common rule.
const EPCS_MAX_FAILURES = 3;
const EPCS_LOCK_SECONDS = 15 * 60;

const ROMAN_TO_DEA: Record<string, string[]> = {
  I: ["1"],
  II: ["2", "2N"],
  III: ["3", "3N"],
  IV: ["4"],
  V: ["5"],
};

export async function resolveConcept(rxcui: string, ctx: Ctx): Promise<DrugConceptData> {
  let concept: DrugConceptData | null;
  try {
    concept = await getDrugConcept(ctx.db, rxcui);
  } catch (e) {
    if (e instanceof DrugTerminologyUnavailableError)
      throw integrationUnavailable(
        "Drug information isn't available right now, so the prescription can't be checked. Try again in a moment.",
      );
    throw e;
  }
  if (!concept)
    throw unprocessable(
      "not_prescribable",
      "Choose a prescribable product (drug, strength and form).",
      {
        errors: [{ field: "rxnormCode", code: "invalid", message: "Not a prescribable product." }],
      },
    );
  return concept;
}

export function requirePrescriber(ctx: Ctx): string {
  const me = ctx.staff();
  const can = roleDefs[me.role].can_sign as readonly string[];
  if (!can.includes("prescription"))
    throw forbidden("forbidden", "Your role can't sign prescriptions. Pend it for a provider.");
  if (!me.practitionerId)
    throw forbidden("not_a_prescriber", "Only a registered prescriber can sign prescriptions.");
  return me.practitionerId;
}

export interface SignOptions {
  pharmacyId?: string | null;
  pdmpQueryId?: string | null;
  epcsToken?: string | null;
  acknowledgedAlertIds?: string[];
}

interface Prepared {
  rx: MedicationRequest;
  concept: DrugConceptData;
  controlled: boolean;
  pharmacyId: string;
  pdmpQueryId: string | null;
}

/** Validates everything and returns the blockers (empty = ready). Writes nothing. */
async function prepare(
  ctx: Ctx,
  rx: MedicationRequest,
  opts: SignOptions,
  blockers: Blocker[],
): Promise<Prepared> {
  const concept = await resolveConcept(rx.rxnormCode, ctx);
  const controlled = isControlledConcept(concept);
  const tag = rx.display;

  if (!rx.sigText.trim())
    blockers.push({ code: "sig_missing", text: `${tag}: add patient instructions.` });
  if (!(Number(rx.quantity) > 0))
    blockers.push({ code: "quantity_missing", text: `${tag}: enter a quantity.` });
  if (controlled && concept.deaSchedule === "II" && rx.refills > 0)
    blockers.push({
      code: "refills_not_allowed",
      text: `${tag}: Schedule II prescriptions can't have refills.`,
      invariant: "INV-SAFE-05",
    });
  if (controlled && concept.deaSchedule !== "II" && rx.refills > 5)
    blockers.push({
      code: "refills_not_allowed",
      text: `${tag}: controlled prescriptions allow at most 5 refills.`,
      invariant: "INV-SAFE-05",
    });

  let pharmacyId = opts.pharmacyId ?? rx.pharmacyId;
  if (!pharmacyId) {
    const patient = await ctx.db.patient.findUnique({ where: { id: rx.patientId } });
    pharmacyId = patient?.preferredPharmacyId ?? null;
  }
  const pharmacy = pharmacyId
    ? await ctx.db.pharmacy.findUnique({ where: { id: pharmacyId } })
    : null;
  if (!pharmacy) blockers.push({ code: "pharmacy_missing", text: `${tag}: choose a pharmacy.` });
  else if (controlled && !pharmacy.epcsEnabled)
    blockers.push({
      code: "pharmacy_not_epcs",
      text: `${tag}: ${pharmacy.name} doesn't accept electronic controlled-substance prescriptions. Choose another pharmacy.`,
      invariant: "INV-SAFE-05",
    });

  // INV-SAFE-06: decisions on the current findings.
  const findings = await durFindings(ctx.db, rx, concept);
  const current = await currentAlerts(ctx.db, rx.id);
  const ack = new Set(opts.acknowledgedAlertIds ?? []);
  for (const f of findings) {
    const row = current.get(f.key);
    const decided = row && ["overridden", "acknowledged"].includes(row.outcome);
    if (isInterruptive(f)) {
      if (!row || row.outcome !== "overridden" || !row.overrideReason?.trim())
        blockers.push({
          code: "dur_alert_undecided",
          text: `${tag}: ${f.message}. Switch, remove, or override with a reason.`,
          invariant: "INV-SAFE-06",
        });
    } else if (!decided && !(row && ack.has(row.id))) {
      blockers.push({
        code: "dur_alert_unacknowledged",
        text: `${tag}: ${f.message}. Review the alert.`,
        invariant: "INV-SAFE-06",
      });
    }
  }

  // INV-SAFE-05: PDMP check or exception.
  let pdmpQueryId: string | null = null;
  if (controlled) {
    const q = opts.pdmpQueryId
      ? await ctx.db.pdmpQuery.findUnique({ where: { id: opts.pdmpQueryId } })
      : null;
    if (q && q.patientId === rx.patientId && Date.now() - q.queriedAt.getTime() <= PDMP_MAX_AGE_MS)
      pdmpQueryId = q.id;
    else if (!rx.pdmpExceptionReason?.trim())
      blockers.push({
        code: "pdmp_required",
        text: `${tag}: check the PDMP for this patient (within 24 hours) or record why it couldn't be checked.`,
        invariant: "INV-SAFE-05",
      });
  }
  return { rx, concept, controlled, pharmacyId: pharmacy?.id ?? "", pdmpQueryId };
}

async function requireEpcs(
  ctx: Ctx,
  practitionerId: string,
  schedules: string[],
  token?: string | null,
) {
  const me = ctx.staff();
  const prac = await ctx.db.practitioner.findUnique({
    where: { id: practitionerId },
    include: { deaRegistrations: true },
  });
  if (!prac?.epcsEnabled || !prac.epcsProofedAt)
    throw forbidden(
      "epcs_not_enabled",
      "You aren't set up for electronic controlled-substance prescribing (EPCS).",
    );
  const today = new Date();
  for (const s of schedules) {
    const accepted = ROMAN_TO_DEA[s] ?? [];
    if (
      !prac.deaRegistrations.some(
        (d) => d.expiresOn > today && d.schedules.some((x) => accepted.includes(x)),
      )
    )
      throw forbidden(
        "dea_not_registered",
        `You have no current DEA registration for Schedule ${s}.`,
      );
  }
  // Knowledge factor: password re-entered with a second factor in the step-up window.
  ctx.requireStepUp();
  // Possession factor at the moment of signing, with a lockout after repeated failures.
  const redis = getRedis();
  const lockKey = `epcs:fail:${me.userId}`;
  const failures = Number((await redis.get(lockKey)) ?? 0);
  if (failures >= EPCS_MAX_FAILURES)
    throw new Problem(
      423,
      "epcs_locked",
      "EPCS signing is locked after 3 wrong codes. Wait 15 minutes or contact your administrator.",
    );
  const user = await ctx.db.user.findUniqueOrThrow({
    where: { id: me.userId },
    include: { mfaFactors: true },
  });
  const totp = usableFactors(user.mfaFactors).find((f) => f.type === "TOTP");
  if (!totp)
    throw forbidden("epcs_factor_required", "EPCS needs an authenticator app on your account.");
  if (!verifyTotp(totp.secret, token ?? undefined)) {
    ctx.onFailure(async (tx) => {
      const n = await redis.incr(lockKey);
      if (n === 1) await redis.expire(lockKey, EPCS_LOCK_SECONDS);
      // Every failed EPCS attempt is audited, including the one that locks EPCS.
      await writeAuditEntries(
        tx,
        {
          practiceId: me.practiceId,
          actorType: "staff",
          actorId: me.userId,
          actorRole: roleEnum(me.role),
          sessionId: me.sessionId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        [
          {
            action: "SIGN",
            outcome: "FAILURE",
            operationId: ctx.op.id,
            resourceType: "User",
            resourceId: me.userId,
            detail: { epcs: n >= EPCS_MAX_FAILURES ? "locked" : "wrong_code", attempt: n },
          },
        ],
      );
    });
    throw unprocessable(
      "epcs_token_invalid",
      "That code didn't work. Enter the current code from your authenticator app.",
    );
  }
  await redis.del(lockKey);
}

/**
 * Signs draft prescriptions. Throws 422 invariant_blocked listing every blocker; on success each is ACTIVE with the
 * signer, EPCS and PDMP evidence stored, acknowledgements recorded, and the active medication list updated.
 */
export async function signDrafts(
  ctx: Ctx,
  rxs: MedicationRequest[],
  opts: SignOptions,
): Promise<MedicationRequest[]> {
  const me = ctx.staff();
  const practitionerId = requirePrescriber(ctx);
  for (const rx of rxs) assertTransition("prescription", rx.status, "active", me.role);

  const blockers: Blocker[] = [];
  const prepared: Prepared[] = [];
  for (const rx of rxs) prepared.push(await prepare(ctx, rx, opts, blockers));
  if (blockers.length)
    throw invariantBlocked(blockers, "Some prescriptions need attention before signing.");

  const controlled = prepared.filter((p) => p.controlled);
  const now = new Date();
  if (controlled.length)
    await requireEpcs(
      ctx,
      practitionerId,
      [...new Set(controlled.map((p) => p.concept.deaSchedule ?? "II"))],
      opts.epcsToken,
    );

  const out: MedicationRequest[] = [];
  for (const p of prepared) {
    // Stored acknowledgements for the passive findings (reportable alongside overrides).
    const current = await currentAlerts(ctx.db, p.rx.id);
    for (const row of current.values())
      if (
        row.outcome === "pending" &&
        !isInterruptive(row) &&
        opts.acknowledgedAlertIds?.includes(row.id)
      )
        await ctx.db.durAlert.create({
          data: {
            practiceId: row.practiceId,
            medicationRequestId: row.medicationRequestId,
            type: row.type,
            severity: row.severity,
            message: row.message,
            evidence: { ...(row.evidence as object), decides: row.id } as Prisma.InputJsonValue,
            outcome: "acknowledged",
            decidedById: me.userId,
          },
        });
    const signed = await ctx.db.medicationRequest.update({
      where: { id: p.rx.id, version: p.rx.version },
      data: {
        status: "ACTIVE",
        prescriberId: practitionerId,
        display: p.concept.name,
        isControlled: p.controlled,
        deaSchedule: p.controlled ? (p.concept.deaSchedule ?? "unverified") : null,
        pharmacyId: p.pharmacyId,
        signedById: me.userId,
        signedAt: now,
        epcsTwoFactorAt: p.controlled ? now : null,
        pdmpQueryId: p.pdmpQueryId,
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, signed.practiceId, "MedicationRequest", signed, me.userId, "signed");
    await updateMedicationList(ctx, signed);
    ctx.audit.add({
      action: "SIGN",
      patientId: signed.patientId,
      resourceType: "MedicationRequest",
      resourceId: signed.id,
      operationId: ctx.op.id,
      detail: {
        controlled: p.controlled,
        epcs: p.controlled,
        pdmpQueryId: p.pdmpQueryId,
        pdmpException: p.controlled && !p.pdmpQueryId ? true : undefined,
      },
    });
    out.push(signed);
  }
  return out;
}

/** The active medication list follows what we prescribe: a renewal updates the original's entry. */
async function updateMedicationList(ctx: Ctx, rx: MedicationRequest) {
  const existing = rx.priorPrescriptionId
    ? await ctx.db.medicationStatement.findFirst({
        where: { prescriptionId: rx.priorPrescriptionId, stagingStatus: "ACTIVE" },
      })
    : null;
  const data = {
    rxnormCode: rx.rxnormCode,
    display: rx.display,
    dosageText: rx.sigText,
    prescriptionId: rx.id,
    status: "ACTIVE" as const,
    daysSupply: rx.daysSupply,
  };
  if (existing)
    await ctx.db.medicationStatement.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 } },
    });
  else
    await ctx.db.medicationStatement.create({
      data: {
        ...data,
        practiceId: rx.practiceId,
        patientId: rx.patientId,
        effectiveStart: rx.signedAt ?? new Date(),
        reasonConditionId: rx.reasonConditionId,
        recordedById: ctx.staff().userId,
      },
    });
}
