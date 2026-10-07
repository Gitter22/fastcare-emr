import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "../../env.js";

/**
 * Vendor-stub convention (Global Conventions), same pattern as
 * smsProvider.ts. Consent signing links and post-signature PDF copies
 * (FRD Sec. 18) are built against this interface now, with a deterministic
 * dev implementation. A real vendor can be swapped in later (currently Gmail
 * SMTP via nodemailer when GMAIL_USER/GMAIL_APP_PASSWORD are set) without
 * touching the consent flow that calls it.
 *
 * Note: GmailSmtpEmailProvider is demo/testing-grade only (personal Gmail
 * SMTP, ~500 emails/day cap, no retries or bounce handling). Not production.
 */
export interface EmailProvider {
  send(toEmail: string, subject: string, body: string): Promise<void>;
}

/** Dev stub: logs the email to the server console/log instead of sending a
 * real email. Never logs anything beyond what's already safe to log --
 * the signing link/token itself is fine (it's a single-use, short-lived,
 * hashed-at-rest credential, the same class of thing an OTP code is), but
 * this must never be extended to log PHI in the body. */
export class ConsoleEmailProvider implements EmailProvider {
  async send(toEmail: string, subject: string, body: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `[ConsoleEmailProvider] (dev stub, not a real email) to=${toEmail} subject="${subject}": ${body}`,
    );
  }
}

/** Gmail SMTP provider: demo/testing-grade integration using personal Gmail
 * account credentials (App Password). Suitable only for low-volume demo sends,
 * not production email. No retries, bounce handling, or rate-limit management. */
export class GmailSmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly gmailUser: string;

  constructor(gmailUser: string, appPassword: string) {
    this.gmailUser = gmailUser;
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: appPassword },
    });
  }

  async send(toEmail: string, subject: string, body: string): Promise<void> {
    const env = getEnv();
    await this.transporter.sendMail({
      from: `"${env.APP_NAME}" <${this.gmailUser}>`,
      to: toEmail,
      subject,
      text: body,
    });
  }
}

function createEmailProvider(): EmailProvider {
  const env = getEnv();
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return new GmailSmtpEmailProvider(env.GMAIL_USER, env.GMAIL_APP_PASSWORD);
  }
  return new ConsoleEmailProvider();
}

export const emailProvider: EmailProvider = createEmailProvider();
