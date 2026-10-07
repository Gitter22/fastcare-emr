import type { TaskPriority, TaskType, Tx } from "../db.js";

/**
 * Work items (glossary: Task). "Failures are work items" (product principle 5): interface failures, rejections,
 * unmatched results and eligibility problems all land here with an owner pool and a due time.
 */
export interface NewTask {
  type: TaskType;
  title: string;
  description?: string | null;
  patientId?: string | null;
  focusType?: string | null;
  focusId?: string | null;
  poolKind?: "care-team" | "front-desk" | "billing" | "referrals";
  poolId?: string | null;
  ownerUserId?: string | null;
  priority?: TaskPriority;
  dueAt?: Date | null;
  createdById?: string | null;
}

export async function poolByKind(tx: Tx, kind: string) {
  return tx.workPool.findFirst({ where: { kind, active: true }, orderBy: { name: "asc" } });
}

export async function createTask(tx: Tx, practiceId: string, t: NewTask) {
  let poolId = t.poolId ?? null;
  let slaHours: number | null = null;
  if (!poolId && t.poolKind) {
    const pool = await poolByKind(tx, t.poolKind);
    poolId = pool?.id ?? null;
    slaHours = pool?.slaHours ?? null;
  } else if (poolId) {
    slaHours = (await tx.workPool.findUnique({ where: { id: poolId } }))?.slaHours ?? null;
  }
  // One open task per focus + type: retries and repeated failures do not pile up duplicates.
  if (t.focusType && t.focusId) {
    const existing = await tx.task.findFirst({
      where: {
        type: t.type,
        focusType: t.focusType,
        focusId: t.focusId,
        status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
      },
    });
    if (existing) return existing;
  }
  return tx.task.create({
    data: {
      practiceId,
      type: t.type,
      title: t.title,
      description: t.description ?? null,
      patientId: t.patientId ?? null,
      focusType: t.focusType ?? null,
      focusId: t.focusId ?? null,
      poolId,
      ownerUserId: t.ownerUserId ?? null,
      priority: t.priority ?? "NORMAL",
      dueAt: t.dueAt ?? (slaHours ? new Date(Date.now() + slaHours * 3_600_000) : null),
      createdById: t.createdById ?? null,
    },
  });
}

/** Closes open tasks for a focus (e.g. eligibility resolved). */
export async function completeTasksFor(
  tx: Tx,
  focusType: string,
  focusId: string,
  types: TaskType[],
  byUserId: string | null,
) {
  await tx.task.updateMany({
    where: {
      focusType,
      focusId,
      type: { in: types },
      status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
    },
    data: { status: "COMPLETED", completedAt: new Date(), completedById: byUserId },
  });
}
