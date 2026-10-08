import type {
  DiagnosticReport,
  IntegrationKind,
  Observation,
  Patient,
  Prisma,
  ResultFlag,
  ServiceRequest,
  Tx,
} from "../../db.js";
import { putFile, readFileContent } from "../../gateways/fileStore.js";
import { fakeLab, Hl7Error, parseOru, type Oru, type OruOrder } from "../../gateways/lab/index.js";
import { connectionFor } from "../../platform/integrations.js";
import { notifyRole, notifyUsers } from "../../platform/notify.js";
import { findTransition, toEnum } from "../../platform/stateMachine.js";
import { createTask } from "../../platform/tasks.js";
import { writeAuditEntries } from "../../platform/audit.js";
import { writeVersion } from "../../platform/versioning.js";
import { orderStateId } from "../orders/views.js";

/**
 * Result ingestion (flow:results/03). An ORU is stored verbatim (encrypted) before anything else, then each OBR is
 * filed only when it matches exactly one order AND the message's patient agrees with that order's patient on last
 * name and date of birth. Anything else becomes an InboundResult in orders.result-reconciliation with an
 * UNMATCHED_RESULT work item, and nothing reaches a chart (INV-SAFE-03). Critical values create an escalating
 * CRITICAL_RESULT task for the ordering provider (INV-SAFE-04).
 */

export const CRITICAL_RESPONSE_MINUTES = 60;

const SYSTEM = (practiceId: string) => ({
  practiceId,
  actorType: "system" as const,
  actorId: null,
  actorRole: null,
  sessionId: null,
  ip: null,
  userAgent: "lab-interface",
});

export function flagOf(hl7Flag: string): ResultFlag {
  const f = hl7Flag.toUpperCase();
  if (["HH", "LL", "AA", ">", "<"].includes(f) || f.startsWith("C")) return "CRITICAL";
  if (["H", "L", "A", "U", "D"].includes(f)) return "ABNORMAL";
  return "NORMAL";
}

const worst = (flags: ResultFlag[]): ResultFlag =>
  flags.includes("CRITICAL") ? "CRITICAL" : flags.includes("ABNORMAL") ? "ABNORMAL" : "NORMAL";

function parseRange(text: string): { low: string | null; high: string | null } {
  const between = /^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (between) return { low: between[1]!, high: between[2]! };
  const lt = /^\s*<=?\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (lt) return { low: null, high: lt[1]! };
  const gt = /^\s*>=?\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (gt) return { low: gt[1]!, high: null };
  return { low: null, high: null };
}

const reportStatus = (s: string): DiagnosticReport["status"] =>
  s === "P" ? "PRELIMINARY" : s === "C" ? "CORRECTED" : s === "X" ? "CANCELLED" : "FINAL";

const sameName = (a: string, b: string) =>
  a
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "") ===
  b
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** True when the message's patient is the order's patient (INV-SAFE-03: never file on the order number alone). */
export function demographicsAgree(msg: Oru["patient"], p: Patient) {
  return (
    !!msg.birthDate && msg.birthDate === isoDay(p.birthDate) && sameName(msg.lastName, p.lastName)
  );
}

const FILEABLE_FROM = ["SENT", "COLLECTED", "RESULTED_PRELIM", "RESULTED_FINAL", "REVIEWED"];

/** Candidate patients for a result the system couldn't file, best first. */
async function candidatesFor(tx: Tx, oru: Oru, sr: ServiceRequest | null) {
  const out = new Map<
    string,
    { patientId: string; serviceRequestId: string | null; score: number }
  >();
  const add = (patientId: string, serviceRequestId: string | null, score: number) => {
    const prev = out.get(patientId);
    if (!prev || prev.score < score) out.set(patientId, { patientId, serviceRequestId, score });
  };
  if (sr) add(sr.patientId, sr.id, 0.5);
  const or: Prisma.PatientWhereInput[] = [];
  if (oru.patient.mrn) or.push({ mrn: oru.patient.mrn });
  if (oru.patient.birthDate) or.push({ birthDate: new Date(`${oru.patient.birthDate}T00:00:00Z`) });
  if (or.length) {
    const pts = await tx.patient.findMany({ where: { OR: or, mergedIntoId: null }, take: 20 });
    for (const p of pts) {
      let score = 0;
      if (oru.patient.birthDate === isoDay(p.birthDate)) score += 0.4;
      if (sameName(oru.patient.lastName, p.lastName)) score += 0.3;
      if (sameName(oru.patient.firstName, p.firstName)) score += 0.2;
      if (oru.patient.mrn && oru.patient.mrn === p.mrn) score += 0.1;
      if (score >= 0.4)
        add(p.id, sr?.patientId === p.id ? sr.id : null, Math.round(score * 100) / 100);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

export interface IngestOutcome {
  messageId: string;
  duplicate: boolean;
  filed: string[];
  unmatched: string[];
  error?: string;
}

/** Entry point for the lab webhook and the simulated lab. Idempotent per message control id. */
export async function ingestLabMessage(
  tx: Tx,
  practiceId: string,
  kind: IntegrationKind,
  raw: string,
  idempotencyKey?: string,
): Promise<IngestOutcome> {
  const conn = await connectionFor(tx, practiceId, kind);
  let oru: Oru | null = null;
  let parseError: string | null = null;
  try {
    oru = parseOru(raw);
  } catch (e) {
    parseError = e instanceof Hl7Error ? e.message : "Unreadable HL7 message.";
  }
  const key = `oru:${kind}:${oru?.messageControlId || idempotencyKey || Buffer.from(raw).toString("base64url").slice(0, 60)}`;
  const prior = await tx.interfaceMessage.findUnique({ where: { idempotencyKey: key } });
  if (prior && prior.status === "ACKNOWLEDGED")
    return { messageId: prior.id, duplicate: true, filed: [], unmatched: [] };

  const file = await putFile(tx, {
    practiceId,
    kind: "lab",
    fileName: `${key.replace(/[^\w.-]/g, "_")}.hl7`,
    contentType: "x-application/hl7-v2+er7",
    data: Buffer.from(raw, "utf8"),
  });
  const msg = prior
    ? await tx.interfaceMessage.update({
        where: { id: prior.id },
        data: { attempts: { increment: 1 }, payloadFileId: file.id, status: "SENDING" },
      })
    : await tx.interfaceMessage.create({
        data: {
          practiceId,
          connectionId: conn.id,
          direction: "INBOUND",
          messageType: "ORU^R01",
          idempotencyKey: key,
          status: "SENDING",
          attempts: 1,
          payloadFileId: file.id,
        },
      });

  if (!oru) {
    await tx.interfaceMessage.update({
      where: { id: msg.id },
      data: { status: "FAILED", error: parseError!.slice(0, 200) },
    });
    await createTask(tx, practiceId, {
      type: "INTERFACE_FAILURE",
      title: `Unreadable result message from ${conn.displayName}`,
      description: `${parseError} The message is kept on the interface monitor.`,
      focusType: "InterfaceMessage",
      focusId: msg.id,
      poolKind: "care-team",
      priority: "HIGH",
    });
    return { messageId: msg.id, duplicate: false, filed: [], unmatched: [], error: parseError! };
  }

  const filed: string[] = [];
  const unmatched: string[] = [];
  for (const order of oru.orders) {
    const sr = order.placerOrderNumber
      ? await tx.serviceRequest.findUnique({
          where: { placerOrderNumber: order.placerOrderNumber },
          include: { patient: true },
        })
      : null;
    const fileable =
      sr &&
      !sr.patient.mergedIntoId &&
      FILEABLE_FROM.includes(sr.status) &&
      demographicsAgree(oru.patient, sr.patient) &&
      (sr.status !== "REVIEWED" || order.resultStatus === "C");
    if (fileable) {
      const dr = await fileReport(tx, { sr, patient: sr.patient, order, lab: oru.sendingLab });
      filed.push(dr.id);
      continue;
    }
    const candidates = await candidatesFor(tx, oru, sr);
    const inbound = await tx.inboundResult.create({
      data: {
        practiceId,
        interfaceMessageId: msg.id,
        lab: oru.sendingLab,
        accessionNumber: order.fillerOrderNumber || null,
        placerOrderNumber: order.placerOrderNumber || null,
        demographics: {
          ...oru.patient,
          test: order.display,
          testCode: order.testCode,
        } as Prisma.InputJsonValue,
        candidates: { items: candidates } as unknown as Prisma.InputJsonValue,
        matchStatus: "UNMATCHED",
      },
    });
    await createTask(tx, practiceId, {
      type: "UNMATCHED_RESULT",
      title: `Unmatched result: ${order.display}`,
      description: sr
        ? "The order number matched, but the patient in the message doesn't match the order's patient."
        : "No order matches this result. Find the patient and order, or reject it back to the lab.",
      focusType: "InboundResult",
      focusId: inbound.id,
      poolKind: "care-team",
      priority: order.observations.some((o) => flagOf(o.abnormalFlag) === "CRITICAL")
        ? "URGENT"
        : "HIGH",
    });
    unmatched.push(inbound.id);
  }
  await tx.interfaceMessage.update({
    where: { id: msg.id },
    data: {
      status: "ACKNOWLEDGED",
      completedAt: new Date(),
      vendorRef: oru.messageControlId || null,
      error: null,
    },
  });
  await tx.integrationConnection.update({
    where: { id: conn.id },
    data: { lastSuccessAt: new Date() },
  });
  return { messageId: msg.id, duplicate: false, filed, unmatched };
}

/** Re-reads an unmatched result's stored message (the payload is the source of truth, not a copy). */
export async function storedOrder(
  tx: Tx,
  interfaceMessageId: string,
  placer: string | null,
  filler: string | null,
) {
  const msg = await tx.interfaceMessage.findUniqueOrThrow({ where: { id: interfaceMessageId } });
  const file = msg.payloadFileId
    ? await tx.fileObject.findUnique({ where: { id: msg.payloadFileId } })
    : null;
  if (!file) throw new Error("result payload missing");
  const oru = parseOru((await readFileContent(file)).toString("utf8"));
  const order =
    oru.orders.find(
      (o) =>
        (placer && o.placerOrderNumber === placer) || (filler && o.fillerOrderNumber === filler),
    ) ?? oru.orders[0]!;
  return { oru, order };
}

/**
 * Files one OBR as a DiagnosticReport with Observations. Re-sent preliminary/final/corrected results update the
 * same report in place; the replaced values are kept in resource history.
 */
export async function fileReport(
  tx: Tx,
  input: {
    sr: ServiceRequest | null;
    patient: Patient;
    order: OruOrder;
    lab: string;
    filedById?: string | null;
  },
): Promise<DiagnosticReport> {
  const { sr, patient, order } = input;
  const practiceId = patient.practiceId;
  const loinc = order.loincCode || order.testCode;
  const status = reportStatus(order.resultStatus);
  const flags = order.observations.map((o) => flagOf(o.abnormalFlag));
  const flag = worst(flags);
  const issuedAt = order.resultedAt ?? new Date();

  const existing = await tx.diagnosticReport.findFirst({
    where: sr
      ? { serviceRequestId: sr.id, loincCode: loinc }
      : {
          patientId: patient.id,
          accessionNumber: order.fillerOrderNumber || "—",
          loincCode: loinc,
        },
  });
  const corrected = status === "CORRECTED" && !!existing;
  const reportData = {
    status,
    display: order.display || sr?.display || loinc,
    effectiveAt: order.observedAt ?? sr?.collectedAt ?? null,
    issuedAt,
    performerLab: input.lab || sr?.performerLab || null,
    accessionNumber: order.fillerOrderNumber || sr?.accessionNumber || null,
    conclusion: order.comments.join("\n") || null,
    flag,
    isCritical: flag === "CRITICAL",
  };
  let dr: DiagnosticReport;
  if (existing) {
    dr = await tx.diagnosticReport.update({
      where: { id: existing.id },
      data: {
        ...reportData,
        ...(corrected ? { correctionAcknowledgedAt: null } : {}),
        version: { increment: 1 },
      },
    });
  } else {
    dr = await tx.diagnosticReport.create({
      data: {
        practiceId,
        patientId: patient.id,
        serviceRequestId: sr?.id ?? null,
        category: "LAB",
        loincCode: loinc,
        ...reportData,
        securityLabels: [],
      },
    });
  }

  const reason = corrected ? "corrected result received" : `result ${order.resultStatus}`;
  await writeVersion(tx, practiceId, "DiagnosticReport", dr, input.filedById ?? null, reason);

  const current = await tx.observation.findMany({ where: { diagnosticReportId: dr.id } });
  for (const [i, x] of order.observations.entries()) {
    const numeric = x.valueType === "NM" && /^-?\d+(\.\d+)?$/.test(x.value);
    const range = parseRange(x.referenceRange);
    const data = {
      status: (status === "PRELIMINARY"
        ? "PRELIMINARY"
        : status === "CORRECTED"
          ? "CORRECTED"
          : "FINAL") as Observation["status"],
      display: x.display || x.code,
      effectiveAt: x.observedAt ?? order.observedAt ?? issuedAt,
      valueQuantity: numeric ? x.value : null,
      valueUnit: x.unit || null,
      valueString: numeric ? null : x.value || null,
      referenceRangeLow: range.low,
      referenceRangeHigh: range.high,
      referenceRangeText: x.referenceRange || null,
      interpretation: x.abnormalFlag || null,
      flag: flags[i]!,
    };
    const prev = current.find((c) => c.loincCode === x.code);
    if (prev) {
      const row = await tx.observation.update({
        where: { id: prev.id },
        data: { ...data, version: { increment: 1 } },
      });
      await writeVersion(tx, practiceId, "Observation", row, input.filedById ?? null, reason);
    } else {
      const earlier = await tx.observation.findFirst({
        where: { patientId: patient.id, loincCode: x.code, diagnosticReportId: { not: dr.id } },
        orderBy: { effectiveAt: "desc" },
        select: { id: true },
      });
      const row = await tx.observation.create({
        data: {
          practiceId,
          patientId: patient.id,
          encounterId: sr?.encounterId ?? null,
          diagnosticReportId: dr.id,
          category: "LABORATORY",
          loincCode: x.code,
          previousValueId: earlier?.id ?? null,
          stagingStatus: "ACTIVE",
          source: "INTERFACE",
          ...data,
        },
      });
      await writeVersion(tx, practiceId, "Observation", row, input.filedById ?? null, reason);
    }
  }

  if (sr) {
    const to =
      status === "PRELIMINARY"
        ? "resulted-prelim"
        : status === "CANCELLED"
          ? null
          : "resulted-final";
    const fromId = orderStateId(sr.status);
    if (to && fromId !== to && findTransition("order", sr.status, to))
      await tx.serviceRequest.update({
        where: { id: sr.id },
        data: { status: toEnum(to) as ServiceRequest["status"], version: { increment: 1 } },
      });
    if (sr.placerOrderNumber) fakeLab().resulted.add(sr.placerOrderNumber);
  }

  await routeForReview(tx, { dr, sr, patient, corrected });
  await writeAuditEntries(tx, SYSTEM(practiceId), [
    {
      action: existing ? "UPDATE" : "CREATE",
      patientId: patient.id,
      resourceType: "DiagnosticReport",
      resourceId: dr.id,
      operationId: "labWebhook",
      detail: { status, flag, order: sr?.id ?? null },
    },
  ]);
  return dr;
}

/** Who reviews the result: the ordering provider, else the patient's PCP, else the care-team pool. */
async function reviewerFor(
  tx: Tx,
  sr: ServiceRequest | null,
  patient: Patient,
): Promise<string | null> {
  if (sr?.signedById) return sr.signedById;
  if (patient.pcpPractitionerId) {
    const pcp = await tx.practitioner.findUnique({ where: { id: patient.pcpPractitionerId } });
    if (pcp?.userId) return pcp.userId;
  }
  return null;
}

async function routeForReview(
  tx: Tx,
  c: { dr: DiagnosticReport; sr: ServiceRequest | null; patient: Patient; corrected: boolean },
) {
  const { dr, patient } = c;
  const owner = await reviewerFor(tx, c.sr, patient);
  const openTask = (type: "CRITICAL_RESULT" | "RESULT_REVIEW") =>
    tx.task.findFirst({
      where: {
        type,
        focusType: "DiagnosticReport",
        focusId: dr.id,
        status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
      },
    });
  const name = `${patient.lastName}, ${patient.firstName}`;
  if (dr.isCritical) {
    if (!(await openTask("CRITICAL_RESULT"))) {
      await createTask(tx, dr.practiceId, {
        type: "CRITICAL_RESULT",
        title: `Critical result: ${dr.display} for ${name}`,
        description:
          "Contact the patient and record the call before closing (read-back of the value and instructions).",
        patientId: patient.id,
        focusType: "DiagnosticReport",
        focusId: dr.id,
        ownerUserId: owner,
        poolKind: owner ? undefined : "care-team",
        priority: "URGENT",
        dueAt: new Date(Date.now() + CRITICAL_RESPONSE_MINUTES * 60_000),
      });
      const route = `/inbox/results?report=${dr.id}`;
      if (owner)
        await notifyUsers(tx, dr.practiceId, [owner], {
          type: "CRITICAL_RESULT",
          title: `Critical result for ${name}`,
          linkRoute: route,
        });
      else
        await notifyRole(tx, dr.practiceId, "PROVIDER", {
          type: "CRITICAL_RESULT",
          title: `Critical result for ${name}`,
          linkRoute: route,
        });
    }
    return;
  }
  if (dr.status === "PRELIMINARY") return;
  if (dr.reviewedAt && !c.corrected) return;
  if (!(await openTask("RESULT_REVIEW")))
    await createTask(tx, dr.practiceId, {
      type: "RESULT_REVIEW",
      title: `${c.corrected ? "Corrected result" : "Result"}: ${dr.display} for ${name}`,
      patientId: patient.id,
      focusType: "DiagnosticReport",
      focusId: dr.id,
      ownerUserId: owner,
      poolKind: owner ? undefined : "care-team",
      priority: dr.flag === "ABNORMAL" ? "HIGH" : "NORMAL",
    });
}

/**
 * Sweep (INV-SAFE-04): critical-result tasks past due with no successful contact escalate to the care-team pool and
 * managers, and stay open. Returns the number escalated.
 */
export async function escalateCriticalResults(
  tx: Tx,
  practiceId: string,
  now = new Date(),
): Promise<number> {
  const due = await tx.task.findMany({
    where: { type: "CRITICAL_RESULT", status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: now } },
  });
  let n = 0;
  for (const t of due) {
    const reached = await tx.criticalResultContact.findFirst({
      where: { diagnosticReportId: t.focusId!, reached: true },
    });
    if (reached) continue;
    const pool = await tx.workPool.findFirst({ where: { kind: "care-team", active: true } });
    await tx.task.update({
      where: { id: t.id },
      data: {
        status: "ESCALATED",
        escalatedAt: now,
        poolId: pool?.id ?? t.poolId,
        dueAt: new Date(now.getTime() + CRITICAL_RESPONSE_MINUTES * 60_000),
        version: { increment: 1 },
      },
    });
    await notifyRole(tx, practiceId, "MANAGER", {
      type: "TASK_ESCALATED",
      title: `Critical result not yet communicated: ${t.title.replace(/^Critical result: /, "")}`,
      linkRoute: `/inbox/results?report=${t.focusId}`,
    });
    n++;
  }
  return n;
}
