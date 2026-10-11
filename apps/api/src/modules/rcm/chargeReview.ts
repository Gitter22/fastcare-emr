import type { ChargeItem, Encounter, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { centsToMoney, toCentsDec } from "../../platform/ledger.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, validationFailed } from "../../platform/problem.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { noteSummaries } from "../encounters/notes/service.js";
import { summaries } from "../patients/service.js";
import { coverageView } from "../billing/frontdesk.js";
import { activeEdits } from "./coding.js";
import { editsOf, encounterChargesView, recomputeEdits, releaseEncounter } from "./charges.js";

/**
 * billing.charge-review (flow:rcm/02): encounters whose charges are HELD — coding edits, missing provider data,
 * manual holds and provider queries. Billing roles see the note's summary only, never its text (INV-SEC-05).
 */

async function heldEncounters(tx: Tx) {
  const held = await tx.chargeItem.findMany({
    where: { status: "HELD", encounterId: { not: null } },
    orderBy: { serviceDate: "asc" },
  });
  const byEnc = new Map<string, ChargeItem[]>();
  for (const c of held) byEnc.set(c.encounterId!, [...(byEnc.get(c.encounterId!) ?? []), c]);
  return byEnc;
}

async function openQueries(tx: Tx, encounterIds: string[]) {
  const tasks = await tx.task.findMany({
    where: {
      type: "PROVIDER_QUERY",
      focusType: "Encounter",
      focusId: { in: encounterIds },
      status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
    },
  });
  return new Set(tasks.map((t) => t.focusId!));
}

/** Hold groups shown as filters: the edit rules plus manual holds and provider queries. */
function holdsFor(lines: ChargeItem[], queried: boolean): string[] {
  const rules = new Set(activeEdits(lines.flatMap(editsOf)).map((e) => e.rule as string));
  if (lines.some((l) => l.holdNote)) rules.add("hold");
  if (queried) rules.add("provider-query");
  if (!rules.size) rules.add("fixed");
  return [...rules];
}

async function loadHeldEncounter(ctx: Ctx, encounterId: string): Promise<Encounter> {
  const enc = await ctx.db.encounter.findUnique({ where: { id: encounterId } });
  if (!enc) throw notFound();
  await requirePatient(ctx, enc.patientId, { identityOnly: true });
  ctx.audit.resource("Encounter", enc.id);
  return enc;
}

async function detail(tx: Tx, enc: Encounter) {
  const [charges, note, coverage] = await Promise.all([
    encounterChargesView(tx, enc),
    tx.clinicalNote.findFirst({ where: { encounterId: enc.id } }),
    tx.coverage.findFirst({
      where: { patientId: enc.patientId, status: "active" },
      orderBy: { order: "asc" },
    }),
  ]);
  const lines = await tx.chargeItem.findMany({
    where: { encounterId: enc.id, status: { in: ["DRAFT", "HELD"] } },
  });
  const edits = activeEdits(lines.flatMap(editsOf));
  const manual = lines.find((l) => l.holdNote);
  // INV-SEC-05: the summary carries title, author, status and dates; no section text.
  const [noteSummary] = note ? await noteSummaries(tx, [note]) : [];
  return {
    charges,
    ...(noteSummary ? { note: noteSummary } : {}),
    ...(coverage ? { coverage: await coverageView({ db: tx } as Ctx, coverage.id) } : {}),
    edits: [
      ...edits.map((e) => ({
        code: e.key,
        severity: e.severity,
        text: e.text,
        ...(e.lineId ? { lineId: e.lineId } : {}),
      })),
      ...(manual
        ? [{ code: "hold", severity: "error" as const, text: `On hold: ${manual.holdNote}` }]
        : []),
    ],
  };
}

export const chargeReviewHandlers: HandlerMap = {
  async listHeldCharges(ctx) {
    const q = ctx.query;
    const byEnc = await heldEncounters(ctx.db);
    const ids = [...byEnc.keys()];
    const [encs, queried] = await Promise.all([
      ctx.db.encounter.findMany({ where: { id: { in: ids } }, include: { practitioner: true } }),
      openQueries(ctx.db, ids),
    ]);
    const covs = await ctx.db.coverage.findMany({
      where: { patientId: { in: encs.map((e) => e.patientId) }, status: "active" },
      orderBy: { order: "asc" },
    });
    const pats = new Map(
      (await summaries(ctx.db, [...new Set(encs.map((e) => e.patientId))])).map((p) => [p.id, p]),
    );
    let rows = encs.map((e) => {
      const lines = byEnc.get(e.id)!;
      const payerId = covs.find((c) => c.patientId === e.patientId)?.payerId ?? null;
      return {
        enc: e,
        payerId,
        row: {
          encounterId: e.id,
          patient: pats.get(e.patientId)!,
          dateOfService: lines[0]!.serviceDate.toISOString().slice(0, 10),
          practitioner: `${e.practitioner.firstName} ${e.practitioner.lastName}${e.practitioner.credential ? `, ${e.practitioner.credential}` : ""}`,
          total: centsToMoney(
            lines.reduce((s, l) => s + Math.round(toCentsDec(l.fee) * Number(l.units)), 0),
          ),
          holds: holdsFor(lines, queried.has(e.id)),
          ageDays: Math.floor((Date.now() - lines[0]!.serviceDate.getTime()) / 86_400_000),
        },
      };
    });
    if (q.rule) rows = rows.filter((r) => r.row.holds.includes(q.rule!));
    if (q.payerId) rows = rows.filter((r) => r.payerId === q.payerId);
    if (q.practitionerId) rows = rows.filter((r) => r.enc.practitionerId === q.practitionerId);
    rows.sort((a, b) => b.row.ageDays - a.row.ageDays);
    const limit = Math.min(Number(q.limit ?? 100), 200);
    const start = q.cursor ? rows.findIndex((r) => r.enc.id === q.cursor) + 1 : 0;
    const slice = rows.slice(start, start + limit);
    return {
      data: slice.map((r) => r.row),
      nextCursor: start + limit < rows.length ? slice[slice.length - 1]!.enc.id : null,
      hasMore: start + limit < rows.length,
    };
  },

  async getChargeReviewItem(ctx) {
    const enc = await loadHeldEncounter(ctx, ctx.params.encounterId);
    return detail(ctx.db, enc);
  },

  async releaseEncounterCharges(ctx) {
    const enc = await loadHeldEncounter(ctx, ctx.params.encounterId);
    const me = ctx.staff();
    const held = await ctx.db.chargeItem.count({ where: { encounterId: enc.id, status: "HELD" } });
    if (!held)
      throw conflict(
        "nothing_held",
        "This visit has no held charges (unsigned notes release on signing).",
      );
    const r = await releaseEncounter(ctx.db, enc, { userId: me.userId, role: me.role }, "throw");
    await completeTasksFor(
      ctx.db,
      "Encounter",
      enc.id,
      ["PROVIDER_QUERY", "CHARGE_HOLD"],
      me.userId,
    );
    ctx.audit.detail({ released: r.released, claimId: r.claimId });
    return detail(ctx.db, enc);
  },

  async holdEncounterCharges(ctx) {
    const enc = await loadHeldEncounter(ctx, ctx.params.encounterId);
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([{ field: "reason", code: "required", message: "Give a reason." }]);
    const n = await ctx.db.chargeItem.updateMany({
      where: { encounterId: enc.id, status: { in: ["DRAFT", "HELD"] } },
      data: { status: "HELD", holdNote: reason.slice(0, 500) },
    });
    if (!n.count) throw conflict("nothing_held", "This visit has no open charges.");
    ctx.audit.detail({ held: n.count });
    return detail(ctx.db, enc);
  },

  async queryProvider(ctx) {
    const enc = await loadHeldEncounter(ctx, ctx.params.encounterId);
    const comment = ctx.body.comment?.trim();
    if (!comment)
      throw validationFailed([
        { field: "comment", code: "required", message: "Write the question." },
      ]);
    const pr = await ctx.db.practitioner.findUniqueOrThrow({ where: { id: enc.practitionerId } });
    const me = ctx.staff();
    const task = await createTask(ctx.db, enc.practiceId, {
      type: "PROVIDER_QUERY",
      title: "Billing question about a visit's charges",
      description: `${comment}\n\nOpen the visit's charges: /patient/${enc.patientId}/encounter/${enc.id}/charges`,
      patientId: enc.patientId,
      focusType: "Encounter",
      focusId: enc.id,
      ownerUserId: pr.userId,
      poolKind: pr.userId ? undefined : "care-team",
      priority: "NORMAL",
      createdById: me.userId,
    });
    ctx.audit.resource("Task", task.id);
    const [patient] = await summaries(ctx.db, [enc.patientId]);
    return {
      ...toDto("Task", task),
      ...(patient ? { patient } : {}),
      assigneeName: `${pr.firstName} ${pr.lastName}`,
      overdue: !!task.dueAt && task.dueAt < new Date(),
    };
  },

  async releaseFixedCharges(ctx) {
    const me = ctx.staff();
    const byEnc = await heldEncounters(ctx.db);
    const queried = await openQueries(ctx.db, [...byEnc.keys()]);
    const succeeded: string[] = [];
    const failed: Array<{ id: string; code: string; detail: string }> = [];
    for (const [encounterId, lines] of byEnc) {
      if (queried.has(encounterId) || lines.some((l) => l.holdNote)) continue;
      const enc = await ctx.db.encounter.findUniqueOrThrow({ where: { id: encounterId } });
      const edits = activeEdits(await recomputeEdits(ctx.db, enc));
      if (edits.length) continue;
      try {
        await releaseEncounter(ctx.db, enc, { userId: me.userId, role: me.role }, "throw");
        succeeded.push(encounterId);
        ctx.audit.add({
          action: "UPDATE",
          patientId: enc.patientId,
          resourceType: "Encounter",
          resourceId: enc.id,
          operationId: "releaseFixedCharges",
          detail: { released: true },
        });
      } catch (e) {
        failed.push({
          id: encounterId,
          code: (e as { code?: string }).code ?? "error",
          detail: (e as Error).message,
        });
      }
    }
    return { succeeded, failed };
  },
};
