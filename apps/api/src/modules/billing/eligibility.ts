import type { Tx } from "../../db.js";
import { clearinghouse } from "../../gateways/clearinghouse/index.js";
import { putFile } from "../../gateways/fileStore.js";
import { recordCall } from "../../platform/integrations.js";
import { completeTasksFor, createTask } from "../../platform/tasks.js";
import { decryptField, decryptOptionalField } from "../../platform/crypto.js";

/**
 * Real-time and batch eligibility (flow:access/03) through ClearinghouseGateway (X12 270/271). "Error" means the
 * payer or clearinghouse could not answer: it is never treated as inactive. An inactive or unverifiable result
 * creates an ELIGIBILITY_FAILURE work item for the front desk; a later active result closes it.
 */
export async function runEligibility(
  tx: Tx,
  input: {
    practiceId: string;
    coverageId: string;
    appointmentId?: string | null;
    mode: "realtime" | "batch";
    dateOfService?: string;
    serviceTypeCodes?: string[];
    userId?: string | null;
    practitionerId?: string | null;
  },
) {
  const cov = await tx.coverage.findUniqueOrThrow({
    where: { id: input.coverageId },
    include: { payer: true, patient: true },
  });
  const practice = await tx.practice.findUniqueOrThrow({ where: { id: input.practiceId } });
  const prov = input.practitionerId
    ? await tx.practitioner.findUnique({ where: { id: input.practitionerId } })
    : null;
  const subscriber = cov.subscriberRelatedPersonId
    ? await tx.relatedPerson.findUnique({ where: { id: cov.subscriberRelatedPersonId } })
    : null;
  const p = cov.patient;
  const dob = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
  const check = await tx.eligibilityCheck.create({
    data: {
      practiceId: input.practiceId,
      coverageId: cov.id,
      appointmentId: input.appointmentId ?? null,
      mode: input.mode,
    },
  });
  const outcome = await recordCall(
    tx,
    {
      practiceId: input.practiceId,
      kind: "STEDI",
      messageType: "X12_270",
      idempotencyKey: `eligibility:${check.id}`,
      correlationType: "EligibilityCheck",
      correlationId: check.id,
      // An outage counts against interface health; a payer saying "inactive" does not.
      failed: (r) =>
        r.result.status === "Error" && /UNAVAILABLE|HTTP_5/.test(r.result.errorCode ?? "")
          ? r.result.errorCode
          : null,
      vendorRef: (r) => r.vendorRef,
    },
    () =>
      clearinghouse.checkEligibility({
        payerId: cov.payer.clearinghousePayerId,
        memberId: decryptField(cov.memberId),
        subscriber: subscriber
          ? {
              firstName: subscriber.firstName,
              lastName: subscriber.lastName,
              dateOfBirth: dob(subscriber.birthDate),
            }
          : { firstName: p.firstName, lastName: p.lastName, dateOfBirth: dob(p.birthDate) },
        ...(subscriber
          ? {
              dependent: {
                firstName: p.firstName,
                lastName: p.lastName,
                dateOfBirth: dob(p.birthDate),
              },
            }
          : {}),
        provider: { npi: prov?.npi ?? practice.groupNpi ?? "", name: practice.legalName },
        dateOfService: input.dateOfService,
        serviceTypeCodes: input.serviceTypeCodes,
      }),
  );
  const r = outcome.result;
  let rawFileId: string | null = null;
  if (outcome.raw) {
    // The full 271 carries PHI: stored only as an encrypted file.
    const f = await putFile(tx, {
      practiceId: input.practiceId,
      kind: "generated",
      fileName: `271-${check.id}.json`,
      contentType: "application/json",
      data: Buffer.from(JSON.stringify(outcome.raw)),
    });
    rawFileId = f.id;
  }
  const status = r.status === "Active" ? "ACTIVE" : r.status === "Inactive" ? "INACTIVE" : "ERROR";
  const updated = await tx.eligibilityCheck.update({
    where: { id: check.id },
    data: {
      respondedAt: new Date(),
      status,
      copay: r.copayAmount,
      coinsurancePct: r.coinsurancePct,
      deductibleRemaining: r.deductibleRemaining,
      outOfPocketRemaining: r.outOfPocketRemaining,
      errorMessage: r.errorCode,
      benefits: rawFileId ? { rawFileId } : undefined,
    },
  });
  if (status === "ACTIVE") {
    await completeTasksFor(tx, "Coverage", cov.id, ["ELIGIBILITY_FAILURE"], input.userId ?? null);
  } else {
    await createTask(tx, input.practiceId, {
      type: "ELIGIBILITY_FAILURE",
      title:
        status === "INACTIVE"
          ? `Coverage inactive: ${cov.payer.name}`
          : `Eligibility not verified: ${cov.payer.name}`,
      description:
        status === "INACTIVE"
          ? "Payer reports the coverage inactive. Update insurance or offer self-pay."
          : "The payer or clearinghouse did not answer. Checks retry automatically.",
      patientId: cov.patientId,
      focusType: "Coverage",
      focusId: cov.id,
      poolKind: "front-desk",
      priority: "HIGH",
    });
  }
  return updated;
}

export const memberIdMasked = (stored: string) => {
  const v = decryptOptionalField(stored) ?? "";
  return v.length > 4 ? `•••${v.slice(-4)}` : v;
};
