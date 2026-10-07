import { randomUUID } from "node:crypto";

/**
 * PaymentGateway (ADR-005). The card processor is not chosen yet (OPEN-Q2) and agile-emr has no payment vendor,
 * so only the fake exists. Card data never touches this system: the UI collects it in the processor's hosted fields
 * and sends a token (PCI scope stays with the processor).
 */
export interface ChargeInput {
  amountCents: number;
  method: "CARD" | "CASH" | "CHECK" | "ACH" | "EFT";
  hostedFieldsToken?: string;
  paymentMethodRef?: string;
  idempotencyKey: string;
}

export interface ChargeOutcome {
  ok: boolean;
  processorRef: string | null;
  declineCode?: string;
}

export interface PaymentGateway {
  readonly vendor: "fake";
  charge(input: ChargeInput): Promise<ChargeOutcome>;
  refund(processorRef: string, amountCents: number, idempotencyKey: string): Promise<ChargeOutcome>;
  /** Card details the processor returns for a hosted-fields token (never the card number). */
  describeToken(
    token: string,
  ): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null>;
}

/** Fake: cash/check always succeed; token "tok_decline" declines; everything else approves. Idempotent by key. */
export class FakePaymentGateway implements PaymentGateway {
  readonly vendor = "fake" as const;
  private readonly seen = new Map<string, ChargeOutcome>();
  async charge(input: ChargeInput): Promise<ChargeOutcome> {
    const prior = this.seen.get(input.idempotencyKey);
    if (prior) return prior;
    const out: ChargeOutcome =
      input.method === "CARD" && input.hostedFieldsToken === "tok_decline"
        ? { ok: false, processorRef: null, declineCode: "card_declined" }
        : {
            ok: true,
            processorRef:
              input.method === "CARD" || input.method === "ACH" ? `fakepay_${randomUUID()}` : null,
          };
    this.seen.set(input.idempotencyKey, out);
    return out;
  }
  /** Fake tokens look like tok_visa_4242_1228 (brand, last 4, MMYY). */
  async describeToken(token: string) {
    const m = /^tok_([a-z]+)_(\d{4})(?:_(\d{2})(\d{2}))?$/.exec(token);
    if (!m)
      return token.startsWith("tok_")
        ? { brand: "Card", last4: "0000", expMonth: 12, expYear: new Date().getFullYear() + 3 }
        : null;
    return {
      brand: m[1]![0]!.toUpperCase() + m[1]!.slice(1),
      last4: m[2]!,
      expMonth: Number(m[3] ?? 12),
      expYear: 2000 + Number(m[4] ?? (new Date().getFullYear() + 3) % 100),
    };
  }

  async refund(
    processorRef: string,
    _amountCents: number,
    idempotencyKey: string,
  ): Promise<ChargeOutcome> {
    const prior = this.seen.get(idempotencyKey);
    if (prior) return prior;
    const out = { ok: true, processorRef: `refund_${processorRef}` };
    this.seen.set(idempotencyKey, out);
    return out;
  }
}

export const payments: PaymentGateway = new FakePaymentGateway();
