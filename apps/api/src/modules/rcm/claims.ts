import { randomUUID } from "node:crypto";
import type { Claim, ClaimLine, ClaimStatus, Prisma, Tx } from "../../db.js";
import {
  ClearinghouseUnavailableError,
  clearinghouseGateway,
} from "../../gateways/clearinghouse/index.js";
import type { ParsedClaimAck } from "../../gateways/clearinghouse/claimParsers.js";
import { putFile, readFileContent } from "../../gateways/fileStore.js";
import { toDto } from "../../platform/dto.js";
import { binary, type HandlerMap } from "../../platform/http/context.js";
import { connectionFor, recordCall } from "../../platform/integrations.js";
import { registerResender } from "../../platform/interfaceRetry.js";
import {
  centsToMoney,
  claimBalancesCents,
  claimInsuranceBalanceCents,
  postLedger,
  transferToPatient,
} from "../../platform/ledger.js";
import { renderPdf } from "../../platform/pdf.js";
import {
  conflict,
  integrationUnavailable,
  invariantBlocked,
  notFound,
  unprocessable,
  validationFailed,
} from "../../platform/problem.js";
import { assertTransition, toEnum, transitionsFrom } from "../../platform/stateMachine.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { summaries } from "../patients/service.js";
import { claimDataFor, pcnOf, scrubStoredClaim } from "./scrubber.js";
import { isValidNpi } from "@agile-emr/shared";

/**
 * Claims (flow:rcm/03-05): batch submission of ready claims as 837P through ClearinghouseGateway, the synchronous
 * 999-style answer, 277CA acknowledgements, rejections as work items with a filing deadline (INV-FIN-05), correction
 * and resubmission with the right frequency code, transfer to patient, status inquiry and closing.
 */

export const X12_837P = "X12_837P";
const SYSTEM = { userId: null as string | null, role: "system" };

const stateId = (s: ClaimStatus) => s.toLowerCase().replace(/_/g, "-");

export async function moveClaim(
  tx: Tx,
  claim: Pick<Claim, "id" | "status">,
  to: string,
  role: string,
  data: Prisma.ClaimUpdateInput = {},
) {
  assertTransition("claim", claim.status, to, role);
  const row = await tx.claim.update({
    where: { id: claim.id },
    data: { ...data, status: toEnum(to) as ClaimStatus, version: { increment: 1 } },
  });
  claim.status = row.status;
  return row;
}

export async function claimEvent(
  tx: Tx,
  claim: Pick<Claim, "id" | "practiceId">,
  type:
    | "CREATED"
    | "SUBMITTED"
    | "ACK_999"
    | "ACK_277CA"
    | "STATUS_277"
    | "REMIT_835"
    | "CORRECTED"
    | "VOIDED"
    | "NOTE",
  description: string,
  extra: {
    statusCode?: string | null;
    interfaceMessageId?: string | null;
    raw?: Prisma.InputJsonValue;
  } = {},
) {
  await tx.claimEvent.create({
    data: {
      practiceId: claim.practiceId,
      claimId: claim.id,
      type,
      description: description.slice(0, 500),
      statusCode: extra.statusCode ?? null,
      interfaceMessageId: extra.interfaceMessageId ?? null,
      ...(extra.raw !== undefined ? { raw: extra.raw } : {}),
    },
  });
}

// ------------------------------------------------------------------ rejections (INV-FIN-05)

/** 277CA status codes we explain in plain language, with the claim field most likely at fault. */
const ACK_REASONS: Record<string, { text: string; field: string }> = {
  "164": { text: "The payer does not recognise the member ID.", field: "coverage.memberId" },
  "33": { text: "An NPI on the claim is invalid.", field: "renderingProviderNpi" },
  "562": { text: "A provider identifier on the claim is invalid.", field: "billingProviderNpi" },
  "21": { text: "Required information is missing or invalid.", field: "claim" },
};

export function plainReason(codes: Array<{ code: string | null; description?: string }>) {
  for (const c of codes) {
    const k = c.code?.split(":").pop() ?? "";
    if (ACK_REASONS[k]) return { ...ACK_REASONS[k]!, code: c.code ?? k };
  }
  const first = codes[0];
  return {
    text: first?.description ? `Rejected: ${first.description}` : "Rejected by the payer.",
    field: "claim",
    code: first?.code ?? "",
  };
}

async function rejectClaim(
  tx: Tx,
  claim: Claim,
  source: "999" | "277CA",
  reason: { text: string; field: string; code: string },
  interfaceMessageId: string | null,
) {
  await moveClaim(tx, claim, "rejected", "system", {
    rejectionReason: reason.text.slice(0, 500),
    rejectionField: reason.field,
  });
  await claimEvent(tx, claim, source === "999" ? "ACK_999" : "ACK_277CA", reason.text, {
    statusCode: `R:${reason.code}`,
    interfaceMessageId,
  });
  // Every rejection is a work item with the filing deadline as its due date (INV-FIN-05).
  await createTask(tx, claim.practiceId, {
    type: "CLAIM_REJECTION",
    title: `Claim ${claim.claimNumber} rejected (${source})`,
    description: reason.text,
    patientId: claim.patientId,
    focusType: "Claim",
    focusId: claim.id,
    poolKind: "billing",
    priority: "HIGH",
    dueAt: claim.filingDeadline,
  });
}

// ------------------------------------------------------------------ submission

export type SubmitResult =
  | { claimId: string; outcome: "submitted" | "rejected" | "clean" }
  | { claimId: string; outcome: "blocked"; blockers: Array<{ code: string; text: string }> }
  | { claimId: string; outcome: "failed"; detail: string };

async function submissionCount(tx: Tx, claimId: string) {
  return tx.claimEvent.count({ where: { claimId, type: "SUBMITTED" } });
}

/**
 * Sends one claim (status ready, or rejected/denied for a resubmission). Never throws for a vendor outage: the
 * claim keeps its status, the InterfaceMessage is FAILED and retried from the interface monitor (INV-OPS-01).
 */
export async function submitOne(
  tx: Tx,
  claimId: string,
  actor: { userId: string | null; role: string },
  opts: { scrubOnly?: boolean; attempt?: number } = {},
): Promise<SubmitResult> {
  const claim = await tx.claim.findUniqueOrThrow({
    where: { id: claimId },
    include: { lines: true },
  });
  const blockers = scrubStoredClaim(claim).map((e) => ({ code: e.key, text: e.text }));
  const built = await claimDataFor(tx, claim);
  if (!built.ok) blockers.push(...built.missing.map((m) => ({ code: "missing", text: m })));
  if (blockers.length || opts.scrubOnly || !built.ok)
    return blockers.length
      ? { claimId, outcome: "blocked", blockers }
      : { claimId, outcome: "clean" };
  const gw = clearinghouseGateway();
  if (!gw) return { claimId, outcome: "failed", detail: "No clearinghouse is connected." };
  const n = opts.attempt ?? (await submissionCount(tx, claim.id)) + 1;
  const key = `837:${claim.id}:${n}`;
  const pcn = pcnOf(claim.claimNumber);
  const payload = Buffer.from(JSON.stringify(built.data), "utf8");
  let outcome;
  try {
    outcome = await recordCall(
      tx,
      {
        practiceId: claim.practiceId,
        kind: "STEDI",
        messageType: X12_837P,
        idempotencyKey: key,
        correlationType: "Claim",
        correlationId: claim.id,
        vendorRef: (r) => r.vendorRef,
      },
      () => gw.submitClaim({ claim: built.data, patientControlNumber: pcn, idempotencyKey: key }),
    );
  } catch (e) {
    if (!(e instanceof ClearinghouseUnavailableError)) throw e;
    await createTask(tx, claim.practiceId, {
      type: "INTERFACE_FAILURE",
      title: `Claim ${claim.claimNumber} was not sent to the clearinghouse`,
      description:
        "The clearinghouse did not answer. The claim stays ready and is retried from the interface monitor.",
      patientId: claim.patientId,
      focusType: "Claim",
      focusId: claim.id,
      poolKind: "billing",
      priority: "HIGH",
    });
    return { claimId, outcome: "failed", detail: e.message };
  }
  const msg = await tx.interfaceMessage.findUniqueOrThrow({ where: { idempotencyKey: key } });
  // The 837 payload (PHI) is kept only as an encrypted file on the message (getClaimX12).
  const file = await putFile(tx, {
    practiceId: claim.practiceId,
    kind: "generated",
    fileName: `${claim.claimNumber}-837-${n}.json`,
    contentType: "application/json",
    data: payload,
  });
  await tx.interfaceMessage.update({ where: { id: msg.id }, data: { payloadFileId: file.id } });
  await completeTasksFor(tx, "Claim", claim.id, ["INTERFACE_FAILURE"], actor.userId);
  const to = "submitted";
  await moveClaim(tx, claim, to, actor.role === "system" ? "system" : actor.role, {
    submittedAt: new Date(),
    rejectionReason: null,
    rejectionField: null,
  });
  await claimEvent(
    tx,
    claim,
    "SUBMITTED",
    `837P sent (frequency ${claim.frequencyCode}, attempt ${n})`,
    { interfaceMessageId: msg.id },
  );
  await tx.chargeItem.updateMany({
    where: { id: { in: claim.lines.map((l) => l.chargeItemId) }, status: "READY" },
    data: { status: "BILLED" },
  });
  if (outcome.status === "rejected") {
    await rejectClaim(tx, claim, "999", plainReason(outcome.errors), msg.id);
    return { claimId, outcome: "rejected" };
  }
  await claimEvent(tx, claim, "ACK_999", "Accepted by the clearinghouse for delivery", {
    statusCode: "A",
    interfaceMessageId: msg.id,
  });
  await completeTasksFor(tx, "Claim", claim.id, ["CLAIM_REJECTION"], actor.userId);
  return { claimId, outcome: "submitted" };
}

/** Batch submit (flow:rcm/03). Returns per-claim results and writes one ClaimBatch row. */
export async function submitBatch(
  tx: Tx,
  practiceId: string,
  ids: string[] | null,
  actor: { userId: string | null; role: string },
  scrubOnly = false,
) {
  const claims = await tx.claim.findMany({
    where: { status: "READY", ...(ids?.length ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const results: SubmitResult[] = [];
  for (const c of claims) results.push(await submitOne(tx, c.id, actor, { scrubOnly }));
  const sent = results.filter((r) => r.outcome === "submitted" || r.outcome === "rejected").length;
  if (!scrubOnly && sent)
    await tx.claimBatch.create({
      data: { practiceId, claimCount: sent, submittedAt: new Date(), status: "submitted" },
    });
  return results;
}

// Resend from the interface monitor re-runs the same attempt under the same key (Stedi de-duplicates on it).
registerResender(X12_837P, async (tx, message) => {
  const claim = message.correlationId
    ? await tx.claim.findUnique({ where: { id: message.correlationId } })
    : null;
  if (!claim || claim.status !== "READY") {
    await tx.interfaceMessage.update({
      where: { id: message.id },
      data: {
        attempts: { increment: 1 },
        status: claim ? "ACKNOWLEDGED" : "DEAD",
        completedAt: new Date(),
      },
    });
    return;
  }
  const attempt = Number(message.idempotencyKey.split(":").pop());
  await submitOne(tx, claim.id, SYSTEM, {
    attempt: Number.isFinite(attempt) ? attempt : undefined,
  });
});

// ------------------------------------------------------------------ acknowledgements (277CA)

/** Applies parsed 277CA acknowledgements (webhook or simulated clearinghouse). Idempotent by claim status. */
export async function applyClaimAcks(
  tx: Tx,
  practiceId: string,
  acks: ParsedClaimAck[],
  interfaceMessageId: string | null,
) {
  let applied = 0;
  for (const ack of acks) {
    const claim = await findByPcn(tx, ack.patientControlNumber);
    if (!claim || claim.status !== "SUBMITTED" || ack.outcome === "Unknown") continue;
    if (ack.outcome === "Accepted") {
      await moveClaim(tx, claim, "accepted", "system");
      await claimEvent(tx, claim, "ACK_277CA", "Accepted by the payer", {
        statusCode: ack.reasonCodes.join(",") || "A",
        interfaceMessageId,
      });
    } else {
      await rejectClaim(
        tx,
        claim,
        "277CA",
        plainReason(ack.reasonCodes.map((c) => ({ code: c }))),
        interfaceMessageId,
      );
    }
    applied++;
  }
  void practiceId;
  return applied;
}

export async function findByPcn(tx: Tx, pcn: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM "Claim" WHERE regexp_replace("claimNumber", '[^A-Za-z0-9]', '', 'g') = ${pcn} LIMIT 1`;
  return rows[0] ? tx.claim.findUnique({ where: { id: rows[0].id } }) : null;
}

// ------------------------------------------------------------------ views

export async function claimSummaries(tx: Tx, claims: Claim[]) {
  const [patients, payers, balances, lastEvents] = await Promise.all([
    summaries(tx, [...new Set(claims.map((c) => c.patientId))]),
    tx.payer.findMany({ where: { id: { in: [...new Set(claims.map((c) => c.payerId))] } } }),
    claimBalancesCents(
      tx,
      claims.map((c) => c.id),
    ),
    tx.claimEvent.groupBy({
      by: ["claimId"],
      where: { claimId: { in: claims.map((c) => c.id) } },
      _max: { at: true },
    }),
  ]);
  const p = new Map(patients.map((x) => [x.id, x]));
  const pay = new Map(payers.map((x) => [x.id, x.name]));
  const last = new Map(lastEvents.map((e) => [e.claimId, e._max.at]));
  return claims.map((c) => ({
    id: c.id,
    number: c.claimNumber,
    status: c.status,
    patient: p.get(c.patientId)!,
    payerName: pay.get(c.payerId) ?? "",
    dateOfService: c.serviceDateFrom.toISOString().slice(0, 10),
    billed: c.totalBilled.toFixed(2),
    paid: c.totalPaid.toFixed(2),
    balance: centsToMoney(balances.get(c.id) ?? 0),
    ageDays: Math.floor((Date.now() - c.createdAt.getTime()) / 86_400_000),
    lastEventAt: (last.get(c.id) ?? c.updatedAt).toISOString(),
  }));
}

export async function claimDetail(tx: Tx, claimId: string) {
  const c = await tx.claim.findUnique({
    where: { id: claimId },
    include: {
      lines: { orderBy: { lineNumber: "asc" } },
      events: { orderBy: { at: "asc" } },
      denials: { orderBy: { createdAt: "asc" } },
      payments: { include: { remittance: { include: { payer: true } } } },
    },
  });
  if (!c) throw notFound();
  const [ledger, [patient], payer] = await Promise.all([
    tx.ledgerEntry.findMany({ where: { claimId }, orderBy: { postedAt: "asc" } }),
    summaries(tx, [c.patientId]),
    tx.payer.findUnique({ where: { id: c.payerId } }),
  ]);
  const { lines, events, denials, payments, ...row } = c;
  const remits = new Map(payments.map((p) => [p.remittanceId, p.remittance]));
  return {
    ...toDto("Claim", row),
    ...(patient ? { patient } : {}),
    ...(payer ? { payerName: payer.name } : {}),
    lines: lines.map((l) => toDto("ClaimLine", l)),
    events: events.map((e) => toDto("ClaimEvent", { ...e, raw: undefined })),
    denials: denials.map((d) => toDto("Denial", d)),
    remittances: [...remits.values()].map((r) => ({
      id: r.id,
      payerName: r.payer.name,
      checkNumber: r.eftTraceNumber,
      paidAt: r.paymentDate.toISOString().slice(0, 10),
      amount: r.paymentAmount.toFixed(2),
      status: r.status,
      claims: payments.filter((p) => p.remittanceId === r.id).length,
      exceptions: 0,
    })),
    ledger: ledger.map((l) => toDto("LedgerEntry", l)),
    allowedTransitions: transitionsFrom("claim", stateId(c.status)),
  };
}

async function loadClaim(
  ctx: { db: Tx; audit: { resource(t: string, id: string): void } },
  id: string,
) {
  const c = await ctx.db.claim.findUnique({ where: { id } });
  if (!c) throw notFound();
  await requirePatient(ctx as never, c.patientId, { identityOnly: true });
  ctx.audit.resource("Claim", c.id);
  return c;
}

const CORRECTABLE_FIELDS = [
  "placeOfService",
  "priorAuthNumber",
  "renderingProviderNpi",
  "billingProviderNpi",
  "coverageId",
] as const;

async function claimPdf(tx: Tx, title: string, claim: Claim, text: string) {
  const practice = await tx.practice.findUniqueOrThrow({ where: { id: claim.practiceId } });
  const patient = await tx.patient.findUniqueOrThrow({ where: { id: claim.patientId } });
  return renderPdf(
    {
      title,
      patientLine: `${patient.lastName}, ${patient.firstName} · MRN ${patient.mrn} · ${claim.claimNumber}`,
      practiceName: practice.legalName,
    },
    (w) => {
      for (const line of text.split("\n")) w.paragraph(line);
    },
  );
}

// ------------------------------------------------------------------ handlers

export const claimHandlers: HandlerMap = {
  async getClaimPipeline(ctx) {
    const rows = await ctx.db.claim.groupBy({
      by: ["status"],
      where: ctx.query.payerId ? { payerId: ctx.query.payerId } : {},
      _count: { _all: true },
      _sum: { totalBilled: true },
    });
    const order = [
      "DRAFT",
      "READY",
      "SUBMITTED",
      "ACCEPTED",
      "REJECTED",
      "PAID",
      "PARTIALLY_PAID",
      "DENIED",
      "APPEALED",
      "CLOSED",
    ] as const;
    return {
      buckets: order.map((s) => {
        const r = rows.find((x) => x.status === s);
        return {
          status: s,
          count: r?._count._all ?? 0,
          amount: (r?._sum.totalBilled ?? 0).toFixed(2),
        };
      }),
    };
  },

  async listClaims(ctx) {
    const q = ctx.query;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const statuses = q.status ? ([] as string[]).concat(q.status as string | string[]) : null;
    if (q.patientId) await requirePatient(ctx, q.patientId, { identityOnly: true });
    const rows = await ctx.db.claim.findMany({
      where: {
        ...(statuses ? { status: { in: statuses as ClaimStatus[] } } : {}),
        ...(q.payerId ? { payerId: q.payerId } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.fromDate || q.toDate
          ? {
              serviceDateFrom: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(q.toDate) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    return {
      data: await claimSummaries(ctx.db, slice),
      nextCursor: rows.length > limit ? slice[slice.length - 1]!.id : null,
      hasMore: rows.length > limit,
    };
  },

  async getClaim(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    return claimDetail(ctx.db, c.id);
  },

  async getClaimX12(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    const msg = await ctx.db.interfaceMessage.findFirst({
      where: {
        correlationType: "Claim",
        correlationId: c.id,
        messageType: X12_837P,
        payloadFileId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
    const file = msg?.payloadFileId
      ? await ctx.db.fileObject.findUnique({ where: { id: msg.payloadFileId } })
      : null;
    if (!file) throw notFound("This claim has not been sent yet.");
    const json = JSON.stringify(
      JSON.parse((await readFileContent(file)).toString("utf8")),
      null,
      2,
    );
    return binary(
      "application/pdf",
      await claimPdf(ctx.db, `837P ${c.claimNumber}`, c, json),
      `${c.claimNumber}-837P.pdf`,
      true,
    );
  },

  async submitClaims(ctx) {
    const b = ctx.body;
    if (!b.scrubOnly && !clearinghouseGateway())
      throw integrationUnavailable("No clearinghouse is connected, so claims can't be sent.");
    const me = ctx.staff();
    const job = await ctx.db.job.create({
      data: {
        practiceId: ctx.practiceId!,
        type: b.scrubOnly ? "claim-scrub" : "claim-batch",
        params: { ids: b.ids },
        status: "RUNNING",
        requestedById: me.userId,
      },
    });
    const results = await submitBatch(
      ctx.db,
      ctx.practiceId!,
      b.ids?.length ? b.ids : null,
      { userId: me.userId, role: me.role },
      !!b.scrubOnly,
    );
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    const done = await ctx.db.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        progress: 100,
        finishedAt: new Date(),
        params: { ids: b.ids, results: results as unknown as Prisma.InputJsonValue },
      },
    });
    ctx.audit.detail({
      submitted: count("submitted"),
      rejected: count("rejected"),
      blocked: count("blocked"),
      failed: count("failed"),
    });
    for (const r of results)
      ctx.audit.add({
        action: "DISCLOSE",
        resourceType: "Claim",
        resourceId: r.claimId,
        operationId: "submitClaims",
        detail: { outcome: r.outcome },
      });
    ctx.setStatus(202);
    return toDto("Job", done);
  },

  async resubmitClaim(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    const me = ctx.staff();
    if (c.status !== "REJECTED" && c.status !== "DENIED")
      throw conflict("invalid_transition", "Only rejected or denied claims can be resubmitted.");
    if (c.status === "DENIED" && c.frequencyCode !== "7")
      throw unprocessable(
        "frequency_code",
        "A denied claim goes back as a corrected claim (frequency 7). Correct the claim first.",
      );
    if (c.status === "DENIED" && !c.payerClaimControlNumber)
      throw unprocessable(
        "payer_reference",
        "The payer's claim number is needed for a corrected claim.",
      );
    if (!clearinghouseGateway())
      throw integrationUnavailable("No clearinghouse is connected, so claims can't be sent.");
    // Role check for rejected->submitted / denied->submitted before calling out.
    assertTransition("claim", c.status, "submitted", me.role);
    const r = await submitOne(ctx.db, c.id, { userId: me.userId, role: me.role });
    if (r.outcome === "blocked")
      throw invariantBlocked(
        r.blockers.map((b) => ({ ...b, invariant: "INV-FIN-03" })),
        "Fix the listed items before resubmitting.",
      );
    if (r.outcome === "failed") throw integrationUnavailable(r.detail);
    if (c.status === "DENIED")
      await ctx.db.denial.updateMany({
        where: { claimId: c.id, status: "OPEN" },
        data: { status: "CORRECTED", action: "CORRECTED_CLAIM" },
      });
    ctx.audit.detail({ outcome: r.outcome, frequency: c.frequencyCode });
    return claimDetail(ctx.db, c.id);
  },

  async updateClaim(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    ctx.checkVersion(c.version, ctx.ifMatch());
    const b = ctx.body;
    if (!["REJECTED", "DENIED", "READY"].includes(c.status))
      throw conflict("not_correctable", "Only ready, rejected or denied claims can be corrected.");
    // A 277CA/999 rejection never reached adjudication: it goes back as an original (1). A denied claim was
    // adjudicated: it needs a replacement (7) or void (8) with the payer's claim number.
    if (c.status === "DENIED" && b.frequencyCode === "1")
      throw validationFailed([
        {
          field: "frequencyCode",
          code: "replacement_required",
          message: "A denied claim is corrected with frequency 7 (replacement) or 8 (void).",
        },
      ]);
    if (c.status !== "DENIED" && b.frequencyCode !== "1")
      throw validationFailed([
        {
          field: "frequencyCode",
          code: "original_required",
          message: "This claim was never adjudicated; send it as an original (1).",
        },
      ]);
    const changes = (b.changes ?? {}) as Record<string, unknown>;
    const data: Prisma.ClaimUpdateInput = {
      frequencyCode: b.frequencyCode,
      version: { increment: 1 },
    };
    for (const k of Object.keys(changes)) {
      if (k === "lines") continue;
      if (!(CORRECTABLE_FIELDS as readonly string[]).includes(k))
        throw validationFailed([
          {
            field: `changes.${k}`,
            code: "not_correctable",
            message: `${k} can't be changed on a claim.`,
          },
        ]);
    }
    for (const k of ["renderingProviderNpi", "billingProviderNpi"] as const)
      if (typeof changes[k] === "string") {
        if (!isValidNpi(changes[k] as string))
          throw validationFailed([
            {
              field: `changes.${k}`,
              code: "invalid_npi",
              message: "That NPI fails the check digit.",
            },
          ]);
        data[k] = changes[k] as string;
      }
    if (typeof changes.placeOfService === "string") data.placeOfService = changes.placeOfService;
    if (changes.priorAuthNumber !== undefined)
      data.priorAuthNumber = (changes.priorAuthNumber as string | null) || null;
    if (typeof changes.coverageId === "string") {
      const cov = await ctx.db.coverage.findFirst({
        where: { id: changes.coverageId, patientId: c.patientId },
      });
      if (!cov)
        throw validationFailed([
          {
            field: "changes.coverageId",
            code: "not_found",
            message: "That coverage isn't on this patient.",
          },
        ]);
      data.coverage = { connect: { id: cov.id } };
      data.payer = { connect: { id: cov.payerId } };
    }
    if (Array.isArray(changes.lines))
      for (const raw of changes.lines as Array<Record<string, unknown>>) {
        const line = await ctx.db.claimLine.findFirst({
          where: { claimId: c.id, lineNumber: Number(raw.lineNumber) },
        });
        if (!line)
          throw validationFailed([
            {
              field: "changes.lines",
              code: "not_found",
              message: `Line ${String(raw.lineNumber)} is not on this claim.`,
            },
          ]);
        const d: Prisma.ClaimLineUpdateInput = {};
        if (Array.isArray(raw.modifiers))
          d.modifiers = (raw.modifiers as string[]).map((m) => m.toUpperCase());
        if (raw.units !== undefined) d.units = Number(raw.units);
        await ctx.db.claimLine.update({ where: { id: line.id }, data: d });
      }
    await ctx.db.claim.update({ where: { id: c.id, version: c.version }, data });
    await claimEvent(
      ctx.db,
      c,
      "CORRECTED",
      `Corrected (frequency ${b.frequencyCode}): ${b.reason}`.slice(0, 500),
    );
    ctx.audit.detail({ fields: Object.keys(changes), frequency: b.frequencyCode });
    return claimDetail(ctx.db, c.id);
  },

  async transferClaimToPatient(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    const me = ctx.staff();
    if (c.status !== "REJECTED")
      throw conflict(
        "invalid_transition",
        "Only a rejected claim can be billed to the patient from here.",
      );
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([{ field: "reason", code: "required", message: "Give a reason." }]);
    assertTransition("claim", c.status, "closed", me.role);
    const open = await claimInsuranceBalanceCents(ctx.db, c.id);
    // INV-FIN-01: the transfer is two new rows; nothing is changed.
    await postLedger(
      ctx.db,
      transferToPatient(
        {
          practiceId: c.practiceId,
          patientId: c.patientId,
          encounterId: c.encounterId,
          claimId: c.id,
          memo: `Billed to patient: ${reason}`.slice(0, 200),
          postedById: me.userId,
        },
        open,
      ),
    );
    await moveClaim(ctx.db, c, "closed", me.role);
    await claimEvent(ctx.db, c, "NOTE", `Balance ${centsToMoney(open)} transferred to the patient`);
    await completeTasksFor(ctx.db, "Claim", c.id, ["CLAIM_REJECTION"], me.userId);
    ctx.audit.detail({ transferred: centsToMoney(open) });
    return claimDetail(ctx.db, c.id);
  },

  async closeClaim(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    const me = ctx.staff();
    assertTransition("claim", c.status, "closed", me.role);
    const open = await claimInsuranceBalanceCents(ctx.db, c.id);
    // Guard: zero insurance balance (an approved write-off already posted reduces it to zero).
    if (open !== 0)
      throw unprocessable(
        "insurance_balance_open",
        `${centsToMoney(open)} is still open with the payer. Post, appeal or write it off first.`,
      );
    await moveClaim(ctx.db, c, "closed", me.role);
    await claimEvent(ctx.db, c, "NOTE", `Closed: ${ctx.body.reason}`.slice(0, 500));
    await completeTasksFor(ctx.db, "Claim", c.id, ["CLAIM_REJECTION", "DENIAL"], me.userId);
    return claimDetail(ctx.db, c.id);
  },

  async checkClaimStatus(ctx) {
    const c = await loadClaim(ctx, ctx.params.claimId);
    const gw = clearinghouseGateway();
    if (!gw) throw integrationUnavailable("No clearinghouse is connected.");
    const claim = await ctx.db.claim.findUniqueOrThrow({
      where: { id: c.id },
      include: { lines: true },
    });
    const built = await claimDataFor(ctx.db, claim);
    if (!built.ok) throw unprocessable("claim_incomplete", built.missing.join("; "));
    try {
      const r = await recordCall(
        ctx.db,
        {
          practiceId: c.practiceId,
          kind: "STEDI",
          messageType: "X12_276",
          idempotencyKey: `276:${c.id}:${ctx.headers["idempotency-key"] ?? randomUUID()}`,
          correlationType: "Claim",
          correlationId: c.id,
        },
        () => gw.claimStatus({ claim: built.data, patientControlNumber: pcnOf(c.claimNumber) }),
      );
      await claimEvent(ctx.db, c, "STATUS_277", r.description, {
        statusCode: [r.category, r.code].filter(Boolean).join(":") || null,
      });
    } catch (e) {
      if (e instanceof ClearinghouseUnavailableError) throw integrationUnavailable(e.message);
      throw e;
    }
    return claimDetail(ctx.db, c.id);
  },

  async listRejections(ctx) {
    const q = ctx.query;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const rows = await ctx.db.claim.findMany({
      where: { status: "REJECTED", ...(q.payerId ? { payerId: q.payerId } : {}) },
      orderBy: [{ filingDeadline: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    const [sums, events] = await Promise.all([
      claimSummaries(ctx.db, slice),
      ctx.db.claimEvent.findMany({
        where: {
          claimId: { in: slice.map((c) => c.id) },
          type: { in: ["ACK_999", "ACK_277CA"] },
          statusCode: { startsWith: "R:" },
        },
        orderBy: { at: "desc" },
      }),
    ]);
    return {
      data: slice.map((c, i) => {
        const ev = events.find((e) => e.claimId === c.id);
        return {
          claim: sums[i]!,
          source: ev?.type === "ACK_999" ? ("999" as const) : ("277CA" as const),
          code: ev?.statusCode?.slice(2) ?? "",
          text: c.rejectionReason ?? "Rejected",
          ...(c.rejectionField ? { field: c.rejectionField } : {}),
          rejectedAt: (ev?.at ?? c.updatedAt).toISOString(),
          filingDeadline: c.filingDeadline.toISOString().slice(0, 10),
        };
      }),
      nextCursor: rows.length > limit ? slice[slice.length - 1]!.id : null,
      hasMore: rows.length > limit,
    };
  },
};

export type ClaimWithLines = Claim & { lines: ClaimLine[] };
export { connectionFor };
