import type { Tx } from "../../db.js";
import { limitOf, page } from "../../platform/dto.js";
import { binary, type Ctx, type HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { renderPdf } from "../../platform/pdf.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor } from "../../platform/tasks.js";
import { dayRange, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { summaries } from "../patients/service.js";
import { aoeQuestionsOf } from "./catalog.js";
import { loadSrRow, srInclude, srViews } from "./views.js";

/**
 * Specimen collection (orders.collection, flow:results/02): the queue of signed in-office lab orders, recording the
 * draw (sent -> collected), and the printed requisition and labels. Labels and requisitions carry full name, DOB
 * and MRN (INV-ID-01).
 */

const TUBE: Record<string, string> = {
  serum: "Gold top (SST)",
  "whole blood": "Lavender top (EDTA)",
  plasma: "Light blue top (citrate)",
  urine: "Urine cup",
  swab: "Swab transport",
};

const tubeFor = (specimen: string | null | undefined) =>
  specimen ? (TUBE[specimen.toLowerCase()] ?? specimen) : undefined;

async function loadForPrint(ctx: Ctx, id: string) {
  const sr = await loadSrRow(ctx.db, id);
  if (!sr) throw notFound();
  const patient = await requirePatient(ctx, sr.patientId);
  if (!sr.placerOrderNumber)
    throw conflict("order_not_signed", "Sign the order before printing its requisition or labels.");
  ctx.audit.resource("ServiceRequest", sr.id);
  ctx.audit.patient(sr.patientId);
  return { sr, patient };
}

async function identityLine(tx: Tx, patientId: string) {
  const p = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
  const name = `${p.lastName}, ${p.firstName}${p.middleName ? ` ${p.middleName}` : ""}`;
  return { p, line: `${name} · DOB ${p.birthDate.toISOString().slice(0, 10)} · MRN ${p.mrn}` };
}

export const collectionHandlers: HandlerMap = {
  async listCollectionQueue(ctx) {
    const tz = await practiceTimeZone(ctx.db);
    const date = ctx.query.date ?? todayLocal(tz);
    const { end } = dayRange(date, tz);
    const limit = limitOf(ctx.query);
    // Signed in-office lab orders whose expected date is on or before the day (fasting draws are morning work).
    const rows = await ctx.db.serviceRequest.findMany({
      where: {
        category: "LAB",
        collectionMode: "IN_OFFICE",
        status: { in: ["SIGNED", "SENT"] },
        signedAt: { lt: end },
        ...(ctx.query.locationId ? { encounter: { locationId: ctx.query.locationId } } : {}),
      },
      include: srInclude,
      orderBy: [{ priority: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(ctx.query.cursor ? { cursor: { id: ctx.query.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    const [views, pts, comps] = await Promise.all([
      srViews(ctx.db, slice),
      summaries(ctx.db, [...new Set(slice.map((r) => r.patientId))]),
      ctx.db.labCompendiumItem.findMany({
        where: {
          id: { in: slice.map((r) => r.labCompendiumItemId).filter((x): x is string => !!x) },
        },
      }),
    ]);
    const ptById = new Map(pts.map((p) => [p.id, p]));
    const compById = new Map(comps.map((c) => [c.id, c]));
    for (const id of new Set(slice.map((r) => r.patientId))) ctx.audit.patient(id);
    return page(
      rows,
      limit,
      (r) => {
        const comp = compById.get(r.labCompendiumItemId ?? "");
        const fastingQ = aoeQuestionsOf(comp ?? null).find((q) => /fast/i.test(q.text));
        const answers = (r.aoeAnswers ?? {}) as Record<string, unknown>;
        return {
          serviceRequest: views[slice.indexOf(r)]!,
          patient: ptById.get(r.patientId)!,
          ...(tubeFor(comp?.specimenType) ? { tube: tubeFor(comp?.specimenType) } : {}),
          ...(fastingQ
            ? { fasting: answers[fastingQ.code] === true || answers[fastingQ.code] === "true" }
            : {}),
          ...(r.signedAt ? { dueAt: r.signedAt.toISOString() } : {}),
        };
      },
      (r) => r.id,
    );
  },

  async recordSpecimenCollection(ctx) {
    const b = ctx.body;
    const ids = [...new Set(b.serviceRequestIds)];
    if (!ids.length)
      throw unprocessable("validation_failed", "Choose the orders this specimen is for.");
    const collectedAt = new Date(b.collectedAt);
    if (collectedAt.getTime() > Date.now() + 5 * 60_000)
      throw unprocessable("validation_failed", "Collection time can't be in the future.", {
        errors: [
          { field: "collectedAt", code: "future", message: "Use the time the sample was drawn." },
        ],
      });
    const rows = await ctx.db.serviceRequest.findMany({
      where: { id: { in: ids } },
      include: srInclude,
    });
    if (rows.length !== ids.length) throw notFound();
    // INV-ID-01: one draw, one patient.
    const patientIds = new Set(rows.map((r) => r.patientId));
    if (patientIds.size !== 1)
      throw conflict(
        "patient_context_mismatch",
        "A specimen can only be recorded for one patient's orders.",
      );
    await requirePatient(ctx, rows[0]!.patientId);
    for (const r of rows) assertTransition("order", r.status, "collected", ctx.staff().role);
    const collector = b.collectorId ?? ctx.staff().userId;
    for (const r of rows) {
      await ctx.db.specimen.create({
        data: {
          practiceId: r.practiceId,
          serviceRequestId: r.id,
          type: b.type,
          containerType: b.container ?? null,
          collectedAt,
          collectedById: collector,
          labelPrinted: b.printLabels,
        },
      });
      await ctx.db.serviceRequest.update({
        where: { id: r.id, version: r.version },
        data: { status: "COLLECTED", collectedAt, version: { increment: 1 } },
      });
      await completeTasksFor(
        ctx.db,
        "ServiceRequest",
        r.id,
        ["SPECIMEN_COLLECTION"],
        ctx.staff().userId,
      );
    }
    ctx.audit.patient(rows[0]!.patientId);
    ctx.audit.detail({ orders: ids, type: b.type });
    const [view] = await srViews(ctx.db, [(await loadSrRow(ctx.db, ids[0]!))!]);
    return view;
  },

  async getRequisition(ctx) {
    const { sr } = await loadForPrint(ctx, ctx.params.serviceRequestId);
    const { line } = await identityLine(ctx.db, sr.patientId);
    const [practice, signer, reasons, comp, coverage] = await Promise.all([
      ctx.db.practice.findFirstOrThrow(),
      sr.signedById ? ctx.db.practitioner.findFirst({ where: { userId: sr.signedById } }) : null,
      ctx.db.serviceRequestReason.findMany({
        where: { serviceRequestId: sr.id },
        include: { condition: true },
      }),
      sr.labCompendiumItemId
        ? ctx.db.labCompendiumItem.findUnique({ where: { id: sr.labCompendiumItemId } })
        : null,
      ctx.db.coverage.findFirst({
        where: { patientId: sr.patientId, status: "active" },
        orderBy: { order: "asc" },
        include: { payer: true },
      }),
    ]);
    const answers = (sr.aoeAnswers ?? {}) as Record<string, unknown>;
    const pdf = await renderPdf(
      {
        title: `Lab requisition · ${sr.placerOrderNumber}`,
        patientLine: line,
        practiceName: practice.legalName,
      },
      (w) => {
        w.heading(sr.display);
        w.keyValue([
          ["Order number", sr.placerOrderNumber!],
          ["Performing lab", sr.performerLab ?? "—"],
          ["Test code", comp?.testCode ?? sr.code],
          ["Priority", sr.priority.toLowerCase()],
          ["Specimen", comp?.specimenType ?? "—"],
          ["Signed", sr.signedAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"],
          [
            "Ordering provider",
            signer
              ? `${signer.firstName} ${signer.lastName}${signer.npi ? ` · NPI ${signer.npi}` : ""}`
              : "—",
          ],
          [
            "Insurance",
            coverage ? `${coverage.payer.name} · member ${coverage.memberId}` : "Self-pay",
          ],
        ]);
        w.subheading("Diagnoses");
        w.list(reasons.map((r) => `${r.condition.icd10Code ?? ""} ${r.condition.display}`.trim()));
        const aoe = aoeQuestionsOf(comp).filter((q) => answers[q.code] !== undefined);
        if (aoe.length) {
          w.subheading("Questions at order entry");
          w.keyValue(aoe.map((q) => [q.text, String(answers[q.code])]));
        }
        if (sr.abnRequired)
          w.muted("ABN required: the patient's signed ABN is attached to the order.");
      },
    );
    return binary("application/pdf", pdf, `requisition-${sr.placerOrderNumber}.pdf`);
  },

  async getSpecimenLabels(ctx) {
    const { sr } = await loadForPrint(ctx, ctx.params.serviceRequestId);
    const { p, line } = await identityLine(ctx.db, sr.patientId);
    const practice = await ctx.db.practice.findFirstOrThrow();
    const specimen = sr.specimens[0];
    const pdf = await renderPdf(
      {
        title: `Specimen labels · ${sr.placerOrderNumber}`,
        patientLine: line,
        practiceName: practice.legalName,
      },
      (w) => {
        for (let i = 0; i < 2; i++) {
          w.heading(`${p.lastName}, ${p.firstName}`);
          w.keyValue([
            ["DOB", p.birthDate.toISOString().slice(0, 10)],
            ["MRN", p.mrn],
            ["Order", sr.placerOrderNumber!],
            ["Test", sr.display],
            [
              "Collected",
              specimen
                ? specimen.collectedAt.toISOString().slice(0, 16).replace("T", " ")
                : "________",
            ],
          ]);
          w.spacer();
        }
      },
    );
    if (specimen && !specimen.labelPrinted)
      await ctx.db.specimen.update({ where: { id: specimen.id }, data: { labelPrinted: true } });
    return binary("application/pdf", pdf, `labels-${sr.placerOrderNumber}.pdf`);
  },
};
