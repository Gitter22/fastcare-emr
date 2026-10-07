/**
 * Money travels as a decimal string with two places ("123.45"), never a float (docs/ehr-spec/docs/09-data-model.md).
 * Arithmetic is done in integer cents.
 */
export type Money = string;

export function toCents(m: Money | null | undefined): number {
  if (m == null || m === "") return 0;
  const neg = m.trim().startsWith("-");
  const [whole, frac = ""] = m.replace("-", "").trim().split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function fromCents(cents: number): Money {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(m: Money | null | undefined): string {
  const cents = toCents(m);
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return cents < 0 ? `-${s}` : s;
}
