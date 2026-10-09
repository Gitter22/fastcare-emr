import type { RxCheckResult } from "@agile-emr/shared";
import type { MedicationRequest, MedicationRequestStatus, Prisma } from "../../db.js";
import { erxGateway } from "../../gateways/erx/index.js";
import { readFileContent, putFile } from "../../gateways/fileStore.js";
import { type PdmpDispensation, pdmpGateway } from "../../gateways/pdmp/index.js";
import { isControlledConcept } from "../../gateways/referenceData/index.js";
import { limitOf, page, toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { binary } from "../../platform/http/context.js";
import { recordCall } from "../../platform/integrations.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { renderPdf } from "../../platform/pdf.js";
import {
  conflict,
  integrationUnavailable,
  notFound,
  unprocessable,
  validationFailed,
} from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor } from "../../platform/tasks.js";
import { writeVersion } from "../../platform/versioning.js";
import { loadEncounter } from "../encounters/access.js";
import { recordFindings, durFindings, keyOf } from "./dur.js";
import { sendCancel, sendPrescription } from "./erx.js";
import { resolveConcept, signDrafts } from "./sign.js";

/**
 * Prescribing (encounter.rx, flow:encounter/05). Drafts are created by an MA (pended) or provider and signed only by
 * a prescriber (INV-SAFE-01). Every status change goes through assertTransition("prescription", ...). Signing
 * compares the patient on screen with the prescription's patient (INV-ID-03); DUR, PDMP and EPCS rules are in
 * sign.ts. An unsigned prescription blocks note signing (INV-SAFE-08, notes/service.ts pre-flight).
 */

const CLOSED_ENCOUNTER = ["FINISHED", "CANCELLED", "ENTERED_IN_ERROR"];

export async function loadRx(ctx: Ctx, id: string): Promise<MedicationRequest> {
  const rx = await ctx.db.medicationRequest.findUnique({ where: { id } });
  if (!rx) throw notFound();
  await requirePatient(ctx, rx.patientId);
  ctx.audit.resource("MedicationRequest", rx.id);
  ctx.audit.patient(rx.patientId);
  return rx;
}

const rxDto = (rx: MedicationRequest) => toDto("MedicationRequest", rx);

function requireDraft(rx: MedicationRequest) {
  if (rx.status !== "DRAFT")
    throw conflict(
      "prescription_signed",
      "A signed prescription can't be edited. Cancel it and prescribe again.",
    );
}

function checkFields(b: {
  sigText?: string | null;
  quantity?: string | null;
  quantityUnit?: string | null;
  refills?: number | null;
  daysSupply?: number | null;
}) {
  const errors = [];
  if (b.sigText !== undefined && !b.sigText?.trim())
    errors.push({ field: "sigText", code: "required", message: "Enter patient instructions." });
  if (b.quantity !== undefined && !(Number(b.quantity) > 0))
    errors.push({ field: "quantity", code: "invalid", message: "Enter a quantity above zero." });
  if (b.quantityUnit !== undefined && !b.quantityUnit?.trim())
    errors.push({ field: "quantityUnit", code: "required", message: "Enter the unit." });
  if (b.refills !== undefined && b.refills !== null && (b.refills < 0 || b.refills > 11))
    errors.push({ field: "refills", code: "invalid", message: "Refills must be 0 to 11." });
  if (
    b.daysSupply !== undefined &&
    b.daysSupply !== null &&
    (b.daysSupply < 1 || b.daysSupply > 365)
  )
    errors.push({ field: "daysSupply", code: "invalid", message: "Days supply must be 1 to 365." });
  if (errors.length) throw validationFailed(errors);
}

async function checkReason(ctx: Ctx, patientId: string, id: string | null | undefined) {
  if (!id) return;
  const ok = await ctx.db.condition.count({ where: { id, patientId, stagingStatus: "ACTIVE" } });
  if (!ok)
    throw validationFailed([
      {
        field: "reasonConditionId",
        code: "invalid",
        message: "Choose one of this patient's diagnoses.",
      },
    ]);
}

async function checkPrescriber(ctx: Ctx, id: string) {
  const p = await ctx.db.practitioner.findUnique({ where: { id } });
  if (!p || !p.active)
    throw validationFailed([
      { field: "prescriberId", code: "invalid", message: "Choose a prescriber." },
    ]);
}

async function checkPharmacy(ctx: Ctx, id: string | null | undefined) {
  if (!id) return;
  if (!(await ctx.db.pharmacy.findUnique({ where: { id } })))
    throw validationFailed([
      { field: "pharmacyId", code: "invalid", message: "Choose a pharmacy." },
    ]);
}

async function payerNameFor(ctx: Ctx, patientId: string): Promise<string | null> {
  const cov = await ctx.db.coverage.findFirst({
    where: { patientId, status: "active" },
    orderBy: { order: "asc" },
    include: { payer: true },
  });
  return cov?.payer?.name ?? null;
}

/** Controlled dispensations the simulated network knows (signed and sent here), last 12 months. */
async function knownDispensations(ctx: Ctx, patientId: string): Promise<PdmpDispensation[]> {
  const rows = await ctx.db.medicationRequest.findMany({
    where: {
      patientId,
      isControlled: true,
      status: { in: ["ACTIVE", "COMPLETED"] },
      erxStatus: { in: ["SENT", "ACCEPTED"] },
      signedAt: { gte: new Date(Date.now() - 365 * 86_400_000) },
    },
    include: { pharmacy: true },
    orderBy: { signedAt: "desc" },
  });
  const prescribers = await ctx.db.practitioner.findMany({
    where: { id: { in: rows.map((r) => r.prescriberId) } },
  });
  return rows.map((r) => {
    const p = prescribers.find((x) => x.id === r.prescriberId);
    return {
      drug: r.display,
      deaSchedule: r.deaSchedule ?? "",
      filledAt: (r.signedAt ?? r.createdAt).toISOString().slice(0, 10),
      quantity: Number(r.quantity),
      daysSupply: r.daysSupply,
      prescriber: p ? `${p.firstName} ${p.lastName}${p.credential ? `, ${p.credential}` : ""}` : "",
      pharmacy: r.pharmacy?.name ?? "",
    };
  });
}

export const prescribingHandlers: HandlerMap = {
  async listEncounterPrescriptions(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const rows = await ctx.db.medicationRequest.findMany({
      where: { encounterId: enc.id, status: { not: "ENTERED_IN_ERROR" } },
      orderBy: { createdAt: "asc" },
    });
    ctx.audit.patient(enc.patientId);
    return toDtos("MedicationRequest", rows);
  },

  async listPatientPrescriptions(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(ctx.query);
    const status = ctx.query.status as string | string[] | undefined;
    const rows = await ctx.db.medicationRequest.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...(status
          ? { status: { in: ([] as string[]).concat(status) as MedicationRequestStatus[] } }
          : {}),
        ...(ctx.query.cursor ? { createdAt: { lt: new Date(ctx.query.cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    ctx.audit.patient(ctx.params.patientId);
    return page(rows, limit, rxDto, (r) => r.createdAt.toISOString());
  },

  async createPrescription(ctx) {
    const b = ctx.body;
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    if (CLOSED_ENCOUNTER.includes(enc.status))
      throw conflict("encounter_closed", "This visit is closed. Prescribe from a new encounter.");
    if (b.patientId !== enc.patientId)
      throw conflict(
        "patient_context_mismatch",
        "The patient on screen isn't this visit's patient. Reopen the visit from the right chart.",
      );
    assertTransition("prescription", null, "draft", ctx.staff().role);
    checkFields(b);
    await checkPrescriber(ctx, b.prescriberId);
    await checkReason(ctx, enc.patientId, b.reasonConditionId);
    await checkPharmacy(ctx, b.pharmacyId);
    const concept = await resolveConcept(b.rxnormCode, ctx);
    const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: enc.patientId } });
    const controlled = isControlledConcept(concept);
    const rx = await ctx.db.medicationRequest.create({
      data: {
        practiceId: ctx.staff().practiceId,
        patientId: enc.patientId,
        encounterId: enc.id,
        prescriberId: b.prescriberId,
        rxnormCode: concept.rxcui,
        ndc: b.ndc ?? null,
        display: concept.name,
        isControlled: controlled,
        deaSchedule: controlled ? (concept.deaSchedule ?? "unverified") : null,
        doseQuantity: b.doseQuantity ?? null,
        doseUnit: b.doseUnit ?? null,
        route: b.route ?? null,
        frequency: b.frequency ?? null,
        durationDays: b.durationDays ?? null,
        sigText: b.sigText.trim(),
        quantity: b.quantity,
        quantityUnit: b.quantityUnit,
        refills: b.refills ?? 0,
        daysSupply: b.daysSupply ?? null,
        substitutionAllowed: b.substitutionAllowed ?? true,
        noteToPharmacist: b.noteToPharmacist ?? null,
        reasonConditionId: b.reasonConditionId ?? null,
        pharmacyId: b.pharmacyId ?? patient.preferredPharmacyId ?? null,
        intent: b.intent ?? "order",
        priorPrescriptionId: b.priorPrescriptionId ?? null,
        pdmpExceptionReason: b.pdmpExceptionReason?.trim() || null,
        pendedById: ctx.staff().role === "ma" ? ctx.staff().userId : null,
      },
    });
    await writeVersion(ctx.db, rx.practiceId, "MedicationRequest", rx, ctx.staff().userId);
    ctx.audit.patient(rx.patientId);
    ctx.audit.resource("MedicationRequest", rx.id);
    return rxDto(rx);
  },

  async updatePrescription(ctx) {
    const rx = await loadRx(ctx, ctx.params.medicationRequestId);
    ctx.checkVersion(rx.version, ctx.ifMatch());
    requireDraft(rx);
    const b = ctx.body;
    checkFields(b);
    if (b.prescriberId) await checkPrescriber(ctx, b.prescriberId);
    if (b.reasonConditionId !== undefined)
      await checkReason(ctx, rx.patientId, b.reasonConditionId);
    if (b.pharmacyId !== undefined) await checkPharmacy(ctx, b.pharmacyId);
    let drug: Prisma.MedicationRequestUpdateInput = {};
    if (b.rxnormCode && b.rxnormCode !== rx.rxnormCode) {
      const concept = await resolveConcept(b.rxnormCode, ctx);
      const controlled = isControlledConcept(concept);
      drug = {
        rxnormCode: concept.rxcui,
        display: concept.name,
        isControlled: controlled,
        deaSchedule: controlled ? (concept.deaSchedule ?? "unverified") : null,
        ndc: b.ndc ?? null,
        formularyStatus: undefined,
      };
    }
    const pick = <K extends keyof typeof b>(k: K) => (b[k] !== undefined ? { [k]: b[k] } : {});
    const updated = await ctx.db.medicationRequest.update({
      where: { id: rx.id, version: rx.version },
      data: {
        ...drug,
        ...pick("prescriberId"),
        ...pick("doseQuantity"),
        ...pick("doseUnit"),
        ...pick("route"),
        ...pick("frequency"),
        ...pick("durationDays"),
        ...(b.sigText !== undefined ? { sigText: b.sigText.trim() } : {}),
        ...pick("quantity"),
        ...pick("quantityUnit"),
        ...pick("refills"),
        ...pick("daysSupply"),
        ...pick("substitutionAllowed"),
        ...pick("noteToPharmacist"),
        ...pick("reasonConditionId"),
        ...pick("pharmacyId"),
        ...(b.pdmpExceptionReason !== undefined
          ? { pdmpExceptionReason: b.pdmpExceptionReason?.trim() || null }
          : {}),
        version: { increment: 1 },
      } as Prisma.MedicationRequestUpdateInput,
    });
    await writeVersion(
      ctx.db,
      updated.practiceId,
      "MedicationRequest",
      updated,
      ctx.staff().userId,
    );
    return rxDto(updated);
  },

  async checkPrescription(ctx) {
    const rx = await loadRx(ctx, ctx.params.medicationRequestId);
    requireDraft(rx);
    const concept = await resolveConcept(rx.rxnormCode, ctx);
    const controlled = isControlledConcept(concept);
    const alerts = await recordFindings(ctx.db, rx, await durFindings(ctx.db, rx, concept));

    // Formulary / real-time benefit through the e-prescribing network.
    const gw = erxGateway();
    let formulary = null;
    let formularyUnavailable: string | null = null;
    if (!gw) formularyUnavailable = "E-prescribing isn't connected, so coverage can't be checked.";
    else
      try {
        formulary = await gw.formulary({
          rxcui: concept.rxcui,
          ingredientNames: concept.ingredientNames,
          tty: concept.tty,
          payerName: await payerNameFor(ctx, rx.patientId),
        });
      } catch {
        formularyUnavailable = "The coverage check isn't responding. You can still prescribe.";
      }
    // Server-derived fields only; the client's version is not bumped by a check.
    await ctx.db.medicationRequest.update({
      where: { id: rx.id },
      data: {
        isControlled: controlled,
        deaSchedule: controlled ? (concept.deaSchedule ?? "unverified") : null,
        formularyStatus: (formulary ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    ctx.audit.detail({ alerts: alerts.length, controlled });
    return {
      alerts: toDtos("DurAlert", alerts),
      ...(formulary
        ? {
            formulary: Object.fromEntries(
              Object.entries(formulary).filter(([, v]) => v !== null),
            ) as RxCheckResult["formulary"],
          }
        : {}),
      pdmpRequired: controlled,
      epcsRequired: controlled,
      ...(formularyUnavailable ? { formularyUnavailable } : {}),
    };
  },

  async decideDurAlert(ctx) {
    const alert = await ctx.db.durAlert.findUnique({ where: { id: ctx.params.durAlertId } });
    if (!alert) throw notFound();
    const rx = await loadRx(ctx, alert.medicationRequestId);
    requireDraft(rx);
    const b = ctx.body;
    const reason = b.reason?.trim() ?? "";
    // INV-SAFE-06: an override needs a stored, reportable reason.
    if (b.action === "override" && !reason)
      throw unprocessable(
        "override_reason_required",
        "Choose a reason for overriding this alert.",
        {
          errors: [{ field: "reason", code: "required", message: "A reason is required." }],
        },
      );
    const latest = await ctx.db.durAlert.findFirst({
      where: { medicationRequestId: rx.id, evidence: { path: ["key"], equals: keyOf(alert) } },
      orderBy: { decidedAt: "desc" },
    });
    if (latest && latest.outcome !== "pending")
      throw conflict("alert_decided", "This alert was already decided.");
    const row = await ctx.db.durAlert.create({
      data: {
        practiceId: alert.practiceId,
        medicationRequestId: rx.id,
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        evidence: { ...(alert.evidence as object), decides: alert.id } as Prisma.InputJsonValue,
        outcome: b.action === "override" ? "overridden" : "removed",
        overrideReason: b.action === "override" ? reason.slice(0, 500) : null,
        decidedById: ctx.staff().userId,
      },
    });
    if (b.action === "cancel") {
      assertTransition("prescription", rx.status, "cancelled", ctx.staff().role);
      const cancelled = await ctx.db.medicationRequest.update({
        where: { id: rx.id },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      await writeVersion(
        ctx.db,
        rx.practiceId,
        "MedicationRequest",
        cancelled,
        ctx.staff().userId,
        "removed after DUR alert",
      );
    }
    ctx.audit.resource("DurAlert", row.id);
    ctx.audit.detail({ action: b.action, type: alert.type, reasonGiven: !!reason });
    return toDto("DurAlert", row);
  },

  async queryPdmp(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    if (b.patientId !== patient.id)
      throw conflict("patient_context_mismatch", "The patient on screen isn't this patient.");
    const me = ctx.staff();
    if (!me.practitionerId)
      throw unprocessable("not_a_prescriber", "Only a prescriber can query the PDMP.");
    const gw = pdmpGateway();
    if (!gw)
      throw conflict(
        "gateway_unavailable",
        "The state PDMP isn't connected. Check it on the state website and record the exception.",
      );
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: me.practiceId } });
    const state = (b.state || practice.state).toUpperCase();
    if (!/^[A-Z]{2}$/.test(state))
      throw validationFailed([
        { field: "state", code: "invalid", message: "Use the two-letter state code." },
      ]);
    const now = new Date();
    let report;
    try {
      report = await recordCall(
        ctx.db,
        {
          practiceId: me.practiceId,
          kind: "PDMP",
          messageType: "PDMP_QUERY",
          idempotencyKey: `pdmp:${patient.id}:${me.userId}:${now.getTime()}`,
          correlationType: "Patient",
          correlationId: patient.id,
          vendorRef: (r) => r.reportId,
        },
        async () =>
          gw.query({
            state,
            patient: {
              lastName: patient.lastName,
              firstName: patient.firstName,
              birthDate: patient.birthDate.toISOString().slice(0, 10),
              sex: (patient.sexForClinicalUse ?? patient.administrativeGender ?? "U").slice(0, 1),
            },
            knownDispensations: await knownDispensations(ctx, patient.id),
          }),
      );
    } catch {
      throw integrationUnavailable(
        "The state PDMP isn't responding. Try again, or record why it couldn't be checked.",
      );
    }
    const prac = await ctx.db.practitioner.findUniqueOrThrow({ where: { id: me.practitionerId } });
    const pdf = await renderPdf(
      {
        title: `PDMP report (${state})${gw.vendor === "simulated" ? " - SIMULATED" : ""}`,
        patientLine: `${patient.lastName}, ${patient.firstName} · DOB ${patient.birthDate.toISOString().slice(0, 10)} · MRN ${patient.mrn}`,
        practiceName: practice.legalName,
      },
      (w) => {
        w.keyValue([
          ["Queried", now.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
          [
            "Requested by",
            `${prac.firstName} ${prac.lastName}${prac.credential ? `, ${prac.credential}` : ""}`,
          ],
          ["Purpose", b.purpose || "Prescribing a controlled substance"],
          ["Report id", report.reportId],
        ]);
        w.subheading("Risk indicators");
        if (report.indicators.length) w.list(report.indicators);
        else w.paragraph("None reported.");
        w.subheading("Controlled-substance dispensations (12 months)");
        if (!report.dispensations.length) w.paragraph("No dispensations found.");
        else
          w.list(
            report.dispensations.map(
              (d) =>
                `${d.filledAt} · ${d.drug} (C-${d.deaSchedule}) · qty ${d.quantity}${d.daysSupply ? ` · ${d.daysSupply} days` : ""} · ${d.prescriber} · ${d.pharmacy}`,
            ),
          );
        if (gw.vendor === "simulated")
          w.muted("Simulated PDMP (development only). Not a state PDMP report.");
      },
    );
    const file = await putFile(ctx.db, {
      practiceId: me.practiceId,
      kind: "generated",
      fileName: `pdmp-${state}-${now.toISOString().slice(0, 10)}.pdf`,
      contentType: "application/pdf",
      data: pdf,
      uploadedById: me.userId,
    });
    const msg = await ctx.db.interfaceMessage.findFirst({
      where: { correlationType: "Patient", correlationId: patient.id, messageType: "PDMP_QUERY" },
      orderBy: { createdAt: "desc" },
    });
    const q = await ctx.db.pdmpQuery.create({
      data: {
        practiceId: me.practiceId,
        patientId: patient.id,
        practitionerId: me.practitionerId,
        state,
        queriedAt: now,
        reportFileId: file.id,
        interfaceMessageId: msg?.id ?? null,
      },
    });
    ctx.audit.patient(patient.id);
    ctx.audit.resource("PdmpQuery", q.id);
    ctx.audit.detail({ state, purpose: (b.purpose ?? "").slice(0, 60) });
    return toDto("PdmpQuery", q);
  },

  async getPdmpReport(ctx) {
    const q = await ctx.db.pdmpQuery.findUnique({ where: { id: ctx.params.pdmpQueryId } });
    if (!q || !q.reportFileId) throw notFound();
    await requirePatient(ctx, q.patientId);
    ctx.audit.patient(q.patientId);
    ctx.audit.resource("PdmpQuery", q.id);
    const file = await ctx.db.fileObject.findUniqueOrThrow({ where: { id: q.reportFileId } });
    return binary("application/pdf", await readFileContent(file), file.fileName);
  },

  async signPrescription(ctx) {
    const b = ctx.body;
    const first = await loadRx(ctx, ctx.params.medicationRequestId);
    const ids = [...new Set([first.id, ...(b.ids ?? [])])];
    const rows = await ctx.db.medicationRequest.findMany({ where: { id: { in: ids } } });
    if (rows.length !== ids.length) throw notFound();
    // INV-ID-03: every prescription belongs to the patient on screen (and to the same visit).
    if (rows.some((r) => r.patientId !== b.patientId || r.encounterId !== first.encounterId))
      throw conflict(
        "patient_context_mismatch",
        "The patient on screen isn't this prescription's patient. Reopen the chart and try again.",
      );
    if (first.encounterId) {
      const enc = await loadEncounter(ctx, first.encounterId);
      if (enc.patientId !== b.patientId)
        throw conflict(
          "patient_context_mismatch",
          "The patient on screen isn't this visit's patient. Reopen the visit from the right chart.",
        );
    }
    if (!erxGateway())
      throw conflict(
        "gateway_unavailable",
        "E-prescribing isn't connected, so prescriptions can't be sent. Call the pharmacy or print from the chart.",
      );
    const signed = await signDrafts(ctx, rows, {
      pharmacyId: b.pharmacyId,
      pdmpQueryId: b.pdmpQueryId,
      epcsToken: b.epcsToken,
      acknowledgedAlertIds: b.acknowledgedAlertIds ?? [],
    });
    ctx.audit.suppressDefault();
    for (const rx of signed) await sendPrescription(ctx.db, rx);
    const out = await ctx.db.medicationRequest.findUniqueOrThrow({ where: { id: first.id } });
    return rxDto(out);
  },

  async cancelPrescription(ctx) {
    const rx = await loadRx(ctx, ctx.params.medicationRequestId);
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([
        { field: "reason", code: "required", message: "Say why it's cancelled." },
      ]);
    assertTransition("prescription", rx.status, "cancelled", ctx.staff().role);
    if (rx.status === "ACTIVE" && rx.erxMessageId && !erxGateway())
      throw conflict(
        "gateway_unavailable",
        "E-prescribing isn't connected, so the pharmacy can't be told. Call the pharmacy to cancel.",
      );
    const cancelled = await ctx.db.medicationRequest.update({
      where: { id: rx.id, version: rx.version },
      data: { status: "CANCELLED", version: { increment: 1 } },
    });
    await writeVersion(
      ctx.db,
      rx.practiceId,
      "MedicationRequest",
      cancelled,
      ctx.staff().userId,
      reason,
    );
    if (rx.status === "ACTIVE") {
      await ctx.db.medicationStatement.updateMany({
        where: { prescriptionId: rx.id, status: "ACTIVE" },
        data: { status: "STOPPED", statusReason: reason, effectiveEnd: new Date() },
      });
      if (rx.erxMessageId) await sendCancel(ctx.db, cancelled, reason);
    }
    await completeTasksFor(
      ctx.db,
      "MedicationRequest",
      rx.id,
      ["INTERFACE_FAILURE"],
      ctx.staff().userId,
    );
    ctx.audit.detail({ wasSigned: rx.status === "ACTIVE" });
    return rxDto(await ctx.db.medicationRequest.findUniqueOrThrow({ where: { id: rx.id } }));
  },

  async getMedicationFillHistory(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    if (!erxGateway())
      throw integrationUnavailable(
        "Fill history arrives through e-prescribing, which isn't connected.",
      );
    // Simulated network: what it accepted from us is what was filled. LogiCoy's RxHistory replaces this.
    const rows = await ctx.db.medicationRequest.findMany({
      where: { patientId: ctx.params.patientId, erxStatus: { in: ["SENT", "ACCEPTED"] } },
      include: { pharmacy: true },
      orderBy: { signedAt: "desc" },
      take: 50,
    });
    const prescribers = await ctx.db.practitioner.findMany({
      where: { id: { in: rows.map((r) => r.prescriberId) } },
    });
    ctx.audit.patient(ctx.params.patientId);
    return rows.map((r) => {
      const p = prescribers.find((x) => x.id === r.prescriberId);
      return {
        filledAt: (r.signedAt ?? r.createdAt).toISOString().slice(0, 10),
        pharmacy: r.pharmacy?.name ?? "Pharmacy",
        quantity: Number(r.quantity),
        daysSupply: r.daysSupply ?? 30,
        ...(p ? { prescriber: `${p.firstName} ${p.lastName}` } : {}),
        source: "erx" as const,
      };
    });
  },

  async getDrug(ctx) {
    const c = await resolveConcept(ctx.params.rxcui, ctx);
    return {
      rxcui: c.rxcui,
      name: c.name,
      tty: c.tty,
      ingredients: c.ingredientNames,
      ...(c.strengthText ? { strength: c.strengthText } : {}),
      ...(c.doseForm ? { doseForm: c.doseForm } : {}),
      // Unverified schedule is treated as controlled (fail closed).
      ...(!c.scheduleKnown
        ? { deaSchedule: "unverified" }
        : c.deaSchedule
          ? { deaSchedule: c.deaSchedule }
          : {}),
    };
  },

  async searchPharmacies(ctx) {
    const q = (ctx.query.q ?? "").trim();
    const zip = (ctx.query.zip ?? "").trim();
    const rows = await ctx.db.pharmacy.findMany({
      where: {
        ...(q
          ? {
              OR: [{ name: { contains: q, mode: "insensitive" } }, { ncpdpId: q }],
            }
          : {}),
        ...(zip ? { address: { path: ["postalCode"], string_starts_with: zip } } : {}),
        ...(ctx.query.specialty ? { specialties: { has: ctx.query.specialty } } : {}),
      },
      orderBy: { name: "asc" },
      take: 25,
    });
    return toDtos("Pharmacy", rows);
  },
};
