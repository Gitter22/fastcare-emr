import { getEnv } from "../../env.js";
import { emailProvider, type EmailProvider } from "./emailProvider.js";
import { smsProvider, type SmsProvider } from "./smsProvider.js";
import { renderTemplate, type TemplateKey, type TemplateParams } from "./templates.js";

/**
 * MessagingGateway (ADR-005): SMS through Twilio, email through SMTP, both behind agile-emr's provider classes
 * (copied unchanged). Callers can only send a named template with non-clinical parameters, so no SMS or email body
 * can carry clinical detail (INV-SEC-06); the detail lives behind the portal link.
 */
export interface SentMessage {
  channel: "SMS" | "EMAIL";
  to: string;
  template: TemplateKey;
  subject?: string;
  body: string;
  vendorRef: string | null;
}

export interface MessagingGateway {
  send<K extends TemplateKey>(
    channel: "SMS" | "EMAIL",
    to: string,
    template: K,
    params: TemplateParams<K>,
  ): Promise<SentMessage>;
}

class ProviderMessagingGateway implements MessagingGateway {
  constructor(
    private readonly sms: SmsProvider,
    private readonly email: EmailProvider,
  ) {}

  async send<K extends TemplateKey>(
    channel: "SMS" | "EMAIL",
    to: string,
    template: K,
    params: TemplateParams<K>,
  ) {
    const { subject, body } = renderTemplate(template, params);
    if (channel === "SMS") {
      const { messageId } = await this.sms.send(to, body);
      return { channel, to, template, body, vendorRef: messageId };
    }
    await this.email.send(to, subject, body);
    return { channel, to, template, subject, body, vendorRef: null };
  }
}

/** Test fake: records messages so tests can read codes and links and lint bodies. */
export class CapturingMessagingGateway implements MessagingGateway {
  readonly sent: SentMessage[] = [];
  async send<K extends TemplateKey>(
    channel: "SMS" | "EMAIL",
    to: string,
    template: K,
    params: TemplateParams<K>,
  ) {
    const { subject, body } = renderTemplate(template, params);
    const m: SentMessage = {
      channel,
      to,
      template,
      subject,
      body,
      vendorRef: `fake-${this.sent.length + 1}`,
    };
    this.sent.push(m);
    return m;
  }
}

export const capturedMessages = new CapturingMessagingGateway();

export const messaging: MessagingGateway =
  getEnv().NODE_ENV === "test"
    ? capturedMessages
    : new ProviderMessagingGateway(smsProvider, emailProvider);
