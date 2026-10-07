import { getEnv } from "../../env.js";

/**
 * Vendor-stub convention (Global Conventions): guardian OTP delivery and
 * appointment reminders (FRD Sec. 6) are built against this interface, with
 * a deterministic dev implementation, so the real vendor can be swapped in
 * without touching the flows that call it. `send` resolves with the
 * vendor's message id (null when the vendor has none, e.g. the console
 * stub) and throws if delivery fails.
 */
export interface SmsProvider {
  send(toPhoneNumber: string, message: string): Promise<{ messageId: string | null }>;
}

/** Dev stub: logs the message to the server console/log instead of sending
 * a real SMS -- this is intentional per Step 1 acceptance ("OTP delivery
 * stubbed -- log the code to the server console/log in dev instead of
 * sending a real SMS"), not an oversight. Never logs the destination phone
 * number itself (logging convention). */
export class ConsoleSmsProvider implements SmsProvider {
  async send(_toPhoneNumber: string, message: string): Promise<{ messageId: string | null }> {
    // eslint-disable-next-line no-console
    console.log(`[ConsoleSmsProvider] (dev stub, not a real SMS): ${message}`);
    return { messageId: null };
  }
}

/** Twilio Programmable Messaging over its REST API (no SDK dependency).
 * Not exercised against the live API in this repo -- needs a Twilio account
 * and, for US traffic, approved 10DLC registration. Errors never include the
 * destination number. */
export class TwilioSmsProvider implements SmsProvider {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
  ) {}

  async send(toPhoneNumber: string, message: string): Promise<{ messageId: string | null }> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: toPhoneNumber, From: this.fromNumber, Body: message }),
      },
    );
    let body: { sid?: string; code?: number; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Non-JSON error body -- fall through to the status-only error below.
    }
    if (!res.ok) {
      // `code` is what reminderJob.ts records as the failure reason -- a
      // short machine string, never the vendor's free-text message.
      throw Object.assign(new Error("Twilio send failed"), {
        code: `TWILIO_HTTP_${res.status}${body.code ? `_${body.code}` : ""}`,
      });
    }
    return { messageId: body.sid ?? null };
  }
}

function createSmsProvider(): SmsProvider {
  const env = getEnv();
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) {
    return new TwilioSmsProvider(
      env.TWILIO_ACCOUNT_SID,
      env.TWILIO_AUTH_TOKEN,
      env.TWILIO_FROM_NUMBER,
    );
  }
  return new ConsoleSmsProvider();
}

export const smsProvider: SmsProvider = createSmsProvider();
