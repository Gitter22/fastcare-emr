import type { Tx } from "../../db.js";
import { limitOf, page } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { createTask } from "../../platform/tasks.js";
import { practiceTimeZone, todayLocal } from "../../platform/time.js";
import { summaries } from "../patients/service.js";
import { srInclude, srViews } from "./views.js";

/**
 * Order tracking (orders.tracking, flow:results/06, INV-SAFE-07): orders past their expected-by date with no final
 * result. The sweep raises one OVERDUE_ORDER task per order for the ordering provider (escalation to their pool).
 */

export const OPEN_ORDER = ["SIGNED", "SENT", "COLLECTED", "RESULTED_PRELIM"] as const;

const dayMs = 86_400_000;
const daysBetween = (from: Date, today: string) =>
  Math.max(0, Math.floor((new Date(`${today}T00:00:00Z`).getTime() - from.getTime()) / dayMs));

export async function overdueWhere(tx: Tx) {
  const today = todayLocal(await practiceTimeZone(tx));
  return {
    today,
    where: {
      status: { in: [...OPEN_ORDER] },
      expectedBy: { lt: new Date(`${today}T00:00:00Z`) },
    },
  };
}

/** Sweep: one open OVERDUE_ORDER task per overdue order; idempotent. Returns tasks created. */
export async function flagOverdueOrders(tx: Tx, practiceId: string): Promise<number> {
  const { where, today } = await overdueWhere(tx);
  const rows = await tx.serviceRequest.findMany({ where, take: 500 });
  let created = 0;
  for (const r of rows) {
    const open = await tx.task.findFirst({
      where: {
        type: "OVERDUE_ORDER",
        focusType: "ServiceRequest",
        focusId: r.id,
        status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
      },
    });
    if (open) continue;
    await createTask(tx, practiceId, {
      type: "OVERDUE_ORDER",
      title: `No result yet: ${r.display}`,
      description: `Expected by ${r.expectedBy!.toISOString().slice(0, 10)}, ${daysBetween(r.expectedBy!, today)} days overdue. Check with the lab or the patient.`,
      patientId: r.patientId,
      focusType: "ServiceRequest",
      focusId: r.id,
      ownerUserId: r.signedById,
      poolKind: r.signedById ? undefined : "care-team",
      priority: "NORMAL",
    });
    created++;
  }
  return created;
}

export const trackingHandlers: HandlerMap = {
  async listOverdueOrders(ctx) {
    const { where, today } = await overdueWhere(ctx.db);
    const limit = limitOf(ctx.query);
    let ownerFilter = {};
    if (ctx.query.practitionerId) {
      const pr = await ctx.db.practitioner.findUnique({ where: { id: ctx.query.practitionerId } });
      ownerFilter = { signedById: pr?.userId ?? "00000000-0000-0000-0000-000000000000" };
    }
    if (ctx.query.poolId) {
      const members = await ctx.db.workPoolMember.findMany({ where: { poolId: ctx.query.poolId } });
      ownerFilter = { signedById: { in: members.map((m) => m.userId) } };
    }
    const rows = await ctx.db.serviceRequest.findMany({
      where: {
        ...where,
        ...ownerFilter,
      },
      include: srInclude,
      orderBy: [{ expectedBy: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(ctx.query.cursor ? { cursor: { id: ctx.query.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    const [views, pts] = await Promise.all([
      srViews(ctx.db, slice),
      summaries(ctx.db, [...new Set(slice.map((r) => r.patientId))]),
    ]);
    const ptById = new Map(pts.map((p) => [p.id, p]));
    for (const id of ptById.keys()) ctx.audit.patient(id);
    return page(
      rows,
      limit,
      (r) => ({
        serviceRequest: views[slice.indexOf(r)]!,
        patient: ptById.get(r.patientId)!,
        daysOverdue: daysBetween(r.expectedBy!, today),
      }),
      (r) => r.id,
    );
  },
};
