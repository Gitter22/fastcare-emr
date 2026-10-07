import type { PaymentMethodType, Tx } from "../../db.js";
import { payments } from "../../gateways/payment/index.js";
import { toCents } from "@agile-emr/shared";
import { recordCall } from "../../platform/integrations.js";
import { centsToMoney } from "../../platform/ledger.js";

/**
 * Taking money (billing.payment-capture, check-in copays, checkout). The processor is called through
 * PaymentGateway; on success one Payment row and one append-only PATIENT_PAYMENT ledger credit are written
 * (INV-FIN-01). Balances stay derived (INV-FIN-02). A declined card writes a FAILED payment and no ledger entry.
 */
export interface TakePaymentInput {
  practiceId: string;
  patientId: string;
  amount: string;
  method: PaymentMethodType;
  paymentMethodId?: string | null;
  hostedFieldsToken?: string | null;
  checkNumber?: string | null;
  appointmentId?: string | null;
  encounterId?: string | null;
  channel: "front-desk" | "portal" | "autopay" | "mail";
  locationId?: string | null;
  takenById?: string | null;
  idempotencyKey: string;
}

export async function takePayment(tx: Tx, input: TakePaymentInput) {
  const cents = toCents(input.amount);
  if (cents <= 0)
    throw Object.assign(new Error("amount must be positive"), { code: "invalid_amount" });
  let processorToken: string | undefined;
  if (input.paymentMethodId) {
    const pm = await tx.paymentMethod.findFirst({
      where: { id: input.paymentMethodId, patientId: input.patientId, active: true },
    });
    if (!pm) throw Object.assign(new Error("card not on file"), { code: "payment_method_missing" });
    processorToken = pm.processorToken;
  }
  // Idempotent (INV-OPS-01): a repeated key returns the payment already taken instead of charging twice.
  const prior = await tx.interfaceMessage.findUnique({
    where: { idempotencyKey: `payment:${input.idempotencyKey}` },
  });
  if (prior?.status === "ACKNOWLEDGED") {
    const existing = await tx.payment.findFirst({
      where: {
        patientId: input.patientId,
        processorRef: { in: [prior.vendorRef ?? "", `idem:${input.idempotencyKey}`] },
      },
    });
    if (existing) return existing;
  }
  const outcome = await recordCall(
    tx,
    {
      practiceId: input.practiceId,
      kind: "PAYMENT",
      messageType: "PAYMENT_CHARGE",
      idempotencyKey: `payment:${input.idempotencyKey}`,
      correlationType: "Patient",
      correlationId: input.patientId,
      vendorRef: (r) => r.processorRef ?? `idem:${input.idempotencyKey}`,
    },
    () =>
      payments.charge({
        amountCents: cents,
        method: input.method,
        hostedFieldsToken: input.hostedFieldsToken ?? undefined,
        paymentMethodRef: processorToken,
        idempotencyKey: input.idempotencyKey,
      }),
  );
  const payment = await tx.payment.create({
    data: {
      practiceId: input.practiceId,
      patientId: input.patientId,
      method: input.method,
      paymentMethodId: input.paymentMethodId ?? null,
      amount: centsToMoney(cents),
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      processorRef: outcome.processorRef ?? `idem:${input.idempotencyKey}`,
      checkNumber: input.checkNumber ?? null,
      appliedTo: input.encounterId
        ? [{ encounterId: input.encounterId, amount: centsToMoney(cents) }]
        : undefined,
      channel: input.channel,
      locationId: input.locationId ?? null,
      takenById: input.takenById ?? null,
    },
  });
  if (outcome.ok) {
    await tx.ledgerEntry.create({
      data: {
        practiceId: input.practiceId,
        patientId: input.patientId,
        encounterId: input.encounterId ?? null,
        paymentId: payment.id,
        type: "PATIENT_PAYMENT",
        responsibility: "PATIENT",
        amount: centsToMoney(-cents),
        memo: input.appointmentId ? "Payment at visit" : "Patient payment",
        postedById: input.takenById ?? null,
      },
    });
  }
  return payment;
}
