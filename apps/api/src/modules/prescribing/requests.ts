import { stateId, type RxRequestView } from "@agile-emr/shared";
import type { MedicationRequest, Prisma, RxRequest, Task, TaskStatus, Tx } from "../../db.js";
import { type ErxInboundEvent, erxGateway, verifyErxSignature } from "../../gateways/erx/index.js";
import { getDrugConcept, isControlledConcept } from "../../gateways/referenceData/index.js";
import { limitOf, page, toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { connectionFor, recordCall } from "../../platform/integrations.js";
import { requirePatient } from "../../platform/patientAccess.js";
import {
  conflict,
  notFound,
  unauthenticated,
  unprocessable,
  validationFailed,
} from "../../platform/problem.js";
import { assertTransition, toEnum, transitionsFrom } from "../../platform/stateMachine.js";
import { createTask } from "../../platform/tasks.js";
import { writeAuditEntries } from "../../platform/audit.js";
import { writeVersion } from "../../platform/versioning.js";
import { summaries } from "../patients/service.js";
import { sendPrescription } from "./erx.js";
import { signDrafts } from "./sign.js";

/**
 * Pharmacy renewal and change requests (flow:refills, inbox.rx-requests). Each inbound request becomes an RxRequest,
 * a draft response prescription (a copy of the original with the requested change) and an RX_REQUEST task
 * (task:new->open) in the care-team pool. An MA applies the refill protocol and pends to the provider
 * (task:open->pended-to-provider); the provider approves (signing the draft, INV-SAFE-01/06) or denies, and the
 * response goes back through ErxGateway (task:...->completed).
 *
 * Refill protocol (OPEN-Q20: practice-configurable protocols, drug-specific lab requirements): passes only for a
 * renewal of a non-controlled prescription written here, with a visit in the last 12 months.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_TASK: TaskStatus[] = ["OPEN", "IN_PROGRESS", "PENDED_TO_PROVIDER", "ESCALATED"];
const YEAR_MS = 365 * 86_400_000;

interface Protocol {
  pass: boolean | null;
  reasons: string[];
  lastVisit: Date | null;
}

async function evaluateProtocol(
  tx: Tx,
  req: RxRequest,
  original: MedicationRequest | null,
  draft: MedicationRequest | null,
): Promise<Protocol> {
  const last = await tx.encounter.findFirst({
    where: { patientId: req.patientId, status: { in: ["FINISHED", "IN_PROGRESS"] } },
    orderBy: { periodStart: "desc" },
  });
  const lastVisit = last ? (last.periodStart ?? last.createdAt) : null;
  if (req.type !== "RENEWAL")
    return { pass: null, reasons: ["Change requests need a provider decision."], lastVisit };
  const reasons: string[] = [];
  let pass = true;
  if (!original) {
    pass = false;
    reasons.push("The original prescription wasn't written here.");
  }
  if (original?.isControlled || draft?.isControlled) {
    pass = false;
    reasons.push("Controlled substance: the provider decides.");
  }
  if (!lastVisit || Date.now() - lastVisit.getTime() > YEAR_MS) {
    pass = false;
    reasons.push("No visit in the last 12 months: book a visit.");
  } else reasons.push(`Last visit ${lastVisit.toISOString().slice(0, 10)}.`);
  return { pass, reasons, lastVisit };
}

async function views(tx: Tx, rows: RxRequest[]): Promise<RxRequestView[]> {
  if (!rows.length) return [];
  const rxIds = rows
    .flatMap((r) => [r.originalPrescriptionId, r.responsePrescriptionId])
    .filter((x): x is string => !!x);
  const [meds, tasks, pharmacies, patients] = await Promise.all([
    tx.medicationRequest.findMany({ where: { id: { in: rxIds } } }),
    tx.task.findMany({
      where: { id: { in: rows.map((r) => r.taskId).filter((x): x is string => !!x) } },
    }),
    tx.pharmacy.findMany({
      where: { id: { in: rows.map((r) => r.pharmacyId).filter((x): x is string => !!x) } },
    }),
    summaries(tx, [...new Set(rows.map((r) => r.patientId))]),
  ]);
  const out: RxRequestView[] = [];
  for (const r of rows) {
    const original = meds.find((m) => m.id === r.originalPrescriptionId) ?? null;
    const draft = meds.find((m) => m.id === r.responsePrescriptionId) ?? null;
    const task = tasks.find((t) => t.id === r.taskId);
    const pharmacy = pharmacies.find((p) => p.id === r.pharmacyId);
    const protocol = await evaluateProtocol(tx, r, original, draft);
    const taskState = task ? stateId("task", task.status) : null;
    out.push({
      ...toDto("RxRequest", r),
      patient: patients.find((p) => p.id === r.patientId)!,
      ...(original ? { medication: toDto("MedicationRequest", original) } : {}),
      ...(draft ? { draft: toDto("MedicationRequest", draft) } : {}),
      ...(pharmacy ? { pharmacy: toDto("Pharmacy", pharmacy) } : {}),
      ...(task ? { taskStatus: task.status } : {}),
      allowedTransitions: taskState ? transitionsFrom("task", taskState) : [],
      ...(protocol.lastVisit ? { lastVisit: protocol.lastVisit.toISOString().slice(0, 10) } : {}),
      ...(protocol.pass !== null ? { protocolMet: protocol.pass } : {}),
      protocolNotes: protocol.reasons,
    } as RxRequestView);
  }
  return out;
}

async function loadRequest(ctx: Ctx, id: string) {
  const r = await ctx.db.rxRequest.findUnique({ where: { id } });
  if (!r) throw notFound();
  await requirePatient(ctx, r.patientId);
  ctx.audit.patient(r.patientId);
  ctx.audit.resource("RxRequest", r.id);
  const task = r.taskId ? await ctx.db.task.findUnique({ where: { id: r.taskId } }) : null;
  if (!task) throw conflict("no_task", "This request has no work item.");
  return { req: r, task };
}

async function moveTask(
  ctx: Ctx,
  task: Task,
  to: "pended-to-provider" | "completed",
  extra: Prisma.TaskUpdateInput = {},
) {
  assertTransition("task", task.status, to, ctx.staff().role);
  return ctx.db.task.update({
    where: { id: task.id, version: task.version },
    data: {
      status: toEnum(to) as TaskStatus,
      ...(to === "completed" ? { completedAt: new Date(), completedById: ctx.staff().userId } : {}),
      ...extra,
      version: { increment: 1 },
    },
  });
}

async function draftOf(ctx: Ctx, req: RxRequest) {
  const draft = req.responsePrescriptionId
    ? await ctx.db.medicationRequest.findUnique({ where: { id: req.responsePrescriptionId } })
    : null;
  if (!draft) throw conflict("no_draft", "This request has no response prescription.");
  return draft;
}

async function inboundRef(tx: Tx, req: RxRequest) {
  const m = req.interfaceMessageId
    ? await tx.interfaceMessage.findUnique({ where: { id: req.interfaceMessageId } })
    : null;
  return m?.vendorRef ?? req.id;
}

async function sendDenial(ctx: Ctx, req: RxRequest, reason: string) {
  const gw = erxGateway();
  if (!gw) return;
  const requestMessageId = await inboundRef(ctx.db, req);
  const kind = req.type === "CHANGE" ? "change" : "renewal";
  try {
    await recordCall(
      ctx.db,
      {
        practiceId: req.practiceId,
        kind: "LOGICOY",
        messageType: kind === "change" ? "RxChangeResponse" : "RxRenewalResponse",
        idempotencyKey: `erx:deny:${req.id}`,
        correlationType: "RxRequest",
        correlationId: req.id,
        failed: (r) => (r.status === "accepted" ? null : (r.error ?? "rejected")),
        vendorRef: (r) => r.messageId,
      },
      () => gw.sendRequestResponse({ requestMessageId, kind, decision: "denied", reason }),
    );
  } catch {
    await createTask(ctx.db, req.practiceId, {
      type: "INTERFACE_FAILURE",
      title: "A denial was not sent to the pharmacy",
      description:
        "The e-prescribing network did not accept the denial. It retries from the interface monitor; call the pharmacy.",
      patientId: req.patientId,
      focusType: "RxRequest",
      focusId: req.id,
      poolKind: "care-team",
      priority: "HIGH",
    });
  }
}

/** Matches an inbound request to one patient (and our prescription), or returns null. */
async function matchPatient(
  tx: Tx,
  ev: Extract<ErxInboundEvent, { type: "RxRenewalRequest" | "RxChangeRequest" }>,
) {
  const original =
    ev.prescriptionId && UUID.test(ev.prescriptionId)
      ? await tx.medicationRequest.findUnique({ where: { id: ev.prescriptionId } })
      : null;
  const candidates = await tx.patient.findMany({
    where: {
      mrn: ev.patient.mrn,
      birthDate: new Date(`${ev.patient.birthDate}T00:00:00Z`),
      mergedIntoId: null,
    },
  });
  const same = (s: string) => s.trim().toLowerCase();
  const matches = candidates.filter((p) => same(p.lastName) === same(ev.patient.lastName));
  if (matches.length !== 1) return null;
  const patient = matches[0]!;
  if (original && original.patientId !== patient.id) return null;
  return { patient, original };
}

async function ingestRequest(
  tx: Tx,
  practiceId: string,
  ev: Extract<ErxInboundEvent, { type: "RxRenewalRequest" | "RxChangeRequest" }>,
  messageId: string,
) {
  const match = await matchPatient(tx, ev);
  if (!match) {
    await createTask(tx, practiceId, {
      type: "INTERFACE_FAILURE",
      title: "A pharmacy request couldn't be matched to a patient",
      description: "Check the message on the interface monitor and call the pharmacy.",
      focusType: "InterfaceMessage",
      focusId: messageId,
      poolKind: "care-team",
      priority: "HIGH",
    });
    return null;
  }
  const { patient, original } = match;
  const pharmacy = await tx.pharmacy.findFirst({ where: { ncpdpId: ev.pharmacyNcpdpId } });
  const want = ev.requested ?? {};
  let drug = original
    ? {
        rxnormCode: original.rxnormCode,
        display: original.display,
        isControlled: original.isControlled,
        deaSchedule: original.deaSchedule,
      }
    : null;
  if (want.rxcui && want.rxcui !== original?.rxnormCode) {
    let concept = null;
    try {
      concept = await getDrugConcept(tx, want.rxcui);
    } catch {
      /* resolved again when the provider checks the draft */
    }
    const controlled = concept ? isControlledConcept(concept) : (original?.isControlled ?? false);
    drug = {
      rxnormCode: want.rxcui,
      display: concept?.name ?? want.description ?? want.rxcui,
      isControlled: controlled,
      deaSchedule: controlled
        ? (concept?.deaSchedule ?? original?.deaSchedule ?? "unverified")
        : null,
    };
  }
  const type = ev.type === "RxRenewalRequest" ? "RENEWAL" : "CHANGE";
  const draft = drug
    ? await tx.medicationRequest.create({
        data: {
          practiceId,
          patientId: patient.id,
          encounterId: null,
          prescriberId: original!.prescriberId,
          ...drug,
          sigText: original?.sigText ?? "",
          doseQuantity: original?.doseQuantity ?? null,
          doseUnit: original?.doseUnit ?? null,
          route: original?.route ?? null,
          frequency: original?.frequency ?? null,
          quantity: want.quantity ?? original?.quantity ?? 0,
          quantityUnit: original?.quantityUnit ?? "each",
          refills: want.refills ?? original?.refills ?? 0,
          daysSupply: want.daysSupply ?? original?.daysSupply ?? null,
          substitutionAllowed: original?.substitutionAllowed ?? true,
          reasonConditionId: original?.reasonConditionId ?? null,
          pharmacyId: pharmacy?.id ?? original?.pharmacyId ?? null,
          priorPrescriptionId: original?.id ?? null,
          intent: "order",
        },
      })
    : null;
  const req = await tx.rxRequest.create({
    data: {
      practiceId,
      patientId: patient.id,
      type,
      originalPrescriptionId: original?.id ?? null,
      requestedChange: (ev.requested ?? undefined) as Prisma.InputJsonValue | undefined,
      pharmacyId: pharmacy?.id ?? null,
      responsePrescriptionId: draft?.id ?? null,
      interfaceMessageId: messageId,
    },
  });
  const protocol = await evaluateProtocol(tx, req, original, draft);
  const what = draft?.display ?? want.description ?? "medication";
  const task = await createTask(tx, practiceId, {
    type: "RX_REQUEST",
    title: `${type === "RENEWAL" ? "Renewal" : "Change"} request: ${what}`,
    description: want.reason ?? null,
    patientId: patient.id,
    focusType: "RxRequest",
    focusId: req.id,
    poolKind: "care-team",
  });
  await tx.rxRequest.update({
    where: { id: req.id },
    data: {
      taskId: task.id,
      protocolResult: { pass: protocol.pass, reasons: protocol.reasons } as Prisma.InputJsonValue,
    },
  });
  return req;
}

/** Processes one vendor event (webhook and simulated network). Idempotent per event id. */
export async function ingestErxEvent(tx: Tx, practiceId: string, ev: ErxInboundEvent) {
  const conn = await connectionFor(tx, practiceId, "LOGICOY");
  const key = `erx-in:${ev.eventId}`;
  const prior = await tx.interfaceMessage.findUnique({ where: { idempotencyKey: key } });
  if (prior && prior.status === "ACKNOWLEDGED") return { messageId: prior.id, duplicate: true };
  const msg =
    prior ??
    (await tx.interfaceMessage.create({
      data: {
        practiceId,
        connectionId: conn.id,
        direction: "INBOUND",
        messageType: ev.type,
        idempotencyKey: key,
        status: "SENDING",
        attempts: 1,
        vendorRef: ev.eventId,
      },
    }));
  let correlation: { type: string; id: string } | null = null;
  if (ev.type === "RxRenewalRequest" || ev.type === "RxChangeRequest") {
    const req = await ingestRequest(tx, practiceId, ev, msg.id);
    if (req) correlation = { type: "RxRequest", id: req.id };
  } else {
    const ev2 = ev as Extract<ErxInboundEvent, { type: "Status" | "Error" }>;
    const rx = await tx.medicationRequest.findFirst({ where: { erxMessageId: ev2.messageId } });
    if (rx && ev.type === "Status")
      await tx.medicationRequest.update({ where: { id: rx.id }, data: { erxStatus: "ACCEPTED" } });
    if (rx && ev2.type === "Error") {
      // A pharmacy rejection comes back as a change request for the prescriber (flow:encounter/05 failure).
      await tx.medicationRequest.update({
        where: { id: rx.id },
        data: {
          erxStatus: "ERROR",
          erxError: (ev2.description ?? ev2.code ?? "Rejected").slice(0, 200),
        },
      });
      const patient = await tx.patient.findUniqueOrThrow({ where: { id: rx.patientId } });
      const pharmacy = rx.pharmacyId
        ? await tx.pharmacy.findUnique({ where: { id: rx.pharmacyId } })
        : null;
      const req = await ingestRequest(
        tx,
        practiceId,
        {
          type: "RxChangeRequest",
          eventId: ev.eventId,
          practiceId,
          pharmacyNcpdpId: pharmacy?.ncpdpId ?? "",
          prescriptionId: rx.id,
          patient: {
            mrn: patient.mrn,
            lastName: patient.lastName,
            firstName: patient.firstName,
            birthDate: patient.birthDate.toISOString().slice(0, 10),
          },
          requested: {
            reason: `Pharmacy rejected the prescription: ${ev2.description ?? ev2.code ?? "no reason given"}`,
          },
        },
        msg.id,
      );
      if (req) correlation = { type: "RxRequest", id: req.id };
    }
    if (rx && !correlation) correlation = { type: "MedicationRequest", id: rx.id };
  }
  await tx.interfaceMessage.update({
    where: { id: msg.id },
    data: {
      status: "ACKNOWLEDGED",
      completedAt: new Date(),
      correlationType: correlation?.type ?? null,
      correlationId: correlation?.id ?? null,
    },
  });
  await writeAuditEntries(
    tx,
    {
      practiceId,
      actorType: "integration",
      actorId: null,
      actorRole: null,
      sessionId: null,
      ip: null,
      userAgent: null,
    },
    [
      {
        action: "CREATE",
        resourceType: correlation?.type ?? "InterfaceMessage",
        resourceId: correlation?.id ?? msg.id,
        operationId: "logicoyWebhook",
        detail: { event: ev.type },
      },
    ],
  );
  return { messageId: msg.id, duplicate: false };
}

export const rxRequestHandlers: HandlerMap = {
  async logicoyWebhook(ctx) {
    const raw = ctx.rawBody;
    if (!raw?.length) throw notFound();
    let ev: ErxInboundEvent;
    try {
      ev = JSON.parse(raw.toString("utf8")) as ErxInboundEvent;
    } catch {
      throw unauthenticated("invalid_signature", "Unreadable message.");
    }
    if (!ev?.practiceId || !UUID.test(ev.practiceId) || !ev.eventId)
      throw unauthenticated("invalid_signature", "Unknown practice.");
    await ctx.bindTenant(ev.practiceId);
    const practice = await ctx.db.practice.findUnique({ where: { id: ev.practiceId } });
    if (!practice) throw unauthenticated("invalid_signature", "Unknown practice.");
    const conn = await connectionFor(ctx.db, ev.practiceId, "LOGICOY");
    if (!verifyErxSignature(conn.id, raw, ctx.headers["x-logicoy-signature"]))
      throw unauthenticated("invalid_signature", "Signature check failed.");
    await ingestErxEvent(ctx.db, ev.practiceId, ev);
    ctx.audit.suppressDefault();
    return { requestId: ctx.requestId, status: "accepted" };
  },

  async listRxRequests(ctx) {
    const limit = limitOf(ctx.query);
    const statuses = ctx.query.status
      ? ([] as string[])
          .concat(ctx.query.status as string | string[])
          .map((s) => toEnum(s) as TaskStatus)
      : OPEN_TASK;
    const tasks = await ctx.db.task.findMany({
      where: {
        type: "RX_REQUEST",
        status: { in: statuses },
        ...(ctx.query.poolId ? { poolId: ctx.query.poolId } : {}),
      },
      select: { id: true },
    });
    const rows = await ctx.db.rxRequest.findMany({
      where: {
        taskId: { in: tasks.map((t) => t.id) },
        ...(ctx.query.cursor ? { receivedAt: { lt: new Date(ctx.query.cursor) } } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: limit + 1,
    });
    const visible = [];
    for (const r of rows) {
      try {
        await requirePatient(ctx, r.patientId);
        visible.push(r);
      } catch {
        /* restricted chart: not listed */
      }
    }
    const v = await views(ctx.db, visible.slice(0, limit));
    for (const r of visible.slice(0, limit))
      ctx.audit.add({
        action: "READ",
        patientId: r.patientId,
        resourceType: "RxRequest",
        resourceId: r.id,
        operationId: "listRxRequests",
      });
    ctx.audit.suppressDefault();
    return page(
      visible,
      limit,
      (r) => v.find((x) => x.id === r.id)!,
      (r) => r.receivedAt.toISOString(),
    );
  },

  async getRxRequest(ctx) {
    const { req } = await loadRequest(ctx, ctx.params.rxRequestId);
    return (await views(ctx.db, [req]))[0]!;
  },

  async pendRxRequest(ctx) {
    const { req, task } = await loadRequest(ctx, ctx.params.rxRequestId);
    const draft = req.responsePrescriptionId
      ? await ctx.db.medicationRequest.findUnique({ where: { id: req.responsePrescriptionId } })
      : null;
    const prescriber = draft
      ? await ctx.db.practitioner.findUnique({ where: { id: draft.prescriberId } })
      : null;
    await moveTask(ctx, task, "pended-to-provider", {
      ...(prescriber?.userId ? { ownerUserId: prescriber.userId } : {}),
    });
    if (draft?.status === "DRAFT")
      await ctx.db.medicationRequest.update({
        where: { id: draft.id },
        data: { pendedById: ctx.staff().userId },
      });
    const comment = ctx.body.comment?.trim();
    if (comment)
      await ctx.db.taskComment.create({
        data: {
          practiceId: req.practiceId,
          taskId: task.id,
          body: comment,
          authorId: ctx.staff().userId,
        },
      });
    return (await views(ctx.db, [req]))[0]!;
  },

  async approveRxRequest(ctx) {
    const { req, task } = await loadRequest(ctx, ctx.params.rxRequestId);
    const b = ctx.body;
    if (b.decision === "deny" || b.decision === "needs-visit") {
      const reason =
        b.denialReason?.trim() ||
        (b.decision === "needs-visit" ? "Patient needs an appointment" : "");
      return deny(ctx, req, task, reason);
    }
    let draft = await draftOf(ctx, req);
    // OPEN-Q22: controlled renewals need the EPCS flow, which this request has no fields for.
    if (draft.isControlled)
      throw unprocessable(
        "controlled_renewal",
        "Controlled-substance requests can't be approved here. Deny with 'new prescription to follow' and prescribe from a visit.",
      );
    if (!erxGateway())
      throw conflict(
        "gateway_unavailable",
        "E-prescribing isn't connected, so the response can't be sent. Call the pharmacy.",
      );
    if (b.quantity !== undefined || b.refills !== undefined || b.daysSupply !== undefined) {
      if (b.quantity !== undefined && b.quantity !== null && !(b.quantity > 0))
        throw validationFailed([
          { field: "quantity", code: "invalid", message: "Enter a quantity above zero." },
        ]);
      draft = await ctx.db.medicationRequest.update({
        where: { id: draft.id, version: draft.version },
        data: {
          ...(b.quantity != null ? { quantity: b.quantity } : {}),
          ...(b.refills != null ? { refills: b.refills } : {}),
          ...(b.daysSupply != null ? { daysSupply: b.daysSupply } : {}),
          ...(b.note?.trim() ? { noteToPharmacist: b.note.trim() } : {}),
          version: { increment: 1 },
        },
      });
    }
    // INV-SAFE-01 / INV-SAFE-06: same signing rules as the composer (DUR decisions are made with checkPrescription
    // and decideDurAlert on the draft before approving).
    const [signed] = await signDrafts(ctx, [draft], {
      acknowledgedAlertIds: b.acknowledgedAlertIds ?? [],
    });
    await moveTask(ctx, task, "completed");
    await sendPrescription(ctx.db, signed!, {
      requestMessageId: await inboundRef(ctx.db, req),
      kind: req.type === "CHANGE" ? "change" : "renewal",
    });
    const updated = await ctx.db.rxRequest.update({
      where: { id: req.id },
      data: {
        responseStatus: b.decision === "change" ? "replaced" : "approved",
        responseReason: b.note?.trim() || null,
      },
    });
    ctx.audit.detail({ decision: b.decision });
    return (await views(ctx.db, [updated]))[0]!;
  },

  async denyRxRequest(ctx) {
    const { req, task } = await loadRequest(ctx, ctx.params.rxRequestId);
    return deny(ctx, req, task, ctx.body.reason?.trim() ?? "");
  },
};

async function deny(ctx: Ctx, req: RxRequest, task: Task, reason: string) {
  if (!reason)
    throw validationFailed([
      { field: "reason", code: "required", message: "Say why the request is denied." },
    ]);
  await moveTask(ctx, task, "completed");
  const draft = req.responsePrescriptionId
    ? await ctx.db.medicationRequest.findUnique({ where: { id: req.responsePrescriptionId } })
    : null;
  if (draft?.status === "DRAFT") {
    assertTransition("prescription", draft.status, "cancelled", ctx.staff().role);
    const c = await ctx.db.medicationRequest.update({
      where: { id: draft.id },
      data: { status: "CANCELLED", version: { increment: 1 } },
    });
    await writeVersion(ctx.db, c.practiceId, "MedicationRequest", c, ctx.staff().userId, reason);
  }
  await sendDenial(ctx, req, reason);
  const updated = await ctx.db.rxRequest.update({
    where: { id: req.id },
    data: { responseStatus: "denied", responseReason: reason.slice(0, 500) },
  });
  // Patient notification in the portal thread arrives with S7 (flow:refills/05).
  ctx.audit.detail({ decision: "deny" });
  return (await views(ctx.db, [updated]))[0]!;
}
