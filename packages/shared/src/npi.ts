/**
 * NPI check digit (Luhn over the "80840" prefix + first 9 digits, per CMS NPI standard). Format check only; the
 * NPPES lookup (ReferenceDataGateway) confirms the number is real.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  return luhnCheckDigit(`80840${npi.slice(0, 9)}`) === Number(npi[9]);
}

function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Completes a 9-digit NPI base with its check digit (test fixtures and seed data). */
export function npiWithCheckDigit(base9: string): string {
  return `${base9}${luhnCheckDigit(`80840${base9}`)}`;
}
