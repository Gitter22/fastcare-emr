import argon2 from "argon2";

/**
 * Password policy (HIPAA §164.312(d), docs/10-hipaa-controls.md): argon2id hashes, minimum 12 characters, not a
 * known-breached password, not containing the user's name or email. The breached check uses a local list of the most
 * common leaked passwords; a k-anonymity lookup service is not one of agile-emr's integrations (see OPEN-Q15).
 */
const COMMON = new Set(
  `123456 123456789 12345678 password qwerty123 qwerty 1234567 111111 1234567890 123123 abc123 1234 password1 iloveyou
  1q2w3e4r 000000 qwerty1 123321 dragon sunshine princess letmein monkey football baseball welcome welcome1 admin admin123
  passw0rd password123 password1234 trustno1 superman batman master hello123 freedom whatever qazwsx 654321 michael
  shadow jessica 7777777 charlie aa123456 donald login starwars solo access flower hottie loveme zaq1zaq1 hello
  123qwe 1qaz2wsx changeme changeme123 healthcare hospital doctor123 nurse123 clinic123 medical123 summer2024 winter2024
  spring2025 summer2025 autumn2025 winter2025 spring2026 summer2026 password2024 password2025 password2026 p@ssw0rd
  p@ssword1 qwertyuiop asdfghjkl zxcvbnm 11111111 12341234 87654321 abcd1234 abcdef123 letmein123 welcome123
  iloveyou1 football1 baseball1 monkey123 dragon123`.split(/\s+/),
);

export const MIN_LENGTH = 12;
export type PasswordFailure = "minLength" | "breached" | "containsName" | "reused";

export function checkPassword(
  password: string,
  context: { email?: string; names?: string[] } = {},
) {
  const failures: PasswordFailure[] = [];
  if (password.length < MIN_LENGTH) failures.push("minLength");
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[!@#$%^&*.]+$/, "")))
    failures.push("breached");
  const tokens = [
    ...(context.names ?? []),
    ...(context.email ? [context.email.split("@")[0]!] : []),
  ]
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  if (tokens.some((t) => lower.includes(t))) failures.push("containsName");
  // Score 0-4: length and character variety (shown as a meter; policy decides pass/fail).
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(password)).length;
  const score = failures.length
    ? Math.min(1, variety)
    : Math.min(4, Math.floor(password.length / 6) + variety - 1);
  return { ok: failures.length === 0, score: Math.max(0, score), failures };
}

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) return false;
  return argon2.verify(hash, password).catch(() => false);
}

/** Constant-ish timing for unknown accounts. */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(await dummy, password);
}
