import type { Patient, PatientContactPoint, Prisma, Tx } from "../../db.js";
import {
  blindIndex,
  decryptField,
  decryptOptionalField,
  encryptField,
  encryptOptionalField,
  normaliseContact,
} from "../../platform/crypto.js";
import { RESTRICTED_LABELS } from "../../platform/patientAccess.js";
import {
  BLOCK_THRESHOLD,
  SHOW_THRESHOLD,
  displayName,
  isMinor,
  maskPhone,
  normaliseName,
  scoreCandidate,
  type IdentityInput,
} from "./domain.js";

/** Read models and commands for Patient identity (patients.*, chart.demographics). */

type ContactLike = Pick<PatientContactPoint, "system" | "value" | "rank" | "use">;

export function primaryPhone(contacts: ContactLike[]): string | null {
  const phones = contacts
    .filter((c) => c.system === "PHONE" || c.system === "SMS")
    .sort((a, b) => a.rank - b.rank);
  const mobile = phones.find((c) => c.use === "MOBILE") ?? phones[0];
  return mobile ? decryptField(mobile.value) : null;
}

export function primaryEmail(contacts: ContactLike[]): string | null {
  const e = contacts.filter((c) => c.system === "EMAIL").sort((a, b) => a.rank - b.rank)[0];
  return e ? decryptField(e.value) : null;
}

export function patientFlags(
  p: Pick<
    Patient,
    "deceasedAt" | "securityLabels" | "active" | "mergedIntoId" | "birthDate" | "interpreterNeeded"
  >,
): string[] {
  const flags: string[] = [];
  if (p.deceasedAt) flags.push("deceased");
  if (p.securityLabels.some((l) => RESTRICTED_LABELS.includes(l))) flags.push("restricted");
  if (p.securityLabels.includes("42CFRPart2")) flags.push("part2");
  if (!p.active) flags.push("inactive");
  if (p.mergedIntoId) flags.push("merged");
  if (isMinor(p.birthDate)) flags.push("minor");
  if (p.interpreterNeeded) flags.push("interpreter");
  return flags;
}

/** PatientSummary rows (DOB on every row, INV-ID-01). Never decrypts more than the masked phone. */
export async function summaries(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.patient.findMany({
    where: { id: { in: ids } },
    include: { contactPoints: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map(toSummary);
}

export function toSummary(p: Patient & { contactPoints: ContactLike[] }) {
  const phone = primaryPhone(p.contactPoints);
  return {
    id: p.id,
    mrn: p.mrn,
    name: displayName(p),
    ...(p.preferredName ? { preferredName: p.preferredName } : {}),
    birthDate: p.birthDate.toISOString().slice(0, 10),
    ...(p.sexForClinicalUse ? { sexForClinicalUse: p.sexForClinicalUse } : {}),
    ...(phone ? { phoneMasked: maskPhone(phone) } : {}),
    flags: patientFlags(p),
  };
}

export interface SearchInput {
  names: string[];
  birthDate?: string;
  phoneDigits?: string;
  mrn?: string;
  limit: number;
  offset: number;
  includeInactive?: boolean;
}

/**
 * Fuzzy patient search (patients.search). Name tokens match first/last names by prefix, trigram similarity or
 * Soundex; DOB, MRN and phone (blind index over the encrypted value) match exactly. Ranked by how well names match.
 * RLS limits rows to the caller's practice.
 */
export async function searchPatientIds(tx: Tx, s: SearchInput): Promise<string[]> {
  const conds: Prisma.Sql[] = [];
  const { Prisma: P } = await import("../../db.js");
  if (!s.includeInactive) conds.push(P.sql`p."mergedIntoId" IS NULL`);
  if (s.birthDate) conds.push(P.sql`p."birthDate" = ${s.birthDate}::date`);
  if (s.mrn) conds.push(P.sql`p.mrn = ${s.mrn}`);
  if (s.phoneDigits) {
    const idx = blindIndex("phone", s.phoneDigits);
    conds.push(
      P.sql`EXISTS (SELECT 1 FROM "PatientContactPoint" c WHERE c."patientId" = p.id AND c."valueIndex" = ${idx})`,
    );
  }
  for (const n of s.names) {
    const like = `${n}%`;
    conds.push(P.sql`(
      lower(p."lastName") LIKE ${like} OR lower(p."firstName") LIKE ${like} OR lower(coalesce(p."preferredName", '')) LIKE ${like}
      OR similarity(lower(p."lastName"), ${n}) > 0.45 OR similarity(lower(p."firstName"), ${n}) > 0.5
      OR (length(${n}) >= 3 AND (soundex(p."lastName") = soundex(${n}) OR soundex(p."firstName") = soundex(${n}))))`);
  }
  if (!conds.length) return [];
  const rank = s.names.length
    ? P.sql`(${P.join(
        s.names.map(
          (
            n,
          ) => P.sql`greatest(similarity(lower(p."lastName"), ${n}), similarity(lower(p."firstName"), ${n}),
            CASE WHEN lower(p."lastName") LIKE ${`${n}%`} OR lower(p."firstName") LIKE ${`${n}%`} THEN 1 ELSE 0 END)`,
        ),
        " + ",
      )})`
    : P.sql`NULL::int`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Patient" p
    WHERE ${P.join(conds, " AND ")}
    ORDER BY ${rank} DESC, p."lastName", p."firstName", p.id
    LIMIT ${s.limit} OFFSET ${s.offset}`;
  return rows.map((r) => r.id);
}

/** INV-ID-02: possible existing patients for an identity, scored and ordered. */
export async function findDuplicates(
  tx: Tx,
  input: {
    firstName: string;
    lastName: string;
    birthDate: string;
    phone?: string | null;
    email?: string | null;
    ssnLast4?: string | null;
  },
  excludeId?: string,
) {
  const { Prisma: P } = await import("../../db.js");
  const phoneIndex = input.phone ? blindIndex("phone", input.phone) : null;
  const emailIndex = input.email ? blindIndex("email", input.email) : null;
  const last = normaliseName(input.lastName);
  const first = normaliseName(input.firstName);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Patient" p
    WHERE p."mergedIntoId" IS NULL ${excludeId ? P.sql`AND p.id <> ${excludeId}::uuid` : P.empty} AND (
      p."birthDate" = ${input.birthDate}::date
      OR (similarity(lower(p."lastName"), ${last}) > 0.5 AND similarity(lower(p."firstName"), ${first}) > 0.4)
      ${phoneIndex ? P.sql`OR EXISTS (SELECT 1 FROM "PatientContactPoint" c WHERE c."patientId" = p.id AND c."valueIndex" = ${phoneIndex})` : P.empty}
      ${emailIndex ? P.sql`OR EXISTS (SELECT 1 FROM "PatientContactPoint" c WHERE c."patientId" = p.id AND c."valueIndex" = ${emailIndex})` : P.empty}
    )
    LIMIT 200`;
  if (!rows.length) return [];
  const candidates = await tx.patient.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: { contactPoints: true },
  });
  const probe: IdentityInput = { ...input, phoneIndex, emailIndex };
  return candidates
    .map((c) => {
      const idx = (sys: string) =>
        c.contactPoints.filter((x) => x.system === sys).map((x) => x.valueIndex);
      const phoneHit =
        phoneIndex && idx("PHONE").concat(idx("SMS")).includes(phoneIndex) ? phoneIndex : null;
      const emailHit = emailIndex && idx("EMAIL").includes(emailIndex) ? emailIndex : null;
      const s = scoreCandidate(probe, {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        birthDate: c.birthDate.toISOString().slice(0, 10),
        phoneIndex: phoneHit,
        emailIndex: emailHit,
        ssnLast4: c.ssnLast4,
      });
      return { patient: toSummary(c), ...s };
    })
    .filter((c) => c.score >= SHOW_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export const isBlocking = (cands: Array<{ score: number }>) =>
  cands.some((c) => c.score >= BLOCK_THRESHOLD);

/** Next practice-unique MRN, serialised by an advisory lock (100-482-17 style). */
export async function nextMrn(tx: Tx, practiceId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"mrn:" + practiceId}))`;
  const r = await tx.$queryRaw<{ n: bigint | null }[]>`
    SELECT max(replace(mrn, '-', '')::bigint) AS n FROM "Patient" WHERE mrn ~ '^[0-9-]+$'`;
  const next = Number(r[0]?.n ?? 10000000n) + 1;
  const s = String(next).padStart(8, "0");
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
}

export function contactData(
  practiceId: string,
  patientId: string,
  c: {
    system: PatientContactPoint["system"];
    use?: PatientContactPoint["use"] | null;
    value: string;
    rank?: number;
    verifiedAt?: string | null;
    smsOptOut?: boolean;
  },
) {
  const kind = c.system === "EMAIL" ? "email" : c.system === "FAX" ? null : "phone";
  const value = kind ? normaliseContact(kind, c.value) : c.value.trim();
  const stored = kind === "phone" ? formatPhone(value) : value;
  return {
    practiceId,
    patientId,
    system: c.system,
    use: c.use ?? null,
    value: encryptField(stored),
    valueIndex: kind ? blindIndex(kind, value) : null,
    rank: c.rank ?? 1,
    verifiedAt: c.verifiedAt ? new Date(c.verifiedAt) : null,
    smsOptOut: c.smsOptOut ?? false,
  };
}

export const formatPhone = (digits: string) =>
  digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;

export function decryptContact<T extends { value: string }>(c: T): T {
  return { ...c, value: decryptField(c.value) };
}

export function decryptRelated<T extends { phone: string | null; email: string | null }>(r: T): T {
  return {
    ...r,
    phone: decryptOptionalField(r.phone) ?? null,
    email: decryptOptionalField(r.email) ?? null,
  };
}

export function relatedData(r: { phone?: string | null; email?: string | null }) {
  return {
    ...(r.phone !== undefined
      ? {
          phone:
            encryptOptionalField(
              r.phone ? formatPhone(normaliseContact("phone", r.phone)) : r.phone,
            ) ?? null,
        }
      : {}),
    ...(r.email !== undefined
      ? {
          email:
            encryptOptionalField(r.email ? normaliseContact("email", r.email) : r.email) ?? null,
        }
      : {}),
  };
}

/** PatientDetail for getPatient / createPatient / updatePatient. */
export async function patientDetail(tx: Tx, id: string) {
  const p = await tx.patient.findUniqueOrThrow({
    where: { id },
    include: {
      addresses: true,
      contactPoints: { orderBy: [{ system: "asc" }, { rank: "asc" }] },
      identifiers: true,
      relatedPersons: { where: { active: true } },
      preferredPharmacy: true,
    },
  });
  const access = await tx.portalAccess.findFirst({
    where: { patientId: id, relationship: "SELF", revokedAt: null },
    include: { portalUser: true },
  });
  const portalStatus = !access
    ? "none"
    : access.portalUser.status === "ACTIVE"
      ? "active"
      : access.portalUser.status === "LOCKED"
        ? "locked"
        : "invited";
  return {
    ...p,
    contactPoints: p.contactPoints.map(decryptContact),
    relatedPersons: p.relatedPersons.map(decryptRelated),
    preferredPharmacy: p.preferredPharmacy ?? undefined,
    portalStatus: portalStatus as "none" | "invited" | "active" | "locked",
  };
}

/** Patient fields a merge may take from either record (MergeRequest.fieldChoices). */
export const MERGEABLE_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "suffix",
  "preferredName",
  "birthDate",
  "administrativeGender",
  "sexForClinicalUse",
  "genderIdentity",
  "pronouns",
  "sexualOrientation",
  "preferredLanguage",
  "interpreterNeeded",
  "maritalStatus",
  "pcpPractitionerId",
  "preferredPharmacyId",
  "codeStatus",
  "ssnLast4",
] as const;

export function fieldText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
