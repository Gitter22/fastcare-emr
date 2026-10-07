import argon2 from "argon2";
import { npiWithCheckDigit } from "@agile-emr/shared";
import type { PrismaClient, Role } from "../../generated/prisma-client/index.js";
import { encryptField } from "../../apps/api/src/encryption.js";
import { blindIndex, encryptToBytes } from "../../apps/api/src/platform/crypto.js";

export const SEED_PASSWORD = "TestPassword123!";
export const SEED_TOTP_SECRET = "MIPW6N3DPZVXGHJ7";

interface StaffSeed {
  email: string;
  first: string;
  last: string;
  roles: Role[];
  practitioner?: { credential: string; npiBase: string; taxonomy: string; supervisedBy?: string };
}

const PRACTICES = {
  riverbend: {
    legalName: "Riverbend Family Medicine",
    tin: "84-1234567",
    groupNpi: npiWithCheckDigit("166799201"),
    taxonomy: "207Q00000X",
    address: { addressLine1: "200 Main St", city: "Riverbend", state: "IL", postalCode: "60601" },
    timezone: "America/Chicago",
    locations: [
      {
        name: "Main St",
        pos: "11",
        rooms: ["Room 1", "Room 2", "Room 3", "Room 4", "Lab draw", "Procedure"],
      },
      { name: "Northside", pos: "11", rooms: ["Room A", "Room B"] },
      { name: "Telehealth", pos: "10", rooms: [], virtual: true },
    ],
    staff: [
      { email: "manager@example.com", first: "Morgan", last: "Lee", roles: ["MANAGER"] },
      { email: "frontdesk@example.com", first: "Sam", last: "Ortiz", roles: ["FRONTDESK"] },
      { email: "ma@example.com", first: "Jamie", last: "Park", roles: ["MA"] },
      {
        email: "provider@example.com",
        first: "Priya",
        last: "Rao",
        roles: ["PROVIDER"],
        practitioner: { credential: "MD", npiBase: "198765432", taxonomy: "207Q00000X" },
      },
      {
        email: "np@example.com",
        first: "Alex",
        last: "Kim",
        roles: ["PROVIDER"],
        practitioner: {
          credential: "NP",
          npiBase: "176543210",
          taxonomy: "363LF0000X",
          supervisedBy: "provider@example.com",
        },
      },
      { email: "biller@example.com", first: "Chris", last: "Dunn", roles: ["BILLER"] },
      { email: "multi@example.com", first: "Taylor", last: "Reed", roles: ["FRONTDESK", "BILLER"] },
    ] as StaffSeed[],
  },
  second: {
    legalName: "Second Test Clinic",
    tin: "84-7654321",
    groupNpi: npiWithCheckDigit("155512345"),
    taxonomy: "207Q00000X",
    address: { addressLine1: "9 Elm Ave", city: "Springfield", state: "IL", postalCode: "62701" },
    timezone: "America/Chicago",
    locations: [{ name: "Elm Ave", pos: "11", rooms: ["Room 1"] }],
    staff: [
      { email: "admin2@example.com", first: "Riley", last: "Shaw", roles: ["MANAGER"] },
      {
        email: "provider2@example.com",
        first: "Jordan",
        last: "Blake",
        roles: ["PROVIDER"],
        practitioner: { credential: "DO", npiBase: "143219876", taxonomy: "207Q00000X" },
      },
    ] as StaffSeed[],
  },
} as const;

/** Fictional demo patients (names, DOBs and phones are made up). */
const PATIENTS = [
  {
    first: "Maria",
    middle: "L",
    last: "Gonzalez",
    preferred: "Maria",
    pronouns: "she/her",
    dob: "1968-03-14",
    gender: "FEMALE",
    phone: "312-555-0142",
    email: "maria.gonzalez@example.com",
    lang: "en",
  },
  {
    first: "Michael",
    last: "Lee",
    dob: "1979-11-02",
    gender: "MALE",
    phone: "312-555-0187",
    email: "m.lee@example.com",
    lang: "en",
  },
  {
    first: "Aisha",
    last: "Patel",
    dob: "1991-06-21",
    gender: "FEMALE",
    phone: "312-555-0110",
    email: "aisha.p@example.com",
    lang: "en",
  },
  {
    first: "Robert",
    last: "Johnson",
    dob: "1952-01-30",
    gender: "MALE",
    phone: "312-555-0199",
    lang: "en",
  },
  {
    first: "Lucia",
    last: "Hernandez",
    dob: "2014-09-12",
    gender: "FEMALE",
    phone: "312-555-0123",
    lang: "es",
    interpreter: true,
  },
  {
    first: "David",
    last: "Nguyen",
    dob: "1985-04-05",
    gender: "MALE",
    phone: "312-555-0164",
    email: "dnguyen@example.com",
    lang: "vi",
  },
  {
    first: "Emily",
    last: "Carter",
    dob: "1999-12-24",
    gender: "FEMALE",
    phone: "312-555-0131",
    email: "emily.c@example.com",
    lang: "en",
  },
  {
    first: "James",
    last: "Wilson",
    dob: "1960-07-17",
    gender: "MALE",
    phone: "312-555-0155",
    lang: "en",
  },
  {
    first: "Grace",
    last: "Kim",
    dob: "1973-02-08",
    gender: "FEMALE",
    phone: "312-555-0176",
    email: "grace.kim@example.com",
    lang: "ko",
  },
  {
    first: "Omar",
    last: "Haddad",
    dob: "1988-10-30",
    gender: "MALE",
    phone: "312-555-0108",
    lang: "ar",
  },
  {
    first: "Maria",
    last: "Gonzales",
    dob: "1968-03-14",
    gender: "FEMALE",
    phone: "312-555-0142",
    lang: "en",
  }, // likely duplicate of #1
] as const;

const PAYERS = [
  {
    name: "Aetna",
    clearinghousePayerId: "60054",
    plans: [
      { name: "Aetna PPO", type: "commercial" },
      { name: "Aetna HMO", type: "commercial", referralRequired: true },
    ],
  },
  {
    name: "Blue Cross Blue Shield of Illinois",
    clearinghousePayerId: "00621",
    plans: [{ name: "BCBS PPO", type: "commercial" }],
  },
  {
    name: "Medicare Part B (Illinois)",
    clearinghousePayerId: "00952",
    timelyFilingDays: 365,
    plans: [{ name: "Medicare Part B", type: "medicare" }],
  },
  {
    name: "Illinois Medicaid",
    clearinghousePayerId: "ILMCD",
    plans: [{ name: "Medicaid", type: "medicaid" }],
  },
  {
    name: "UnitedHealthcare",
    clearinghousePayerId: "87726",
    plans: [{ name: "UHC Choice Plus", type: "commercial" }],
  },
];

export async function seedDemoPractice(
  prisma: PrismaClient,
  key: keyof typeof PRACTICES,
): Promise<void> {
  const def = PRACTICES[key];
  const existing = await prisma.practice.findFirst({ where: { tin: def.tin } });
  if (existing) {
    console.log(`Demo practice ${def.legalName} exists; skipped.`);
    return;
  }
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });
  const practice = await prisma.practice.create({
    data: {
      legalName: def.legalName,
      tin: encryptField(def.tin),
      groupNpi: def.groupNpi,
      taxonomyCode: def.taxonomy,
      timezone: def.timezone,
      phone: "312-555-0100",
      ...def.address,
    },
  });
  const practiceId = practice.id;

  const settings: Record<string, unknown> = {
    "security.sessionTimeoutMinutes": 15,
    "security.absoluteTimeoutHours": 12,
    "security.mfaRequired": true,
    "security.breakGlassMinutes": 60,
    "chart.maxOpenCharts": 3,
    "schedule.waitTargetMinutes": 15,
    "schedule.slotMinutes": 15,
    "inbox.slaHours": { CLINICAL: 24, REFILL: 48, BILLING: 72, SCHEDULING: 24, OTHER: 72 },
    "portal.resultReleasePolicy": { mode: "immediate" },
    "portal.proxyEndsAtAge": 12,
  };
  for (const [k, value] of Object.entries(settings)) {
    await prisma.practiceSetting.create({ data: { practiceId, key: k, value: value as object } });
  }

  const locations = [];
  for (const l of def.locations) {
    const loc = await prisma.location.create({
      data: {
        practiceId,
        name: l.name,
        placeOfService: l.pos,
        ...def.address,
        phone: "312-555-0100",
        fax: "312-555-0101",
      },
    });
    locations.push(loc);
    for (const r of l.rooms)
      await prisma.room.create({
        data: {
          practiceId,
          locationId: loc.id,
          name: r,
          equipment: r === "Lab draw" ? ["phlebotomy chair", "centrifuge"] : [],
        },
      });
    if ("virtual" in l && l.virtual)
      await prisma.room.create({
        data: { practiceId, locationId: loc.id, name: "Virtual room", isVirtual: true },
      });
  }

  const users = new Map<string, string>();
  const practitioners = new Map<string, string>();
  for (const s of def.staff) {
    const u = await prisma.user.create({
      data: {
        practiceId,
        email: s.email,
        firstName: s.first,
        lastName: s.last,
        status: "ACTIVE",
        passwordHash,
        passwordChangedAt: new Date(),
        mfaEnrolledAt: new Date(),
        activeRole: s.roles[0],
        roles: { create: s.roles.map((role) => ({ practiceId, role })) },
      },
    });
    users.set(s.email, u.id);
    await prisma.mfaFactor.create({
      data: {
        practiceId,
        userId: u.id,
        type: "TOTP",
        label: "Authenticator app",
        secret: encryptToBytes(SEED_TOTP_SECRET),
        verifiedAt: new Date(),
      },
    });
    if (s.practitioner) {
      const p = await prisma.practitioner.create({
        data: {
          practiceId,
          userId: u.id,
          firstName: s.first,
          lastName: s.last,
          credential: s.practitioner.credential,
          npi: npiWithCheckDigit(s.practitioner.npiBase),
          taxonomyCode: s.practitioner.taxonomy,
          supervisingId: s.practitioner.supervisedBy
            ? practitioners.get(s.practitioner.supervisedBy)
            : undefined,
        },
      });
      practitioners.set(s.email, p.id);
      await prisma.practitionerLicense.create({
        data: {
          practiceId,
          practitionerId: p.id,
          state: "IL",
          number: `036.${s.practitioner.npiBase.slice(0, 6)}`,
          type: s.practitioner.credential === "NP" ? "APRN" : "Physician and Surgeon",
          expiresOn: new Date("2028-07-31"),
        },
      });
    }
  }
  for (const loc of locations) {
    for (const uid of users.values())
      await prisma.userLocation.create({ data: { practiceId, userId: uid, locationId: loc.id } });
  }

  // Care-team, front-desk, billing and referrals pools (glossary: WorkPool).
  const pools: Array<{ name: string; kind: string; slaHours: number; members: string[] }> = [
    {
      name: key === "riverbend" ? "Dr Rao care team" : "Care team",
      kind: "care-team",
      slaHours: 24,
      members: [...def.staff]
        .filter((s) => s.roles.some((r) => r === "MA" || r === "PROVIDER"))
        .map((s) => s.email),
    },
    {
      name: "Front desk",
      kind: "front-desk",
      slaHours: 24,
      members: def.staff
        .filter((s) => s.roles.includes("FRONTDESK" as Role) || s.roles.includes("MANAGER" as Role))
        .map((s) => s.email),
    },
    {
      name: "Billing",
      kind: "billing",
      slaHours: 72,
      members: def.staff
        .filter((s) => s.roles.includes("BILLER" as Role) || s.roles.includes("MANAGER" as Role))
        .map((s) => s.email),
    },
    {
      name: "Referrals",
      kind: "referrals",
      slaHours: 48,
      members: def.staff.filter((s) => s.roles.includes("FRONTDESK" as Role)).map((s) => s.email),
    },
  ];
  for (const p of pools) {
    const pool = await prisma.workPool.create({
      data: { practiceId, name: p.name, kind: p.kind, slaHours: p.slaHours },
    });
    for (const m of p.members)
      await prisma.workPoolMember.create({
        data: { practiceId, poolId: pool.id, userId: users.get(m)! },
      });
  }

  if (key === "riverbend" && practitioners.get("np@example.com")) {
    await prisma.cosignRule.create({
      data: {
        practiceId,
        practitionerId: practitioners.get("np@example.com")!,
        supervisorId: practitioners.get("provider@example.com")!,
        appliesTo: ["note"],
        criteria: { newPatient: true },
        state: "IL",
      },
    });
  }

  for (const p of PAYERS) {
    const payer = await prisma.payer.create({
      data: {
        practiceId,
        name: p.name,
        clearinghousePayerId: p.clearinghousePayerId,
        timelyFilingDays: p.timelyFilingDays ?? 90,
      },
    });
    for (const plan of p.plans)
      await prisma.payerPlan.create({
        data: {
          practiceId,
          payerId: payer.id,
          name: plan.name,
          type: plan.type,
          referralRequired: "referralRequired" in plan ? !!plan.referralRequired : false,
        },
      });
  }

  // Patients (Riverbend only gets the full list; the isolation practice gets one look-alike).
  const list = key === "riverbend" ? PATIENTS : PATIENTS.slice(0, 1);
  let mrnSeq = key === "riverbend" ? 10048200 : 50010000;
  const pcp = [...practitioners.values()][0] ?? null;
  for (const p of list) {
    mrnSeq += 1;
    const patient = await prisma.patient.create({
      data: {
        practiceId,
        mrn: formatMrn(mrnSeq),
        firstName: p.first,
        middleName: "middle" in p ? p.middle : null,
        lastName: p.last,
        preferredName: "preferred" in p ? p.preferred : null,
        pronouns: "pronouns" in p ? p.pronouns : null,
        birthDate: new Date(`${p.dob}T00:00:00Z`),
        administrativeGender: p.gender,
        sexForClinicalUse: p.gender === "FEMALE" ? "FEMALE" : "MALE",
        preferredLanguage: p.lang,
        interpreterNeeded: "interpreter" in p ? !!p.interpreter : false,
        pcpPractitionerId: pcp,
        codeStatus: "full-code",
        raceCodes: [],
        ethnicityCodes: [],
        securityLabels: [],
        addresses: {
          create: [
            {
              practiceId,
              line1: `${100 + (mrnSeq % 900)} Lake St`,
              city: "Riverbend",
              state: "IL",
              postalCode: "60601",
            },
          ],
        },
        contactPoints: {
          create: [
            {
              practiceId,
              system: "PHONE",
              use: "MOBILE",
              value: encryptField(p.phone),
              valueIndex: blindIndex("phone", p.phone),
              rank: 1,
            },
            ...("email" in p && p.email
              ? [
                  {
                    practiceId,
                    system: "EMAIL" as const,
                    use: "HOME" as const,
                    value: encryptField(p.email),
                    valueIndex: blindIndex("email", p.email),
                    rank: 1,
                  },
                ]
              : []),
          ],
        },
      },
    });
    await prisma.patientIdentifier.create({
      data: {
        practiceId,
        patientId: patient.id,
        system: `urn:agile-emr:mrn:${practiceId}`,
        value: patient.mrn,
        type: "MR",
      },
    });
  }
  console.log(
    `Seeded demo practice ${def.legalName}: ${users.size} users, ${list.length} patients.`,
  );
}

/** MRN display format: 100-482-17 style (digits grouped for read-back over the phone). */
export function formatMrn(n: number): string {
  const s = String(n).padStart(8, "0");
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
}
