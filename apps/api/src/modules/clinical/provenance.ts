import type { ReconcileDecision } from "@agile-emr/shared";
import type { ProvenanceSource, StagingStatus, Tx } from "../../db.js";
import type { Ctx } from "../../platform/http/context.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";

/**
 * INV-DATA-01 / ADR-002: patient-entered, outside-record, device and AI data are stored STAGED with their provenance
 * and enter the active chart only through a staff reconcile action. Every create and every reconcile decision writes
 * a ProvenanceRecord, so the chart can always say where an item came from and who let it in.
 */
export async function recordProvenance(
  tx: Tx,
  practiceId: string,
  p: {
    targetType: string;
    targetId: string;
    source: ProvenanceSource;
    activity: string;
    agentType?: string;
    agentId?: string | null;
    agentDisplay?: string | null;
  },
) {
  await tx.provenanceRecord.create({
    data: {
      practiceId,
      targetType: p.targetType,
      targetId: p.targetId,
      source: p.source,
      activity: p.activity,
      agentType: p.agentType ?? "user",
      agentId: p.agentId ?? null,
      agentDisplay: p.agentDisplay ?? null,
    },
  });
}

interface StagedRow {
  id: string;
  practiceId: string;
  patientId: string;
  stagingStatus: StagingStatus;
  source: ProvenanceSource;
  version: number;
}

/** The three list resources that can hold staged items. */
export type StagedModel = "condition" | "allergyIntolerance" | "medicationStatement";

const RESOURCE: Record<StagedModel, string> = {
  condition: "Condition",
  allergyIntolerance: "AllergyIntolerance",
  medicationStatement: "MedicationStatement",
};

interface Delegate {
  findUnique(args: { where: { id: string } }): Promise<StagedRow | null>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<StagedRow>;
}

/**
 * Apply a ReconcileDecision. `pathId` is the staged item in the URL; `items` may batch more items of the same patient.
 * accept -> ACTIVE (provenance kept), reject -> REJECTED, merge -> MERGED into an active item of the same patient.
 */
export async function reconcileStaged(
  ctx: Ctx,
  model: StagedModel,
  pathId: string,
  body: ReconcileDecision,
): Promise<StagedRow> {
  const delegate = ctx.db[model] as unknown as Delegate;
  const anchor = await delegate.findUnique({ where: { id: pathId } });
  if (!anchor) throw notFound();
  ctx.audit.patient(anchor.patientId);
  const items = body.items.length ? body.items : [{ stagedId: pathId, action: "accept" as const }];
  const me = ctx.staff();
  for (const item of items) {
    const row = await delegate.findUnique({ where: { id: item.stagedId } });
    if (!row || row.patientId !== anchor.patientId) throw notFound();
    if (row.stagingStatus !== "STAGED")
      throw conflict("not_staged", "This item was already reconciled.");
    let data: Record<string, unknown>;
    if (item.action === "accept") data = { stagingStatus: "ACTIVE" };
    else if (item.action === "reject") data = { stagingStatus: "REJECTED" };
    else {
      if (!item.mergeIntoId)
        throw unprocessable("validation_failed", "Choose the item to merge into.", {
          errors: [
            { field: "mergeIntoId", code: "required", message: "Choose the item to merge into." },
          ],
        });
      const target = await delegate.findUnique({ where: { id: item.mergeIntoId } });
      if (!target || target.patientId !== row.patientId || target.stagingStatus !== "ACTIVE")
        throw unprocessable(
          "validation_failed",
          "Merge into an active item on this patient's list.",
        );
      data = {
        stagingStatus: "MERGED",
        ...(model === "allergyIntolerance" ? {} : { mergedIntoId: target.id }),
      };
    }
    const updated = await delegate.update({
      where: { id: row.id },
      data: { ...data, version: { increment: 1 } },
    });
    await writeVersion(
      ctx.db,
      updated.practiceId,
      RESOURCE[model],
      updated,
      me.userId,
      `reconcile-${item.action}`,
    );
    await recordProvenance(ctx.db, updated.practiceId, {
      targetType: RESOURCE[model],
      targetId: updated.id,
      source: row.source,
      activity: `reconcile-${item.action}`,
      agentId: me.userId,
      ...(item.mergeIntoId ? { agentDisplay: `merged into ${item.mergeIntoId}` } : {}),
    });
  }
  if (body.reviewedComplete) {
    const now = new Date();
    if (model === "medicationStatement")
      await ctx.db.patient.update({
        where: { id: anchor.patientId },
        data: { medsReconciledAt: now, medsReconciledById: me.userId },
      });
    if (model === "allergyIntolerance")
      await ctx.db.patient.update({
        where: { id: anchor.patientId },
        data: { allergiesReviewedAt: now },
      });
  }
  return (await delegate.findUnique({ where: { id: pathId } }))!;
}

/** Default list filter: the active chart only, unless the caller asks for a staging status (incoming items). */
export const stagingFilter = (q: { stagingStatus?: StagingStatus }) =>
  q.stagingStatus ? { stagingStatus: q.stagingStatus } : { stagingStatus: "ACTIVE" as const };
