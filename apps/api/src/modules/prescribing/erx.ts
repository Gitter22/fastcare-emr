import type { MedicationRequest, Tx } from "../../db.js";
import { decryptField } from "../../encryption.js";
import { type ErxPrescription, erxGateway } from "../../gateways/erx/index.js";
import { connectionFor, recordCall } from "../../platform/integrations.js";
import { registerResender } from "../../platform/interfaceRetry.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";

/**
 * Outbound e-prescribing (flow:encounter/05, flow:refills/04). Each message goes through ErxGateway inside the signing
 * transaction under an InterfaceMessage idempotency key derived from the prescription id, so a resend never creates a
 * second prescription at the pharmacy. A failure leaves the prescription signed with erxStatus ERROR and an
 * INTERFACE_FAILURE work item naming it (INV-OPS-01).
 */

export const NEWRX = "NewRx";
export const CANCELRX = "CancelRx";
export const RENEWAL_RESPONSE = "RxRenewalResponse";
export const CHANGE_RESPONSE = "RxChangeResponse";

export async function buildPrescription(tx: Tx, rx: MedicationRequest): Promise<ErxPrescription> {
  const [patient, prescriber, pharmacy, reason] = await Promise.all([
    tx.patient.findUniqueOrThrow({ where: { id: rx.patientId } }),
    tx.practitioner.findUnique({
      where: { id: rx.prescriberId },
      include: { deaRegistrations: true },
    }),
    rx.pharmacyId ? tx.pharmacy.findUnique({ where: { id: rx.pharmacyId } }) : null,
    rx.reasonConditionId ? tx.condition.findUnique({ where: { id: rx.reasonConditionId } }) : null,
  ]);
  const dea = rx.deaSchedule
    ? (prescriber?.deaRegistrations.find((d) => d.expiresOn > new Date()) ?? null)
    : null;
  return {
    prescriptionId: rx.id,
    patient: {
      mrn: patient.mrn,
      lastName: patient.lastName,
      firstName: patient.firstName,
      birthDate: patient.birthDate.toISOString().slice(0, 10),
      sex: (patient.sexForClinicalUse ?? patient.administrativeGender ?? "U").slice(0, 1),
    },
    prescriber: {
      npi: prescriber?.npi ?? null,
      lastName: prescriber?.lastName ?? "",
      firstName: prescriber?.firstName ?? "",
      dea: dea ? decryptField(dea.number) : null,
    },
    pharmacyNcpdpId: pharmacy?.ncpdpId ?? "",
    drug: {
      rxcui: rx.rxnormCode,
      ndc: rx.ndc,
      description: rx.display,
      deaSchedule: rx.deaSchedule,
    },
    sig: rx.sigText,
    quantity: rx.quantity.toString(),
    quantityUnit: rx.quantityUnit,
    refills: rx.refills,
    daysSupply: rx.daysSupply,
    substitutionAllowed: rx.substitutionAllowed,
    noteToPharmacist: rx.noteToPharmacist,
    diagnosisCodes: reason?.icd10Code ? [reason.icd10Code] : [],
    epcsSignedAt: rx.epcsTwoFactorAt?.toISOString() ?? null,
  };
}

async function failureTask(tx: Tx, rx: MedicationRequest, what: string) {
  const conn = await connectionFor(tx, rx.practiceId, "LOGICOY");
  await createTask(tx, rx.practiceId, {
    type: "INTERFACE_FAILURE",
    title: `${rx.display}: ${what} was not sent to the pharmacy (${conn.displayName})`,
    description:
      "The e-prescribing network did not accept the message. It retries from the interface monitor; call the pharmacy if the patient is waiting.",
    patientId: rx.patientId,
    focusType: "MedicationRequest",
    focusId: rx.id,
    poolKind: "care-team",
    priority: "HIGH",
  });
}

export type SendOutcome = "sent" | "failed";

/**
 * Sends one signed prescription. `respondingTo` turns it into the approval of a pharmacy renewal/change request.
 * Never throws for a vendor failure.
 */
export async function sendPrescription(
  tx: Tx,
  rx: MedicationRequest,
  respondingTo?: { requestMessageId: string; kind: "renewal" | "change" },
): Promise<SendOutcome> {
  const gw = erxGateway();
  if (!gw) return "failed";
  const payload = await buildPrescription(tx, rx);
  const messageType = respondingTo
    ? respondingTo.kind === "renewal"
      ? RENEWAL_RESPONSE
      : CHANGE_RESPONSE
    : NEWRX;
  try {
    const res = await recordCall(
      tx,
      {
        practiceId: rx.practiceId,
        kind: "LOGICOY",
        messageType,
        idempotencyKey: `erx:${messageType}:${rx.id}`,
        correlationType: "MedicationRequest",
        correlationId: rx.id,
        failed: (r) => (r.status === "accepted" ? null : (r.error ?? "rejected")),
        vendorRef: (r) => r.messageId,
      },
      () =>
        respondingTo
          ? gw.sendRequestResponse({
              requestMessageId: respondingTo.requestMessageId,
              kind: respondingTo.kind,
              decision: "approved",
              prescription: payload,
            })
          : gw.sendNewRx(payload),
    );
    if (res.status !== "accepted") {
      await tx.medicationRequest.update({
        where: { id: rx.id },
        data: { erxStatus: "ERROR", erxError: (res.error ?? "Rejected").slice(0, 200) },
      });
      await failureTask(tx, rx, "the prescription");
      return "failed";
    }
    await tx.medicationRequest.update({
      where: { id: rx.id },
      data: { erxStatus: "SENT", erxMessageId: res.messageId, erxError: null },
    });
    await completeTasksFor(tx, "MedicationRequest", rx.id, ["INTERFACE_FAILURE"], null);
    return "sent";
  } catch (e) {
    await tx.medicationRequest.update({
      where: { id: rx.id },
      data: { erxStatus: "QUEUED", erxError: (e as Error).message.slice(0, 200) },
    });
    await failureTask(tx, rx, "the prescription");
    return "failed";
  }
}

/** CancelRx for a sent prescription. A failure keeps the cancel queued with a work item to call the pharmacy. */
export async function sendCancel(
  tx: Tx,
  rx: MedicationRequest,
  reason: string,
): Promise<SendOutcome> {
  const gw = erxGateway();
  if (!gw || !rx.erxMessageId) return "failed";
  try {
    const res = await recordCall(
      tx,
      {
        practiceId: rx.practiceId,
        kind: "LOGICOY",
        messageType: CANCELRX,
        idempotencyKey: `erx:${CANCELRX}:${rx.id}`,
        correlationType: "MedicationRequest",
        correlationId: rx.id,
        failed: (r) => (r.status === "accepted" ? null : (r.error ?? "rejected")),
        vendorRef: (r) => r.messageId,
      },
      () => gw.sendCancelRx({ prescriptionId: rx.id, originalMessageId: rx.erxMessageId!, reason }),
    );
    if (res.status === "accepted") {
      await tx.medicationRequest.update({
        where: { id: rx.id },
        data: { erxStatus: "CANCELLED" },
      });
      await completeTasksFor(tx, "MedicationRequest", rx.id, ["INTERFACE_FAILURE"], null);
      return "sent";
    }
  } catch {
    /* fall through */
  }
  await tx.medicationRequest.update({
    where: { id: rx.id },
    data: { erxStatus: "CANCEL_REQUESTED" },
  });
  await failureTask(tx, rx, "the cancel request");
  return "failed";
}

// Resends from the interface monitor re-run the same message under the same idempotency key.
async function reloadForResend(
  tx: Tx,
  message: { id: string; correlationId: string | null },
  ok: (rx: MedicationRequest) => boolean,
) {
  const rx = message.correlationId
    ? await tx.medicationRequest.findUnique({ where: { id: message.correlationId } })
    : null;
  if (!rx || !ok(rx)) {
    await tx.interfaceMessage.update({
      where: { id: message.id },
      data: {
        attempts: { increment: 1 },
        status: rx ? "ACKNOWLEDGED" : "DEAD",
        completedAt: new Date(),
      },
    });
    return null;
  }
  return rx;
}

registerResender(NEWRX, async (tx, message) => {
  const rx = await reloadForResend(
    tx,
    message,
    (r) => r.status === "ACTIVE" && ["QUEUED", "ERROR", "NOT_SENT"].includes(r.erxStatus),
  );
  if (rx) await sendPrescription(tx, rx);
});

registerResender(CANCELRX, async (tx, message) => {
  const rx = await reloadForResend(tx, message, (r) => r.erxStatus === "CANCEL_REQUESTED");
  if (rx) await sendCancel(tx, rx, "Resent cancel request");
});

for (const [type, kind] of [
  [RENEWAL_RESPONSE, "renewal"],
  [CHANGE_RESPONSE, "change"],
] as const)
  registerResender(type, async (tx, message) => {
    const rx = await reloadForResend(
      tx,
      message,
      (r) => r.status === "ACTIVE" && ["QUEUED", "ERROR", "NOT_SENT"].includes(r.erxStatus),
    );
    if (!rx) return;
    const req = await tx.rxRequest.findFirst({ where: { responsePrescriptionId: rx.id } });
    const inbound = req?.interfaceMessageId
      ? await tx.interfaceMessage.findUnique({ where: { id: req.interfaceMessageId } })
      : null;
    await sendPrescription(tx, rx, {
      requestMessageId: inbound?.vendorRef ?? req?.id ?? rx.id,
      kind,
    });
  });
