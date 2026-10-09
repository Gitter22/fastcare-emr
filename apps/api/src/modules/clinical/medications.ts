import type { MedicationStatementView } from "@agile-emr/shared";
import type { MedicationStatement, MedicationStatementStatus, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import {
  conflict,
  integrationUnavailable,
  notFound,
  unprocessable,
} from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { erxGateway } from "../../gateways/erx/index.js";
import { sendCancel } from "../prescribing/erx.js";
import { ingredientsOf } from "../../gateways/referenceData/index.js";
import { reconcileStaged, recordProvenance, stagingFilter } from "./provenance.js";

/**
 * Medication list and reconciliation (chart.medications, encounter.rooming med review). One trusted list: staff
 * entries are active at once; portal, outside-record and pharmacy items arrive STAGED and need a reconcile decision
 * (INV-DATA-01). Prescribing (MedicationRequest) and pharmacy fill history belong to ErxGateway (S4).
 */

const CLOSED: MedicationStatementStatus[] = [
  "STOPPED",
  "COMPLETED",
  "ENTERED_IN_ERROR",
  "NOT_TAKEN",
];

/**
 * Medication views. Staged items get `possibleDuplicateOf`: the active statement with the same drug or a shared
 * RxNorm ingredient (Lipitor vs atorvastatin), so the reconcile card can say "possible duplicate".
 */
export async function medicationViews(
  tx: Tx,
  rows: MedicationStatement[],
): Promise<MedicationStatementView[]> {
  const rxIds = rows.map((r) => r.prescriptionId).filter((x): x is string => !!x);
  const requests = rxIds.length
    ? await tx.medicationRequest.findMany({ where: { id: { in: rxIds } } })
    : [];
  const staged = rows.filter((r) => r.stagingStatus === "STAGED");
  let dupes = new Map<string, string>();
  if (staged.length) {
    const active = await tx.medicationStatement.findMany({
      where: {
        patientId: staged[0]!.patientId,
        stagingStatus: "ACTIVE",
        status: { notIn: CLOSED },
      },
    });
    const coded = [...staged, ...active].map((m) => m.rxnormCode).filter((c): c is string => !!c);
    const ingredients = await ingredientsOf(tx, coded);
    const key = (m: MedicationStatement) => m.display.toLowerCase().split(/[\s-]/)[0] ?? "";
    dupes = new Map(
      staged.flatMap((s) => {
        const mine = s.rxnormCode ? (ingredients.get(s.rxnormCode) ?? []) : [];
        const hit = active.find(
          (a) =>
            (s.rxnormCode && a.rxnormCode === s.rxnormCode) ||
            (a.rxnormCode &&
              mine.some((i) => (ingredients.get(a.rxnormCode!) ?? []).includes(i))) ||
            key(a) === key(s),
        );
        return hit ? [[s.id, hit.id] as [string, string]] : [];
      }),
    );
  }
  return rows.map((r) => {
    const rx = r.prescriptionId ? requests.find((q) => q.id === r.prescriptionId) : undefined;
    return {
      ...toDto("MedicationStatement", r),
      source: r.source,
      ...(rx ? { activeRequest: toDto("MedicationRequest", rx) } : {}),
      ...(dupes.get(r.id) ? { possibleDuplicateOf: dupes.get(r.id) } : {}),
    } as MedicationStatementView;
  });
}

async function loadStatement(ctx: Ctx, id: string) {
  const m = await ctx.db.medicationStatement.findUnique({ where: { id } });
  if (!m) throw notFound();
  await requirePatient(ctx, m.patientId);
  return m;
}

export const medicationHandlers: HandlerMap = {
  async listMedicationStatements(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const status = ctx.query.status as MedicationStatementStatus[] | undefined;
    const rows = await ctx.db.medicationStatement.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...stagingFilter(ctx.query),
        ...(status?.length ? { status: { in: status } } : { status: { not: "ENTERED_IN_ERROR" } }),
      },
      orderBy: [{ display: "asc" }],
      take: 500,
    });
    ctx.audit.detail({ rows: rows.length });
    return medicationViews(ctx.db, rows);
  },

  async createMedicationStatement(ctx) {
    const b = ctx.body;
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The medication must be for this patient.");
    if (!b.display?.trim())
      throw unprocessable("validation_failed", "Choose a medication.", {
        errors: [{ field: "display", code: "required", message: "Choose a medication." }],
      });
    if (b.status && b.status !== "ACTIVE" && b.status !== "INTENDED")
      throw unprocessable("validation_failed", "New medications are recorded as active.");
    if (b.rxnormCode) {
      const dup = await ctx.db.medicationStatement.findFirst({
        where: {
          patientId: patient.id,
          rxnormCode: b.rxnormCode,
          stagingStatus: "ACTIVE",
          status: { notIn: CLOSED },
        },
      });
      if (dup)
        throw conflict("duplicate_medication", `${dup.display} is already on the active list.`);
    }
    if (b.reasonConditionId) {
      const c = await ctx.db.condition.findUnique({ where: { id: b.reasonConditionId } });
      if (!c || c.patientId !== patient.id)
        throw unprocessable("validation_failed", "Choose a problem from this patient's list.");
    }
    const me = ctx.staff();
    const source = b.reportedBy ?? "ENTERED";
    const row = await ctx.db.medicationStatement.create({
      data: {
        practiceId: patient.practiceId,
        patientId: patient.id,
        rxnormCode: b.rxnormCode ?? null,
        display: b.display.trim(),
        dosageText: b.dosageText?.trim() || null,
        status: b.status ?? "ACTIVE",
        effectiveStart: b.effectiveStart ? new Date(b.effectiveStart) : null,
        reasonConditionId: b.reasonConditionId ?? null,
        // Staff entering a patient-reported or outside medication is the reconcile action: active, source kept.
        source,
        recordedById: me.userId,
      },
    });
    ctx.audit.resource("MedicationStatement", row.id);
    await writeVersion(ctx.db, row.practiceId, "MedicationStatement", row, me.userId);
    await recordProvenance(ctx.db, row.practiceId, {
      targetType: "MedicationStatement",
      targetId: row.id,
      source,
      activity: "create",
      agentId: me.userId,
    });
    return toDto("MedicationStatement", row);
  },

  async updateMedicationStatement(ctx) {
    const m = await loadStatement(ctx, ctx.params.medicationStatementId);
    ctx.checkVersion(m.version, ctx.ifMatch());
    const b = ctx.body;
    if (b.status === "STOPPED")
      throw unprocessable(
        "validation_failed",
        "Use Discontinue to stop a medication, so the reason is recorded.",
      );
    const row = await ctx.db.medicationStatement.update({
      where: { id: m.id },
      data: {
        ...(b.display ? { display: b.display.trim() } : {}),
        ...(b.rxnormCode !== undefined ? { rxnormCode: b.rxnormCode } : {}),
        ...(b.dosageText !== undefined ? { dosageText: b.dosageText?.trim() || null } : {}),
        ...(b.status ? { status: b.status } : {}),
        ...(b.statusReason !== undefined ? { statusReason: b.statusReason } : {}),
        ...(b.effectiveStart !== undefined
          ? { effectiveStart: b.effectiveStart ? new Date(b.effectiveStart) : null }
          : {}),
        ...(b.effectiveEnd !== undefined
          ? { effectiveEnd: b.effectiveEnd ? new Date(b.effectiveEnd) : null }
          : {}),
        ...(b.reasonConditionId !== undefined ? { reasonConditionId: b.reasonConditionId } : {}),
        version: { increment: 1 },
      },
    });
    ctx.audit.resource("MedicationStatement", row.id);
    await writeVersion(ctx.db, row.practiceId, "MedicationStatement", row, ctx.staff().userId);
    return toDto("MedicationStatement", row);
  },

  async reconcileMedicationStatement(ctx) {
    await loadStatement(ctx, ctx.params.medicationStatementId);
    await reconcileStaged(ctx, "medicationStatement", ctx.params.medicationStatementId, ctx.body);
    ctx.audit.resource("MedicationStatement", ctx.params.medicationStatementId);
    return toDto(
      "MedicationStatement",
      await ctx.db.medicationStatement.findUniqueOrThrow({
        where: { id: ctx.params.medicationStatementId },
      }),
    );
  },

  async discontinueMedication(ctx) {
    const m = await loadStatement(ctx, ctx.params.medicationStatementId);
    const b = ctx.body;
    if (!b.reason?.trim())
      throw unprocessable("validation_failed", "Choose a reason.", {
        errors: [{ field: "reason", code: "required", message: "Choose a reason." }],
      });
    if (CLOSED.includes(m.status))
      throw conflict("already_stopped", "This medication is not active.");
    // CancelRx to the pharmacy for a prescription we sent (ErxGateway, prescribing/erx.ts).
    if (b.cancelAtPharmacy) {
      const rx = m.prescriptionId
        ? await ctx.db.medicationRequest.findUnique({ where: { id: m.prescriptionId } })
        : null;
      if (!rx || rx.status !== "ACTIVE" || !rx.erxMessageId)
        throw conflict(
          "not_sent_here",
          "This medication wasn't e-prescribed from here. Call the pharmacy.",
        );
      if (!erxGateway())
        throw integrationUnavailable(
          "Sending a cancel to the pharmacy needs e-prescribing, which isn't connected.",
        );
      assertTransition("prescription", rx.status, "cancelled", ctx.staff().role);
      const cancelled = await ctx.db.medicationRequest.update({
        where: { id: rx.id },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      await sendCancel(ctx.db, cancelled, b.reason.trim());
    }
    const row = await ctx.db.medicationStatement.update({
      where: { id: m.id },
      data: {
        status: "STOPPED",
        statusReason: b.reason.trim(),
        effectiveEnd: b.effective ? new Date(b.effective) : new Date(),
        version: { increment: 1 },
      },
    });
    ctx.audit.resource("MedicationStatement", row.id);
    await writeVersion(
      ctx.db,
      row.practiceId,
      "MedicationStatement",
      row,
      ctx.staff().userId,
      b.reason,
    );
    return toDto("MedicationStatement", row);
  },

  async recordMedicationReconciliation(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId);
    const staged = await ctx.db.medicationStatement.count({
      where: { patientId: patient.id, stagingStatus: "STAGED" },
    });
    if (staged)
      throw conflict(
        "staged_items_pending",
        `Accept, merge or reject the ${staged} incoming item${staged === 1 ? "" : "s"} first.`,
      );
    await ctx.db.patient.update({
      where: { id: patient.id },
      data: { medsReconciledAt: new Date(), medsReconciledById: ctx.staff().userId },
    });
  },

  // getMedicationFillHistory lives in prescribing/handlers.ts (ErxGateway).
};
