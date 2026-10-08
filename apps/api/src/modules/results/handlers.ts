import type { DiagnosticReport, IntegrationKind, ServiceRequest, Tx } from "../../db.js";
import { readFileContent } from "../../gateways/fileStore.js";
import { verifyLabSignature } from "../../gateways/lab/index.js";
import { limitOf, page, toDto } from "../../platform/dto.js";
import { binary, type Ctx, type HandlerMap } from "../../platform/http/context.js";
import { connectionFor } from "../../platform/integrations.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { renderPdf } from "../../platform/pdf.js";
import { conflict, notFound, unauthenticated, unprocessable } from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { summaries } from "../patients/service.js";
import { loadSrRow, reportSummary, srView } from "../orders/views.js";
import { fileReport, ingestLabMessage, storedOrder } from "./ingest.js";

/**
 * Results (inbox.results, chart.results, orders.result-reconciliation). Review, release and critical-value
 * communication. INV-SAFE-04: a critical result can't be signed off until a successful contact is documented.
 */

const PROVIDERS: Record<string, IntegrationKind> = {
  "health-gorilla": "HEALTH_GORILLA",
  quest: "QUEST",
  labcorp: "LABCORP",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_TASK = ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] as const;

async function loadReport(ctx: Ctx, id: string) {
  const dr = await ctx.db.diagnosticReport.findUnique({ where: { id } });
  if (!dr) throw notFound();
  await requirePatient(ctx, dr.patientId);
  ctx.audit.resource("DiagnosticReport", dr.id);
  ctx.audit.patient(dr.patientId);
  return dr;
}

async function trendsFor(tx: Tx, patientId: string, codes: string[]) {
  if (!codes.length) return [];
  const rows = await tx.observation.findMany({
    where: {
      patientId,
      loincCode: { in: codes },
      category: "LABORATORY",
      stagingStatus: "ACTIVE",
      status: { notIn: ["CANCELLED", "ENTERED_IN_ERROR"] },
      valueQuantity: { not: null },
    },
    orderBy: { effectiveAt: "asc" },
  });
  return codes
    .map((code) => {
      const pts = rows.filter((r) => r.loincCode === code).slice(-8);
      const last = pts.at(-1);
      return {
        code,
        display: last?.display ?? code,
        ...(last?.valueUnit ? { unit: last.valueUnit } : {}),
        ...(last?.referenceRangeText ? { referenceRange: last.referenceRangeText } : {}),
        points: pts.map((p) => ({
          at: p.effectiveAt,
          value: Number(p.valueQuantity),
          flag: p.flag ?? "NORMAL",
          observationId: p.id,
        })),
      };
    })
    .filter((t) => t.points.length > 1);
}

export async function reportDetail(tx: Tx, dr: DiagnosticReport) {
  const [observations, srRow, contacts, pdf] = await Promise.all([
    tx.observation.findMany({
      where: { diagnosticReportId: dr.id },
      orderBy: { createdAt: "asc" },
    }),
    dr.serviceRequestId ? loadSrRow(tx, dr.serviceRequestId) : null,
    tx.criticalResultContact.findMany({
      where: { diagnosticReportId: dr.id },
      orderBy: { contactedAt: "asc" },
    }),
    dr.pdfFileId ? tx.fileObject.findUnique({ where: { id: dr.pdfFileId } }) : null,
  ]);
  const priorResults = await trendsFor(tx, dr.patientId, [
    ...new Set(observations.map((o) => o.loincCode)),
  ]);
  return toDto("DiagnosticReportDetail", {
    ...dr,
    observations,
    serviceRequest: srRow ? srView(srRow) : undefined,
    priorResults,
    criticalContacts: contacts,
    pdf: pdf ?? undefined,
  });
}

async function reviewOne(
  ctx: Ctx,
  dr: DiagnosticReport,
  opts: { comment?: string; patientComment?: string; release?: boolean },
) {
  if (dr.status === "PRELIMINARY" || dr.status === "REGISTERED" || dr.status === "PARTIAL")
    throw conflict(
      "result_not_final",
      "Preliminary results are signed off when the final result arrives.",
    );
  if (dr.isCritical) {
    const reached = await ctx.db.criticalResultContact.findFirst({
      where: { diagnosticReportId: dr.id, reached: true },
    });
    if (!reached)
      throw unprocessable(
        "critical_contact_required",
        "Document the call with the patient (or their clinician) before signing off a critical result.",
        { invariant: "INV-SAFE-04" },
      );
  }
  const sr = dr.serviceRequestId
    ? await ctx.db.serviceRequest.findUnique({ where: { id: dr.serviceRequestId } })
    : null;
  const now = new Date();
  const updated = await ctx.db.diagnosticReport.update({
    where: { id: dr.id, version: dr.version },
    data: {
      reviewedById: ctx.staff().userId,
      reviewedAt: now,
      ...(dr.status === "CORRECTED" ? { correctionAcknowledgedAt: now } : {}),
      ...(opts.patientComment !== undefined ? { reviewComment: opts.patientComment || null } : {}),
      ...(opts.release
        ? { releasedToPortalAt: dr.releasedToPortalAt ?? now, releaseDelayReason: null }
        : {}),
      version: { increment: 1 },
    },
  });
  if (sr && sr.status === "RESULTED_FINAL") {
    // Every report on the order must be signed off before the order is reviewed.
    const pending = await ctx.db.diagnosticReport.count({
      where: {
        serviceRequestId: sr.id,
        reviewedAt: null,
        status: { notIn: ["CANCELLED", "ENTERED_IN_ERROR"] },
      },
    });
    if (!pending) {
      assertTransition("order", sr.status, "reviewed", ctx.staff().role);
      await ctx.db.serviceRequest.update({
        where: { id: sr.id },
        data: { status: "REVIEWED", version: { increment: 1 } },
      });
    }
  }
  await completeTasksFor(
    ctx.db,
    "DiagnosticReport",
    dr.id,
    ["RESULT_REVIEW", "CRITICAL_RESULT"],
    ctx.staff().userId,
  );
  ctx.audit.add({
    action: "UPDATE",
    patientId: dr.patientId,
    resourceType: "DiagnosticReport",
    resourceId: dr.id,
    operationId: "reviewResult",
    detail: {
      reviewed: true,
      released: !!opts.release,
      comment: opts.comment ? "provided" : undefined,
    },
  });
  return updated;
}

export const resultHandlers: HandlerMap = {
  async labWebhook(ctx) {
    const kind = PROVIDERS[ctx.params.provider];
    const raw = ctx.rawBody?.toString("utf8") ?? "";
    if (!kind || !raw) throw notFound();
    // Tenant from MSH-6 (receiving facility = our practice id at the lab), then the connection's signature key.
    const facility = /^MSH\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|([^|^]*)/.exec(raw)?.[1] ?? "";
    if (!UUID.test(facility))
      throw unauthenticated("invalid_signature", "Unknown receiving facility.");
    await ctx.bindTenant(facility);
    const practice = await ctx.db.practice.findUnique({ where: { id: facility } });
    if (!practice) throw unauthenticated("invalid_signature", "Unknown receiving facility.");
    const conn = await connectionFor(ctx.db, facility, kind);
    if (!verifyLabSignature(conn.id, ctx.rawBody!, ctx.headers["x-lab-signature"]))
      throw unauthenticated("invalid_signature", "Signature check failed.");
    const out = await ingestLabMessage(ctx.db, facility, kind, raw, ctx.headers["idempotency-key"]);
    ctx.audit.resource("InterfaceMessage", out.messageId);
    ctx.audit.detail({
      filed: out.filed.length,
      unmatched: out.unmatched.length,
      duplicate: out.duplicate,
    });
    return { requestId: ctx.requestId, status: "accepted" };
  },

  async listDiagnosticReports(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const q = ctx.query;
    const limit = limitOf(q);
    const statuses = q.status ? ([] as string[]).concat(q.status as string | string[]) : null;
    const rows = await ctx.db.diagnosticReport.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...(q.category ? { category: q.category } : {}),
        ...(statuses
          ? { status: { in: statuses as never } }
          : { status: { not: "ENTERED_IN_ERROR" } }),
        ...(q.fromDate || q.toDate
          ? {
              issuedAt: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(`${q.toDate}T23:59:59Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ issuedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    ctx.audit.patient(ctx.params.patientId);
    return page(
      rows,
      limit,
      (r) => toDto("DiagnosticReportSummary", reportSummary(r)),
      (r) => r.id,
    );
  },

  async getDiagnosticReport(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    return reportDetail(ctx.db, dr);
  },

  async getDiagnosticReportPdf(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    if (dr.pdfFileId) {
      const file = await ctx.db.fileObject.findUnique({ where: { id: dr.pdfFileId } });
      if (file) return binary(file.contentType, await readFileContent(file), file.fileName);
    }
    const [p, practice, obs] = await Promise.all([
      ctx.db.patient.findUniqueOrThrow({ where: { id: dr.patientId } }),
      ctx.db.practice.findFirstOrThrow(),
      ctx.db.observation.findMany({
        where: { diagnosticReportId: dr.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const pdf = await renderPdf(
      {
        title: `${dr.display} · ${dr.issuedAt?.toISOString().slice(0, 10) ?? ""}`,
        patientLine: `${p.lastName}, ${p.firstName} · DOB ${p.birthDate.toISOString().slice(0, 10)} · MRN ${p.mrn}`,
        practiceName: practice.legalName,
      },
      (w) => {
        w.keyValue([
          ["Status", dr.status.toLowerCase()],
          ["Lab", dr.performerLab ?? "—"],
          ["Accession", dr.accessionNumber ?? "—"],
          ["Collected", dr.effectiveAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"],
        ]);
        w.subheading("Results");
        w.keyValue(
          obs.map((o) => [
            o.display,
            `${o.valueQuantity ?? o.valueString ?? ""} ${o.valueUnit ?? ""}${o.interpretation && o.interpretation !== "N" ? ` (${o.interpretation})` : ""}${o.referenceRangeText ? ` · ref ${o.referenceRangeText}` : ""}`.trim(),
          ]),
        );
        if (dr.conclusion) {
          w.subheading("Lab comments");
          w.paragraph(dr.conclusion);
        }
      },
    );
    return binary("application/pdf", pdf, `result-${dr.id.slice(0, 8)}.pdf`);
  },

  async listResultsToReview(ctx) {
    const me = ctx.staff().userId;
    const limit = limitOf(ctx.query);
    const pools = await ctx.db.workPoolMember.findMany({ where: { userId: me } });
    const poolIds = ctx.query.poolId ? [ctx.query.poolId] : pools.map((p) => p.poolId);
    const assignee = ctx.query.assignee as string | undefined;
    const tasks = await ctx.db.task.findMany({
      where: {
        type: { in: ["RESULT_REVIEW", "CRITICAL_RESULT"] },
        status: { in: [...OPEN_TASK] },
        focusType: "DiagnosticReport",
        ...(assignee === "me"
          ? { ownerUserId: me }
          : assignee === "my-pools"
            ? { ownerUserId: null, poolId: { in: poolIds } }
            : assignee === "created-by-me"
              ? { createdById: me }
              : assignee === "all"
                ? {}
                : { OR: [{ ownerUserId: me }, { ownerUserId: null, poolId: { in: poolIds } }] }),
      },
    });
    const reports = await ctx.db.diagnosticReport.findMany({
      where: { id: { in: tasks.map((t) => t.focusId!) } },
      include: { serviceRequest: true },
    });
    const byId = new Map(reports.map((r) => [r.id, r]));
    const rank = (r: DiagnosticReport) => (r.isCritical ? 0 : r.flag === "ABNORMAL" ? 1 : 2);
    const rows = tasks
      .map((t) => ({ t, r: byId.get(t.focusId!) }))
      .filter(
        (
          x,
        ): x is {
          t: (typeof tasks)[number];
          r: DiagnosticReport & { serviceRequest: ServiceRequest | null };
        } => !!x.r,
      )
      .sort(
        (a, b) =>
          rank(a.r) - rank(b.r) || (b.r.issuedAt?.getTime() ?? 0) - (a.r.issuedAt?.getTime() ?? 0),
      );
    const start = ctx.query.cursor ? Number(ctx.query.cursor) : 0;
    const slice = rows.slice(start, start + limit + 1);
    const pts = await summaries(ctx.db, [...new Set(slice.map((x) => x.r.patientId))]);
    const ptById = new Map(pts.map((p) => [p.id, p]));
    const signers = await ctx.db.practitioner.findMany({
      where: {
        userId: {
          in: slice.map((x) => x.r.serviceRequest?.signedById).filter((x): x is string => !!x),
        },
      },
    });
    const signerName = new Map(signers.map((s) => [s.userId!, `Dr. ${s.firstName} ${s.lastName}`]));
    for (const id of ptById.keys()) ctx.audit.patient(id);
    return page(
      slice,
      limit,
      (x) => ({
        report: toDto("DiagnosticReportSummary", reportSummary(x.r)),
        patient: ptById.get(x.r.patientId)!,
        orderingProvider: signerName.get(x.r.serviceRequest?.signedById ?? "") ?? "—",
        critical: x.r.isCritical,
        assignedToMe: x.t.ownerUserId === me,
        taskId: x.t.id,
      }),
      () => String(start + limit),
    );
  },

  async reviewResult(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    const b = ctx.body;
    ctx.checkVersion(dr.version, b.version);
    await reviewOne(ctx, dr, {
      comment: b.comment,
      patientComment: b.patientComment,
      release: b.release,
    });
    if (b.followUp?.detail?.trim()) {
      await createTask(ctx.db, dr.practiceId, {
        type: "GENERAL",
        title: `Follow up on ${dr.display}: ${b.followUp.detail.trim().slice(0, 120)}`,
        description: `Requested when the result was reviewed (${b.followUp.kind}).`,
        patientId: dr.patientId,
        focusType: "DiagnosticReport",
        focusId: dr.id,
        poolKind: "care-team",
        createdById: ctx.staff().userId,
      });
    }
    ctx.audit.suppressDefault();
    return reportDetail(
      ctx.db,
      (await ctx.db.diagnosticReport.findUnique({ where: { id: dr.id } }))!,
    );
  },

  async reviewResultsBulk(ctx) {
    const succeeded: string[] = [];
    const failed: Array<{ id: string; code: string; detail: string }> = [];
    for (const id of [...new Set(ctx.body.ids)]) {
      const dr = await ctx.db.diagnosticReport.findUnique({ where: { id } });
      if (!dr) {
        failed.push({ id, code: "not_found", detail: "Result not found." });
        continue;
      }
      try {
        await requirePatient(ctx, dr.patientId);
        // Critical and abnormal results are reviewed one at a time.
        if (dr.isCritical || dr.flag === "ABNORMAL")
          throw unprocessable(
            "review_individually",
            "Open abnormal and critical results to review them one at a time.",
          );
        await reviewOne(ctx, dr, { comment: ctx.body.comment, release: ctx.body.release });
        succeeded.push(id);
      } catch (e) {
        const p = e as { code?: string; detail?: string; message?: string };
        failed.push({
          id,
          code: p.code ?? "failed",
          detail: p.detail ?? p.message ?? "Couldn't review.",
        });
      }
    }
    ctx.audit.suppressDefault();
    return { succeeded, failed };
  },

  async recordCriticalContact(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    const b = ctx.body;
    if (b.diagnosticReportId && b.diagnosticReportId !== dr.id)
      throw unprocessable("validation_failed", "This contact is for a different result.");
    if (!dr.isCritical)
      throw conflict("not_critical", "Only critical results need a documented contact.");
    const contactedAt = new Date(b.contactedAt);
    if (contactedAt.getTime() > Date.now() + 5 * 60_000)
      throw unprocessable("validation_failed", "The contact time can't be in the future.", {
        errors: [{ field: "contactedAt", code: "future", message: "Use when the call happened." }],
      });
    if (b.reached && !b.spokeWith?.trim())
      throw unprocessable("validation_failed", "Say who you spoke with.", {
        errors: [{ field: "spokeWith", code: "required", message: "Who did you reach?" }],
      });
    const contact = await ctx.db.criticalResultContact.create({
      data: {
        practiceId: dr.practiceId,
        diagnosticReportId: dr.id,
        reached: b.reached,
        spokeWith: b.spokeWith ?? null,
        method: b.method,
        contactedAt,
        instructions: b.instructions ?? null,
        readBack: b.readBack ?? false,
        recordedById: ctx.staff().userId,
      },
    });
    ctx.audit.detail({ reached: b.reached, method: b.method });
    return toDto("CriticalResultContact", contact);
  },

  async releaseResultToPatient(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    const b = ctx.body;
    if (b.release && dr.status === "PRELIMINARY")
      throw conflict("result_not_final", "Release the result when the final result arrives.");
    await ctx.db.diagnosticReport.update({
      where: { id: dr.id },
      data: b.release
        ? {
            releasedToPortalAt: dr.releasedToPortalAt ?? new Date(),
            releaseDelayReason: null,
            ...(b.patientComment !== undefined ? { reviewComment: b.patientComment || null } : {}),
            version: { increment: 1 },
          }
        : {
            releasedToPortalAt: null,
            releaseDelayReason: b.patientComment?.trim() || "Held for discussion with the patient",
            version: { increment: 1 },
          },
    });
    ctx.audit.detail({ release: b.release });
    return reportDetail(
      ctx.db,
      (await ctx.db.diagnosticReport.findUnique({ where: { id: dr.id } }))!,
    );
  },

  async acknowledgeCorrection(ctx) {
    const dr = await loadReport(ctx, ctx.params.diagnosticReportId);
    if (dr.status !== "CORRECTED" || dr.correctionAcknowledgedAt)
      throw conflict("no_correction", "There's no correction waiting on this result.");
    await ctx.db.diagnosticReport.update({
      where: { id: dr.id },
      data: { correctionAcknowledgedAt: new Date(), version: { increment: 1 } },
    });
    if (!dr.isCritical)
      await completeTasksFor(
        ctx.db,
        "DiagnosticReport",
        dr.id,
        ["RESULT_REVIEW"],
        ctx.staff().userId,
      );
    return reportDetail(
      ctx.db,
      (await ctx.db.diagnosticReport.findUnique({ where: { id: dr.id } }))!,
    );
  },

  // ---------- reconciliation queue (INV-SAFE-03) ----------

  async listInboundResults(ctx) {
    const limit = limitOf(ctx.query);
    const rows = await ctx.db.inboundResult.findMany({
      where: { matchStatus: (ctx.query.matchStatus as never) ?? "UNMATCHED" },
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(ctx.query.cursor ? { cursor: { id: ctx.query.cursor }, skip: 1 } : {}),
    });
    ctx.audit.detail({ rows: Math.min(rows.length, limit) });
    return page(
      rows,
      limit,
      (r) => toDto("InboundResult", r),
      (r) => r.id,
    );
  },

  async getInboundResult(ctx) {
    const r = await ctx.db.inboundResult.findUnique({ where: { id: ctx.params.inboundResultId } });
    if (!r) throw notFound();
    ctx.audit.resource("InboundResult", r.id);
    const cands = ((r.candidates as { items?: unknown[] } | null)?.items ?? []) as Array<{
      patientId: string;
      serviceRequestId: string | null;
      score: number;
    }>;
    const pts = await summaries(
      ctx.db,
      cands.map((c) => c.patientId),
    );
    const ptById = new Map(pts.map((p) => [p.id, p]));
    const { oru, order } = await storedOrder(
      ctx.db,
      r.interfaceMessageId,
      r.placerOrderNumber,
      r.accessionNumber,
    );
    const preview = [
      `${oru.patient.lastName}, ${oru.patient.firstName} · DOB ${oru.patient.birthDate ?? "?"} · MRN at lab ${oru.patient.mrn || "—"}`,
      `${order.display} (${order.testCode}) · order ${order.placerOrderNumber || "—"} · accession ${order.fillerOrderNumber || "—"}`,
      ...order.observations.map((o) =>
        `${o.display}: ${o.value} ${o.unit}${o.abnormalFlag && o.abnormalFlag !== "N" ? ` [${o.abnormalFlag}]` : ""}`.trim(),
      ),
    ].join("\n");
    return toDto("InboundResultDetail", {
      ...r,
      candidateMatches: cands
        .filter((c) => ptById.has(c.patientId))
        .map((c) => ({
          patient: ptById.get(c.patientId)!,
          score: c.score,
          ...(c.serviceRequestId ? { orderId: c.serviceRequestId } : {}),
        })),
      rawPreview: preview,
    });
  },

  async matchInboundResult(ctx) {
    const r = await ctx.db.inboundResult.findUnique({ where: { id: ctx.params.inboundResultId } });
    if (!r) throw notFound();
    if (r.matchStatus !== "UNMATCHED")
      throw conflict("already_decided", "This result was already matched or rejected.");
    const b = ctx.body;
    if (!b.reason?.trim())
      throw unprocessable("validation_failed", "Say how you confirmed the patient.", {
        errors: [{ field: "reason", code: "required", message: "Enter how you confirmed it." }],
      });
    const patient = await requirePatient(ctx, b.patientId);
    let sr: ServiceRequest | null = null;
    if (b.serviceRequestId) {
      sr = await ctx.db.serviceRequest.findUnique({ where: { id: b.serviceRequestId } });
      if (!sr || sr.patientId !== patient.id)
        throw unprocessable("validation_failed", "That order isn't for this patient.");
      if (
        !["SENT", "COLLECTED", "RESULTED_PRELIM", "RESULTED_FINAL", "REVIEWED"].includes(sr.status)
      )
        throw conflict("invalid_transition", "That order can't take a result.");
    }
    const { order, oru } = await storedOrder(
      ctx.db,
      r.interfaceMessageId,
      r.placerOrderNumber,
      r.accessionNumber,
    );
    const dr = await fileReport(ctx.db, {
      sr,
      patient: await ctx.db.patient.findUniqueOrThrow({ where: { id: patient.id } }),
      order,
      lab: oru.sendingLab,
      filedById: ctx.staff().userId,
    });
    await ctx.db.inboundResult.update({
      where: { id: r.id },
      data: {
        matchStatus: "MANUALLY_MATCHED",
        matchedPatientId: patient.id,
        matchedServiceRequestId: sr?.id ?? null,
        diagnosticReportId: dr.id,
        decidedById: ctx.staff().userId,
        decidedAt: new Date(),
      },
    });
    await completeTasksFor(ctx.db, "InboundResult", r.id, ["UNMATCHED_RESULT"], ctx.staff().userId);
    ctx.audit.patient(patient.id);
    ctx.audit.resource("InboundResult", r.id);
    ctx.audit.detail({
      reason: b.reason.trim(),
      serviceRequestId: sr?.id ?? null,
      diagnosticReportId: dr.id,
    });
    return reportDetail(ctx.db, dr);
  },

  async rejectInboundResult(ctx) {
    const r = await ctx.db.inboundResult.findUnique({ where: { id: ctx.params.inboundResultId } });
    if (!r) throw notFound();
    if (r.matchStatus !== "UNMATCHED")
      throw conflict("already_decided", "This result was already matched or rejected.");
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw unprocessable("validation_failed", "Say why the result is rejected.", {
        errors: [{ field: "reason", code: "required", message: "Enter a reason." }],
      });
    const updated = await ctx.db.inboundResult.update({
      where: { id: r.id },
      data: { matchStatus: "REJECTED", decidedById: ctx.staff().userId, decidedAt: new Date() },
    });
    await completeTasksFor(ctx.db, "InboundResult", r.id, ["UNMATCHED_RESULT"], ctx.staff().userId);
    // The lab is told by phone/portal until a vendor interface supports rejection messages (no vendor yet).
    ctx.audit.resource("InboundResult", r.id);
    ctx.audit.detail({ reason });
    return toDto("InboundResult", updated);
  },
};
