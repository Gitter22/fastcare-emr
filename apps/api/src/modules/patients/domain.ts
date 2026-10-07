/**
 * Patient identity rules (pure; no IO).
 *   INV-ID-02: possible duplicates are found by name + DOB + phone (plus email and SSN last 4) before a patient is
 *   created; a strong match blocks creation unless the user records why it is a different person.
 */
export interface IdentityInput {
  firstName: string;
  lastName: string;
  birthDate: string; // YYYY-MM-DD
  phoneIndex?: string | null;
  emailIndex?: string | null;
  ssnLast4?: string | null;
}

export interface IdentityCandidate extends IdentityInput {
  id: string;
}

export interface DuplicateScore {
  score: number;
  matchedOn: string[];
}

/** Below this, a candidate is not shown. */
export const SHOW_THRESHOLD = 0.5;
/** At or above this, creation is blocked until the user records a reason (duplicateOverrideReason). */
export const BLOCK_THRESHOLD = 0.75;

export const normaliseName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Day/month transposition is a common registration error (03/14 vs 14/03). */
function dobTransposed(a: string, b: string): boolean {
  const [ya, ma, da] = a.split("-");
  const [yb, mb, db] = b.split("-");
  return ya === yb && ma === db && da === mb && ma !== da;
}

export function scoreCandidate(input: IdentityInput, c: IdentityCandidate): DuplicateScore {
  const matchedOn: string[] = [];
  let score = 0;
  const lastA = normaliseName(input.lastName);
  const lastB = normaliseName(c.lastName);
  const firstA = normaliseName(input.firstName);
  const firstB = normaliseName(c.firstName);
  if (input.birthDate === c.birthDate) {
    score += 0.35;
    matchedOn.push("dob");
  } else if (dobTransposed(input.birthDate, c.birthDate)) {
    score += 0.2;
    matchedOn.push("dob-transposed");
  }
  const lastSim = jaroWinkler(lastA, lastB);
  if (lastA === lastB) {
    score += 0.25;
    matchedOn.push("lastName");
  } else if (lastSim >= 0.88) {
    score += 0.18;
    matchedOn.push("lastName-similar");
  }
  const firstSim = jaroWinkler(firstA, firstB);
  if (firstA === firstB) {
    score += 0.2;
    matchedOn.push("firstName");
  } else if (
    firstSim >= 0.88 ||
    (firstA[0] === firstB[0] && (firstA.length === 1 || firstB.length === 1))
  ) {
    score += 0.12;
    matchedOn.push("firstName-similar");
  }
  if (input.phoneIndex && input.phoneIndex === c.phoneIndex) {
    score += 0.2;
    matchedOn.push("phone");
  }
  if (input.emailIndex && input.emailIndex === c.emailIndex) {
    score += 0.15;
    matchedOn.push("email");
  }
  if (input.ssnLast4 && input.ssnLast4 === c.ssnLast4) {
    score += 0.1;
    matchedOn.push("ssn4");
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), matchedOn };
}

export interface ParsedQuery {
  names: string[];
  birthDate?: string;
  phoneDigits?: string;
  mrn?: string;
}

/** Free-text search: "gonz mar", "Gonzalez, Maria", "03/14/1968", "312-555-0142", "100-482-17". */
export function parseSearch(q: string | undefined): ParsedQuery {
  const out: ParsedQuery = { names: [] };
  if (!q) return out;
  for (const raw of q.split(/[\s,]+/).filter(Boolean)) {
    const dob = parseDate(raw);
    if (dob) {
      out.birthDate = dob;
      continue;
    }
    const digits = raw.replace(/\D/g, "");
    if (/^\d{3}-\d{3}-\d{2}$/.test(raw) || /^\d{8}$/.test(raw)) {
      out.mrn =
        digits.length === 8
          ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
          : raw;
      continue;
    }
    if (digits.length >= 7 && digits.length === raw.replace(/[\s().+-]/g, "").length) {
      out.phoneDigits = digits;
      continue;
    }
    const n = normaliseName(raw);
    if (n) out.names.push(n);
  }
  return out;
}

export function parseDate(s: string): string | undefined {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return valid(m[3]!, m[1]!.padStart(2, "0"), m[2]!.padStart(2, "0"));
  return undefined;
}

function valid(y: string, mo: string, d: string): string | undefined {
  const iso = `${y}-${mo}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(iso) ? iso : undefined;
}

/** Age text for banners: "58 y", "14 mo", "9 d" (INV-ID-01 shows DOB + age). */
export function ageText(birthDate: Date, now = new Date(), deceasedAt?: Date | null): string {
  const end = deceasedAt ?? now;
  let years = end.getUTCFullYear() - birthDate.getUTCFullYear();
  const mDiff = end.getUTCMonth() - birthDate.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && end.getUTCDate() < birthDate.getUTCDate())) years--;
  if (years >= 2) return `${years} y`;
  const months =
    (end.getUTCFullYear() - birthDate.getUTCFullYear()) * 12 +
    mDiff -
    (end.getUTCDate() < birthDate.getUTCDate() ? 1 : 0);
  if (months >= 1) return `${months} mo`;
  return `${Math.max(0, Math.floor((end.getTime() - birthDate.getTime()) / 86_400_000))} d`;
}

export const isMinor = (birthDate: Date, now = new Date()) => {
  const a = ageText(birthDate, now);
  return !a.endsWith(" y") || Number(a.split(" ")[0]) < 18;
};

/** Labels that make a whole patient record restricted (INV-SEC-03). */
export const RESTRICTED_LABELS = ["R", "VIP", "42CFRPart2", "confidential", "restricted"];
export const isRestricted = (labels: string[]) => labels.some((l) => RESTRICTED_LABELS.includes(l));

export const displayName = (p: {
  firstName: string;
  lastName: string;
  middleName?: string | null;
  suffix?: string | null;
}) =>
  `${p.lastName}${p.suffix ? ` ${p.suffix}` : ""}, ${p.firstName}${p.middleName ? ` ${p.middleName}` : ""}`;

export const maskPhone = (digits: string | null | undefined) =>
  digits ? `•••-•••-${digits.replace(/\D/g, "").slice(-4)}` : undefined;
