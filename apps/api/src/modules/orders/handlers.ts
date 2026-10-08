import type { OrderCategory, Prisma, ServiceRequest } from "../../db.js";
import { labGateway } from "../../gateways/lab/index.js";
import { limitOf, page } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { practiceTimeZone, todayLocal } from "../../platform/time.js";
import { loadEncounter } from "../encounters/access.js";
import { staticItem } from "./catalog.js";
import { isElectronicLab, newPlacerOrderNumber, sendToLab } from "./lab.js";
import { defaultExpectedBy, validateOrders } from "./rules.js";
import { loadSrRow, srInclude, srView, srViews } from "./views.js";

/**
 * Order entry and lifecycle (encounter.orders, chart.orders, orders.tracking). States follow spec/states.yaml#order;
 * every transition is checked with assertTransition. INV-ID-03: signing compares the context patient with the
 * encounter's patient. INV-SAFE-07: every order is created with an expected-by date.
 */

const CLOSED_ENCOUNTER = ["FINISHED", "CANCELLED", "ENTERED_IN_ERROR"];

async function loadOrder(ctx: Ctx, id: string) {
  const sr = await loadSrRow(ctx.db, id);
  if (!sr) throw notFound();
  await requirePatient(ctx, sr.patientId);
  ctx.audit.resource("ServiceRequest", sr.id);
  return sr;
}

async function openEncounter(ctx: Ctx, encounterId: string) {
  const enc = await loadEncounter(ctx, encounterId);
  if (CLOSED_ENCOUNTER.includes(enc.status))
    throw conflict("encounter_closed", "This visit is closed. Add orders from a new encounter.");
  return enc;
}

/** Diagnoses an order may link to: the patient's conditions in the active chart. */
async function checkReasons(ctx: Ctx, patientId: string, ids: string[]) {
  if (!ids.length) return;
  const found = await ctx.db.condition.count({
    where: { id: { in: ids }, patientId, stagingStatus: "ACTIVE" },
  });
  if (found !== new Set(ids).size)
    throw unprocessable("validation_failed", "Link the order to one of this patient's diagnoses.", {
      errors: [{ field: "reasonConditionIds", code: "invalid", message: "Unknown diagnosis." }],
    });
}

async function setReasons(ctx: Ctx, srId: string, ids: string[]) {
  await ctx.db.serviceRequestReason.deleteMany({
    where: { serviceRequestId: srId, conditionId: { notIn: ids } },
  });
  for (const conditionId of new Set(ids))
    await ctx.db.serviceRequestReason.upsert({
      where: { serviceRequestId_conditionId: { serviceRequestId: srId, conditionId } },
      create: { practiceId: ctx.staff().practiceId, serviceRequestId: srId, conditionId },
      update: {},
    });
}

async function today(ctx: Ctx) {
  return todayLocal(await practiceTimeZone(ctx.db));
}

function assertExpectedBy(date: string | null | undefined, today: string) {
  if (date && date < today)
    throw unprocessable("validation_failed", "The expected-by date can't be in the past.", {
      errors: [{ field: "expectedBy", code: "past", message: "Choose today or later." }],
    });
}

/** What the order is, resolved from the catalog so codes can't be typed freely. */
async function resolveOrderable(
  ctx: Ctx,
  b: {
    category: OrderCategory;
    code: string;
    display: string;
    labCompendiumItemId?: string | null;
  },
) {
  if (b.category === "LAB") {
    const item = b.labCompendiumItemId
      ? await ctx.db.labCompendiumItem.findUnique({ where: { id: b.labCompendiumItemId } })
      : null;
    if (!item || !item.active)
      throw unprocessable("validation_failed", "Choose the lab test from the compendium.", {
        errors: [{ field: "labCompendiumItemId", code: "required", message: "Choose a test." }],
      });
    return {
      codeSystem: "LOINC" as const,
      code: item.loincCode ?? item.testCode,
      display: item.display,
      performerLab: item.lab,
      labCompendiumItemId: item.id,
    };
  }
  const s = staticItem(b.code);
  if (!s)
    throw unprocessable("validation_failed", "Choose the order from the catalog.", {
      errors: [{ field: "code", code: "invalid", message: "Unknown order code." }],
    });
  return {
    codeSystem: s.codeSystem,
    code: s.code,
    display: s.display,
    performerLab: null,
    labCompendiumItemId: null,
  };
}

async function createOrder(
  ctx: Ctx,
  enc: { id: string; patientId: string },
  b: {
    category: OrderCategory;
    code: string;
    display: string;
    labCompendiumItemId?: string | null;
    priority?: ServiceRequest["priority"];
    collectionMode?: ServiceRequest["collectionMode"];
    aoeAnswers?: unknown;
    expectedBy?: string | null;
    orderSetId?: string | null;
    intent?: string;
  },
  reasonIds: string[],
  todayStr: string,
) {
  const what = await resolveOrderable(ctx, b);
  await checkReasons(ctx, enc.patientId, reasonIds);
  assertTransition("order", null, "pended", ctx.staff().role);
  assertExpectedBy(b.expectedBy, todayStr);
  const priority = b.priority ?? "ROUTINE";
  const sr = await ctx.db.serviceRequest.create({
    data: {
      practiceId: ctx.staff().practiceId,
      patientId: enc.patientId,
      encounterId: enc.id,
      category: b.category,
      ...what,
      intent: b.intent ?? "order",
      priority,
      collectionMode: b.collectionMode ?? (b.category === "LAB" ? "IN_OFFICE" : "NOT_APPLICABLE"),
      aoeAnswers: (b.aoeAnswers ?? undefined) as Prisma.InputJsonValue | undefined,
      expectedBy: new Date(
        `${b.expectedBy ?? defaultExpectedBy(b.category, priority, todayStr)}T00:00:00Z`,
      ),
      orderSetId: b.orderSetId ?? null,
      status: "PENDED",
      pendedById: ctx.staff().userId,
    },
  });
  await setReasons(ctx, sr.id, reasonIds);
  return sr;
}

export const orderHandlers: HandlerMap = {
  async listEncounterOrders(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const rows = await ctx.db.serviceRequest.findMany({
      where: { encounterId: enc.id },
      include: srInclude,
      orderBy: { createdAt: "asc" },
    });
    ctx.audit.patient(enc.patientId);
    return srViews(ctx.db, rows);
  },

  async listPatientServiceRequests(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(ctx.query);
    const status = ctx.query.status as string[] | string | undefined;
    const rows = await ctx.db.serviceRequest.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...(status ? { status: { in: ([] as string[]).concat(status) as never } } : {}),
        ...(ctx.query.category ? { category: ctx.query.category as OrderCategory } : {}),
        ...(ctx.query.cursor ? { createdAt: { lt: new Date(ctx.query.cursor) } } : {}),
      },
      include: srInclude,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    ctx.audit.patient(ctx.params.patientId);
    const views = await srViews(ctx.db, rows.slice(0, limit));
    return page(
      rows,
      limit,
      (_r) => views.shift()!,
      (r) => r.createdAt.toISOString(),
    );
  },

  async createServiceRequest(ctx) {
    const b = ctx.body;
    const enc = await openEncounter(ctx, ctx.params.encounterId);
    if (b.patientId !== enc.patientId)
      throw conflict(
        "patient_context_mismatch",
        "The patient on screen isn't this visit's patient. Reopen the visit from the right chart.",
      );
    const sr = await createOrder(ctx, enc, b, b.reasonConditionIds ?? [], await today(ctx));
    ctx.audit.patient(enc.patientId);
    ctx.audit.resource("ServiceRequest", sr.id);
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },

  async applyOrderSet(ctx) {
    const enc = await openEncounter(ctx, ctx.params.encounterId);
    const set = await ctx.db.orderSet.findUnique({ where: { id: ctx.params.orderSetId } });
    if (!set || !set.active) throw notFound();
    const items = (set.items ?? []) as Array<{
      category: OrderCategory;
      code: string;
      display: string;
      defaultDxCode?: string;
      priority?: ServiceRequest["priority"];
      aoeDefaults?: Record<string, unknown>;
    }>;
    // Default diagnosis: the patient's active condition with the set's ICD-10 code, if any.
    const conditions = await ctx.db.condition.findMany({
      where: { patientId: enc.patientId, stagingStatus: "ACTIVE", clinicalStatus: "ACTIVE" },
      select: { id: true, icd10Code: true },
    });
    const todayStr = await today(ctx);
    const created: string[] = [];
    for (const it of items) {
      let compId: string | null = null;
      if (it.category === "LAB") {
        const lab = await ctx.db.labCompendiumItem.findFirst({
          where: { loincCode: it.code, active: true },
          orderBy: { lab: "desc" },
        });
        if (!lab) continue;
        compId = lab.id;
      }
      const dx = conditions.find((c) => c.icd10Code === it.defaultDxCode);
      const sr = await createOrder(
        ctx,
        enc,
        { ...it, labCompendiumItemId: compId, aoeAnswers: it.aoeDefaults, orderSetId: set.id },
        dx ? [dx.id] : [],
        todayStr,
      );
      created.push(sr.id);
    }
    ctx.audit.patient(enc.patientId);
    ctx.audit.detail({ orderSetId: set.id, created: created.length });
    const rows = await ctx.db.serviceRequest.findMany({
      where: { id: { in: created } },
      include: srInclude,
      orderBy: { createdAt: "asc" },
    });
    return srViews(ctx.db, rows);
  },

  async updateServiceRequest(ctx) {
    const sr = await loadOrder(ctx, ctx.params.serviceRequestId);
    ctx.checkVersion(sr.version, ctx.ifMatch());
    const b = ctx.body;
    const editable = sr.status === "PENDED";
    // After signing only the expected-by date may move (INV-SAFE-07 follow-up), via extendExpectedDate.
    if (!editable)
      throw conflict("order_signed", "A signed order can't be edited. Cancel it and order again.");
    const todayStr = await today(ctx);
    assertExpectedBy(b.expectedBy, todayStr);
    const what =
      b.labCompendiumItemId !== undefined || b.code !== undefined
        ? await resolveOrderable(ctx, {
            category: b.category ?? sr.category,
            code: b.code ?? sr.code,
            display: b.display ?? sr.display,
            labCompendiumItemId: b.labCompendiumItemId ?? sr.labCompendiumItemId,
          })
        : {};
    if (b.reasonConditionIds) {
      await checkReasons(ctx, sr.patientId, b.reasonConditionIds);
      await setReasons(ctx, sr.id, b.reasonConditionIds);
    }
    await ctx.db.serviceRequest.update({
      where: { id: sr.id },
      data: {
        ...what,
        ...(b.priority ? { priority: b.priority } : {}),
        ...(b.collectionMode ? { collectionMode: b.collectionMode } : {}),
        ...(b.aoeAnswers !== undefined
          ? { aoeAnswers: (b.aoeAnswers ?? undefined) as Prisma.InputJsonValue | undefined }
          : {}),
        ...(b.expectedBy ? { expectedBy: new Date(`${b.expectedBy}T00:00:00Z`) } : {}),
        ...(b.abnSignedFileId !== undefined ? { abnSignedFileId: b.abnSignedFileId } : {}),
        version: { increment: 1 },
      },
    });
    ctx.audit.patient(sr.patientId);
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },

  async validateEncounterOrders(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const rows = await ctx.db.serviceRequest.findMany({
      where: { encounterId: enc.id },
      include: srInclude,
    });
    const issues = await validateOrders(ctx.db, enc.patientId, rows);
    return { ok: !issues.some((i) => i.severity === "error"), issues };
  },

  async signOrders(ctx) {
    const b = ctx.body;
    const enc = await openEncounter(ctx, ctx.params.encounterId);
    // INV-ID-03: the patient on screen must be the encounter's patient.
    if (b.patientId !== enc.patientId)
      throw conflict(
        "patient_context_mismatch",
        "The patient on screen isn't this visit's patient. Reopen the visit from the right chart.",
      );
    const rows = await ctx.db.serviceRequest.findMany({
      where: { id: { in: b.ids }, encounterId: enc.id },
      include: srInclude,
    });
    if (rows.length !== new Set(b.ids).size) throw notFound();
    for (const r of rows) assertTransition("order", r.status, "signed", ctx.staff().role);

    const issues = await validateOrders(ctx.db, enc.patientId, rows);
    const ack = new Set(b.acknowledgedWarnings ?? []);
    const blocking = issues.filter(
      (i) =>
        (i.severity === "error" && !(i.code === "abn" && b.abnSigned)) ||
        (i.severity === "warning" &&
          !ack.has(`${i.serviceRequestId}:${i.code}`) &&
          !ack.has(i.code)),
    );
    if (blocking.length)
      throw unprocessable("orders_not_ready", "Some orders need attention before signing.", {
        issues: blocking,
      });

    const now = new Date();
    const abnIds = new Set(issues.filter((i) => i.code === "abn").map((i) => i.serviceRequestId));
    for (const r of rows) {
      const signed = await ctx.db.serviceRequest.update({
        where: { id: r.id, version: r.version },
        data: {
          status: "SIGNED",
          signedById: ctx.staff().userId,
          signedAt: now,
          placerOrderNumber: r.placerOrderNumber ?? newPlacerOrderNumber(),
          abnRequired: abnIds.has(r.id),
          version: { increment: 1 },
        },
      });
      if (isElectronicLab(signed)) await sendToLab(ctx.db, signed);
      if (signed.category !== "LAB" && staticItem(signed.code)?.requiresAuth)
        await createTask(ctx.db, signed.practiceId, {
          type: "PRIOR_AUTH",
          title: `Prior authorization: ${signed.display}`,
          patientId: signed.patientId,
          focusType: "ServiceRequest",
          focusId: signed.id,
          poolKind: "referrals",
          createdById: ctx.staff().userId,
        });
    }
    ctx.audit.patient(enc.patientId);
    ctx.audit.detail({ signed: rows.map((r) => r.id) });
    const out = await ctx.db.serviceRequest.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: srInclude,
      orderBy: { createdAt: "asc" },
    });
    return srViews(ctx.db, out);
  },

  async sendServiceRequest(ctx) {
    const sr = await loadOrder(ctx, ctx.params.serviceRequestId);
    if (!isElectronicLab(sr))
      throw conflict(
        "not_electronic",
        "This order isn't sent electronically. Print the requisition.",
      );
    if (!labGateway())
      throw conflict(
        "gateway_unavailable",
        "No lab interface is connected. Print the requisition instead.",
      );
    assertTransition("order", sr.status, "sent", "system");
    const outcome = await sendToLab(ctx.db, sr);
    if (outcome === "failed")
      throw conflict(
        "lab_unavailable",
        "The lab interface didn't accept the order. It's queued to retry; print the requisition if the patient is waiting.",
      );
    ctx.audit.patient(sr.patientId);
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },

  async cancelServiceRequest(ctx) {
    const sr = await loadOrder(ctx, ctx.params.serviceRequestId);
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw unprocessable("validation_failed", "Say why the order is cancelled.", {
        errors: [{ field: "reason", code: "required", message: "Enter a reason." }],
      });
    assertTransition("order", sr.status, "cancelled", ctx.staff().role);
    await ctx.db.serviceRequest.update({
      where: { id: sr.id, version: sr.version },
      data: { status: "CANCELLED", cancelledReason: reason, version: { increment: 1 } },
    });
    await completeTasksFor(
      ctx.db,
      "ServiceRequest",
      sr.id,
      ["SPECIMEN_COLLECTION", "OVERDUE_ORDER", "INTERFACE_FAILURE", "PRIOR_AUTH"],
      ctx.staff().userId,
    );
    // A sent order is cancelled at the lab too (ORM control code CA) once a vendor is connected; the simulated lab
    // has nothing to cancel.
    ctx.audit.patient(sr.patientId);
    ctx.audit.detail({ reason });
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },

  async extendExpectedDate(ctx) {
    const sr = await loadOrder(ctx, ctx.params.serviceRequestId);
    if (["CANCELLED", "REVIEWED", "RESULTED_FINAL"].includes(sr.status))
      throw conflict("order_closed", "This order already has its result or was cancelled.");
    assertExpectedBy(ctx.body.expectedBy, await today(ctx));
    await ctx.db.serviceRequest.update({
      where: { id: sr.id },
      data: { expectedBy: new Date(`${ctx.body.expectedBy}T00:00:00Z`), version: { increment: 1 } },
    });
    await completeTasksFor(ctx.db, "ServiceRequest", sr.id, ["OVERDUE_ORDER"], ctx.staff().userId);
    ctx.audit.patient(sr.patientId);
    ctx.audit.detail({ expectedBy: ctx.body.expectedBy });
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },

  async checkOrderStatusWithLab(ctx) {
    const sr = await loadOrder(ctx, ctx.params.serviceRequestId);
    const gw = labGateway();
    if (!gw || !isElectronicLab(sr) || !sr.placerOrderNumber)
      throw conflict(
        "gateway_unavailable",
        "No lab interface is connected for this order. Call the lab.",
      );
    let status: string;
    try {
      status = await gw.status(sr.placerOrderNumber);
    } catch {
      throw conflict(
        "lab_unavailable",
        "The lab interface isn't responding. Try again later or call the lab.",
      );
    }
    ctx.audit.patient(sr.patientId);
    ctx.audit.detail({ labStatus: status });
    return srView((await loadSrRow(ctx.db, sr.id))!);
  },
};
