import type { Tx } from "../db.js";
import { messaging } from "../gateways/messaging/index.js";
import type { TemplateKey, TemplateParams } from "../gateways/messaging/templates.js";
import { decryptField } from "./crypto.js";
import { withTenant } from "./tenant.js";

/**
 * Patient-facing messages (MessagingGateway). Bodies are templates with no clinical detail (INV-SEC-06). Channel
 * choice respects consent: SMS only with an active SMS_TCPA consent and no STOP opt-out; otherwise email; otherwise
 * nothing is sent and the CommunicationLog says why. The message goes out after the transaction commits, so a
 * rolled-back booking never texts the patient.
 */
export interface PatientMessage<K extends TemplateKey> {
  patientId: string;
  template: K;
  params: TemplateParams<K>;
  purpose: string;
  relatedType?: string;
  relatedId?: string;
  createdById?: string | null;
  prefer?: "SMS" | "EMAIL";
}

export async function queuePatientMessage<K extends TemplateKey>(
  tx: Tx,
  practiceId: string,
  m: PatientMessage<K>,
  afterCommit: (fn: () => Promise<void>) => void,
): Promise<string | null> {
  const [contacts, smsConsent] = await Promise.all([
    tx.patientContactPoint.findMany({
      where: { patientId: m.patientId },
      orderBy: { rank: "asc" },
    }),
    tx.consent.findFirst({
      where: { patientId: m.patientId, type: "SMS_TCPA", status: "ACTIVE", revokedAt: null },
    }),
  ]);
  const mobile =
    contacts.find(
      (c) => (c.system === "PHONE" || c.system === "SMS") && c.use === "MOBILE" && !c.smsOptOut,
    ) ?? contacts.find((c) => (c.system === "PHONE" || c.system === "SMS") && !c.smsOptOut);
  const email = contacts.find((c) => c.system === "EMAIL");
  const canSms = !!mobile && !!smsConsent;
  const channel: "SMS" | "EMAIL" | null =
    m.prefer === "EMAIL"
      ? email
        ? "EMAIL"
        : canSms
          ? "SMS"
          : null
      : canSms
        ? "SMS"
        : email
          ? "EMAIL"
          : null;
  const target = channel === "SMS" ? mobile! : channel === "EMAIL" ? email! : null;
  const log = await tx.communicationLog.create({
    data: {
      practiceId,
      patientId: m.patientId,
      channel: channel ?? "SMS",
      purpose: m.purpose,
      templateKey: m.template,
      to: target ? target.value : "",
      status: channel ? "QUEUED" : "FAILED",
      error: channel ? null : mobile && !smsConsent && !email ? "no-sms-consent" : "no-contact",
      relatedType: m.relatedType ?? null,
      relatedId: m.relatedId ?? null,
      createdById: m.createdById ?? null,
    },
  });
  if (!channel || !target) return log.id;
  afterCommit(async () => {
    let status: "SENT" | "FAILED" = "SENT";
    let vendorRef: string | null = null;
    let error: string | null = null;
    try {
      const to = decryptField(target.value);
      const sent = await messaging.send(
        channel,
        channel === "SMS" ? toE164(to) : to,
        m.template,
        m.params,
      );
      vendorRef = sent.vendorRef;
    } catch (e) {
      status = "FAILED";
      error = (e as { code?: string }).code ?? "SEND_FAILED";
    }
    await withTenant(practiceId, (t) =>
      t.communicationLog.update({
        where: { id: log.id },
        data: {
          status,
          providerMessageId: vendorRef,
          error,
          sentAt: status === "SENT" ? new Date() : null,
        },
      }),
    );
  });
  return log.id;
}

function toE164(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : `+${d}`;
}
