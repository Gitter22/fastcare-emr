import { randomInt } from "node:crypto";
import type { ServiceRequest, Tx } from "../../db.js";
import { buildOrm, labGateway } from "../../gateways/lab/index.js";
import { connectionFor, recordCall } from "../../platform/integrations.js";
import { registerResender } from "../../platform/interfaceRetry.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { aoeQuestionsOf } from "./catalog.js";

/**
 * Electronic lab orders (flow:results/01). Signed lab orders go out as ORM through LabGateway inside the signing
 * transaction; the InterfaceMessage idempotency key is the order id, so resends never create a second order at the
 * lab. A failure leaves the order Signed, prints still work, and an INTERFACE_FAILURE work item names the order
 * (INV-OPS-01). With no lab connected, orders stay Signed for a printed requisition.
 */

export const ORM_TYPE = "ORM^O01";

export function newPlacerOrderNumber(): string {
  const d = new Date();
  const ymd =
    `${d.getUTCFullYear() % 100}`.padStart(2, "0") +
    `${d.getUTCMonth() + 1}`.padStart(2, "0") +
    `${d.getUTCDate()}`.padStart(2, "0");
  return `AE${ymd}${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
}

export const isElectronicLab = (sr: Pick<ServiceRequest, "category" | "performerLab">) =>
  sr.category === "LAB" && !!sr.performerLab;

async function buildMessage(tx: Tx, sr: ServiceRequest) {
  const [patient, signer, reasons, comp] = await Promise.all([
    tx.patient.findUniqueOrThrow({ where: { id: sr.patientId } }),
    sr.signedById ? tx.practitioner.findFirst({ where: { userId: sr.signedById } }) : null,
    tx.serviceRequestReason.findMany({
      where: { serviceRequestId: sr.id },
      include: { condition: true },
    }),
    sr.labCompendiumItemId
      ? tx.labCompendiumItem.findUnique({ where: { id: sr.labCompendiumItemId } })
      : null,
  ]);
  const answers = (sr.aoeAnswers ?? {}) as Record<string, unknown>;
  return buildOrm({
    messageControlId: `${sr.placerOrderNumber}-${Date.now()}`,
    sendingFacility: sr.practiceId,
    receivingLab: sr.performerLab ?? "LAB",
    at: new Date(),
    patient: {
      mrn: patient.mrn,
      lastName: patient.lastName,
      firstName: patient.firstName,
      middleName: patient.middleName,
      birthDate: patient.birthDate.toISOString().slice(0, 10),
      sex: (patient.sexForClinicalUse ?? patient.administrativeGender ?? "U").slice(0, 1),
    },
    order: {
      placerOrderNumber: sr.placerOrderNumber!,
      testCode: comp?.testCode ?? sr.code,
      display: sr.display,
      loincCode: comp?.loincCode ?? (sr.codeSystem === "LOINC" ? sr.code : null),
      priority: sr.priority,
      orderingProvider: {
        npi: signer?.npi ?? null,
        lastName: signer?.lastName ?? "",
        firstName: signer?.firstName ?? "",
      },
      diagnoses: reasons
        .filter((r) => r.condition.icd10Code)
        .map((r) => ({ code: r.condition.icd10Code!, display: r.condition.display })),
      aoe: aoeQuestionsOf(comp).flatMap((q) =>
        answers[q.code] === undefined
          ? []
          : [{ code: q.code, text: q.text, answer: String(answers[q.code]) }],
      ),
      collectedAt: sr.collectedAt,
    },
  });
}

export type SendOutcome = "sent" | "not-connected" | "failed";

/** Sends one signed lab order. Never throws for a vendor failure: the order stays Signed with a work item. */
export async function sendToLab(tx: Tx, sr: ServiceRequest): Promise<SendOutcome> {
  if (sr.status !== "SIGNED" || !isElectronicLab(sr)) return "not-connected";
  const gw = labGateway();
  if (!gw) return "not-connected";
  assertTransition("order", sr.status, "sent", "system");
  const orm = await buildMessage(tx, sr);
  const conn = await connectionFor(tx, sr.practiceId, "HEALTH_GORILLA");
  try {
    const res = await recordCall(
      tx,
      {
        practiceId: sr.practiceId,
        kind: "HEALTH_GORILLA",
        messageType: ORM_TYPE,
        idempotencyKey: `orm:${sr.id}`,
        correlationType: "ServiceRequest",
        correlationId: sr.id,
        failed: (r) => (r.ack === "AA" ? null : `${r.ack}: ${r.error ?? "rejected by the lab"}`),
        vendorRef: (r) => r.accessionNumber,
      },
      () => gw.send(orm),
    );
    if (res.ack !== "AA")
      throw Object.assign(new Error(res.error ?? "rejected"), { code: res.ack });
    const msg = await tx.interfaceMessage.findUnique({ where: { idempotencyKey: `orm:${sr.id}` } });
    await tx.serviceRequest.update({
      where: { id: sr.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        accessionNumber: res.accessionNumber,
        interfaceMessageId: msg?.id ?? null,
        version: { increment: 1 },
      },
    });
    await completeTasksFor(tx, "ServiceRequest", sr.id, ["INTERFACE_FAILURE"], null);
    return "sent";
  } catch {
    const open = await tx.task.findFirst({
      where: {
        type: "INTERFACE_FAILURE",
        focusType: "ServiceRequest",
        focusId: sr.id,
        status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED"] },
      },
    });
    if (!open)
      await createTask(tx, sr.practiceId, {
        type: "INTERFACE_FAILURE",
        title: `${sr.display} was not sent to ${conn.displayName}`,
        description:
          "The lab interface did not accept the order. It retries from the interface monitor; print the requisition if the patient is waiting.",
        patientId: sr.patientId,
        focusType: "ServiceRequest",
        focusId: sr.id,
        poolKind: "care-team",
        priority: sr.priority === "STAT" ? "URGENT" : "HIGH",
      });
    return "failed";
  }
}

// Resend from the interface monitor re-runs the same order under the same idempotency key.
registerResender(ORM_TYPE, async (tx, message) => {
  const sr = message.correlationId
    ? await tx.serviceRequest.findUnique({ where: { id: message.correlationId } })
    : null;
  if (!sr || sr.status !== "SIGNED") {
    await tx.interfaceMessage.update({
      where: { id: message.id },
      data: {
        attempts: { increment: 1 },
        status: sr ? "ACKNOWLEDGED" : "DEAD",
        completedAt: new Date(),
      },
    });
    return;
  }
  await sendToLab(tx, sr);
});
