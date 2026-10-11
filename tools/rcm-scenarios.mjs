#!/usr/bin/env node
// Dev only: revenue-cycle scenarios through the real RCM code (release, scrub, 837P via the simulated
// clearinghouse, 277CA/835 ingestion, ERA posting), for the Riverbend demo practice in the local emr_v2 DB.
// Run after `npm run build -w apps/api` and a seed (bash tools/reset-local-db.sh):
//   node tools/rcm-scenarios.mjs
// Creates, for demo patients: 3 visits held in charge review (modifier 25, missing pointer, manual hold),
// paid / underpaid / denied / 277CA-rejected / 999-rejected claims, a ready claim, an unbalanced ERA with an
// unmatched claim and a recoupment (PLB), patient balances with a statement, and cash payments for day close.
import { existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV ??= "development";
if (process.env.NODE_ENV === "production")
  throw new Error("rcm-scenarios is for local development only");

const api = (p) => import(new URL(`../apps/api/dist/${p}`, import.meta.url));
const { withTenant, withoutTenant } = await api("platform/tenant.js");
const { encryptField } = await api("platform/crypto.js");
const { recomputeEdits, releaseEncounter } = await api("modules/rcm/charges.js");
const { submitBatch } = await api("modules/rcm/claims.js");
const { runSimulatedClearinghouse, ingestReport } = await api("modules/rcm/inbound.js");
const { simulated835 } = await api("gateways/clearinghouse/simulated.js");
const { takePayment } = await api("modules/billing/payments.js");

const rows = await withoutTenant(
  (tx) =>
    tx.$queryRaw`SELECT "practiceId" FROM find_staff_users_for_login(${"biller@example.com"})`,
);
if (!rows.length) throw new Error("seeded biller not found; seed first");
const practiceId = rows[0].practiceId;
const day = 86_400_000;
const SYSTEM = { userId: null, role: "system" };

const run = (fn) => withTenant(practiceId, fn);

const ctx = await run(async (tx) => {
  const rao = await tx.practitioner.findFirst({ where: { lastName: "Rao" } });
  const location = await tx.location.findFirst({ where: { placeOfService: "11" } });
  const payers = Object.fromEntries((await tx.payer.findMany()).map((p) => [p.name, p]));
  const frontdesk = await tx.user.findFirst({ where: { email: "frontdesk@example.com" } });
  return { rao, location, payers, frontdesk };
});

async function patient(tx, first, last) {
  const p = await tx.patient.findFirst({
    where: { firstName: first, lastName: last, mergedIntoId: null },
  });
  if (!p) throw new Error(`${first} ${last} not seeded`);
  if (!(await tx.patientAddress.findFirst({ where: { patientId: p.id } })))
    await tx.patientAddress.create({
      data: {
        practiceId,
        patientId: p.id,
        line1: "12 Elm St",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
      },
    });
  return p;
}

async function cover(tx, p, payerName, memberId) {
  await tx.coverage.updateMany({
    where: { patientId: p.id, status: "active" },
    data: { status: "cancelled" },
  });
  return tx.coverage.create({
    data: {
      practiceId,
      patientId: p.id,
      payerId: ctx.payers[payerName].id,
      memberId: encryptField(memberId),
      order: 1,
    },
  });
}

/** A finished visit `daysAgo` with diagnoses and DRAFT charge lines [{code, dx: [icd idx], mods?, noPointer?}]. */
async function visit(tx, p, daysAgo, dxCodes, lines) {
  const when = new Date(Date.now() - daysAgo * day);
  const enc = await tx.encounter.create({
    data: {
      practiceId,
      patientId: p.id,
      practitionerId: ctx.rao.id,
      locationId: ctx.location.id,
      status: "FINISHED",
      class: "AMB",
      placeOfService: "11",
      periodStart: when,
      periodEnd: when,
    },
  });
  const dx = [];
  for (const [i, [code, display]] of dxCodes.entries())
    dx.push(
      await tx.condition.create({
        data: {
          practiceId,
          patientId: p.id,
          encounterId: enc.id,
          category: "ENCOUNTER_DIAGNOSIS",
          icd10Code: code,
          display,
          rank: i + 1,
        },
      }),
    );
  const fees = await tx.feeScheduleItem.findMany({
    where: { feeSchedule: { payerId: null, isContract: false } },
  });
  const concepts = await tx.codeConcept.findMany({ where: { system: { in: ["CPT", "HCPCS"] } } });
  for (const l of lines) {
    const c = concepts.find((x) => x.code === l.code);
    await tx.chargeItem.create({
      data: {
        practiceId,
        patientId: p.id,
        encounterId: enc.id,
        codeSystem: c.system,
        code: l.code,
        description: c.display,
        modifiers: l.mods ?? [],
        units: 1,
        dxConditionIds: l.noPointer ? [] : l.dx.map((i) => dx[i].id),
        fee: fees.find((f) => f.code === l.code).amount,
        serviceDate: when,
        renderingPractitionerId: ctx.rao.id,
      },
    });
  }
  return enc;
}

const DM = ["E11.9", "Type 2 diabetes mellitus without complications"];
const HTN = ["I10", "Essential (primary) hypertension"];
const SINUS = ["J01.00", "Acute maxillary sinusitis, unspecified"];
const IMM = ["Z23", "Encounter for immunization"];
const LIPID = ["E78.5", "Hyperlipidemia, unspecified"];

await run(async (tx) => {
  const maria = await patient(tx, "Maria", "Gonzalez");
  const michael = await patient(tx, "Michael", "Lee");
  const aisha = await patient(tx, "Aisha", "Patel");
  const robert = await patient(tx, "Robert", "Johnson");
  const lucia = await patient(tx, "Lucia", "Hernandez");
  await cover(tx, maria, "Aetna", "W123456701");
  await cover(tx, michael, "Aetna", "W223456702-UNDERPAY");
  await cover(tx, aisha, "UnitedHealthcare", "U9876-DENY");
  await cover(tx, robert, "Medicare Part B (Illinois)", "1EG4TE5MK73-REJECT");
  await cover(tx, lucia, "Blue Cross Blue Shield of Illinois", "XOF55512");

  // Charge review: modifier 25 on Maria's visit (wireframe), a missing pointer, a manual hold.
  const held = [
    await visit(
      tx,
      maria,
      2,
      [DM, HTN, SINUS, IMM],
      [
        { code: "99214", dx: [0, 1, 2] },
        { code: "90686", dx: [3] },
        { code: "90471", dx: [3] },
        { code: "36415", dx: [0, 1] },
      ],
    ),
    await visit(tx, lucia, 3, [HTN], [{ code: "99213", dx: [0], noPointer: true }]),
    await visit(tx, michael, 6, [LIPID], [{ code: "99213", dx: [0] }]),
  ];
  for (const enc of held) {
    await recomputeEdits(tx, enc);
    await tx.chargeItem.updateMany({ where: { encounterId: enc.id }, data: { status: "HELD" } });
  }
  await tx.chargeItem.updateMany({
    where: { encounterId: held[2].id },
    data: { holdNote: "Waiting on referral number from PCP" },
  });

  // Claims through the simulated clearinghouse.
  const claimVisits = [
    await visit(tx, maria, 21, [HTN], [{ code: "99213", dx: [0] }]),
    await visit(tx, michael, 20, [LIPID], [{ code: "99214", dx: [0] }]),
    await visit(tx, aisha, 18, [SINUS], [{ code: "99213", dx: [0] }]),
    await visit(
      tx,
      robert,
      15,
      [DM],
      [
        { code: "99214", dx: [0] },
        { code: "83036", dx: [0] },
      ],
    ),
  ];
  for (const enc of claimVisits) await releaseEncounter(tx, enc, SYSTEM, "throw");
  await submitBatch(tx, practiceId, null, SYSTEM);
  const later = (m) => new Date(Date.now() + m * 60_000);
  await runSimulatedClearinghouse(tx, practiceId, later(1), 0); // 277CA: accept / reject (Robert)
  await runSimulatedClearinghouse(tx, practiceId, later(2), 0); // 835 for Aetna / UHC
  // Lucia's BCBS claim is paid on an ERA that also carries an unmatched claim and a recoupment (PLB).
  await releaseEncounter(
    tx,
    await visit(tx, lucia, 12, [HTN], [{ code: "99213", dx: [0] }]),
    SYSTEM,
    "throw",
  );
  await submitBatch(tx, practiceId, null, SYSTEM);
  await runSimulatedClearinghouse(tx, practiceId, later(3), 0); // 277CA accept only
  const luciaClaim = await tx.claim.findFirst({
    where: { patientId: lucia.id, status: "ACCEPTED" },
  });
  const pcn = luciaClaim.claimNumber.replace(/[^A-Za-z0-9]/g, "");
  const bcbs = ctx.payers["Blue Cross Blue Shield of Illinois"];
  const report = simulated835({
    traceNumber: `7731${Date.now().toString().slice(-4)}`,
    paymentDate: new Date().toISOString().slice(0, 10),
    payerName: bcbs.name,
    payerId: bcbs.clearinghousePayerId,
    claims: [
      {
        patientControlNumber: pcn,
        payerClaimControlNumber: "BC26X0001",
        memberId: "XOF55512",
        billed: 125,
        contractAllowed: 100,
      },
      {
        patientControlNumber: "CLM2600999",
        payerClaimControlNumber: "BC26X0002",
        memberId: "XOF000",
        billed: 165,
        contractAllowed: 132,
      },
    ],
    providerAdjustments: [{ reasonCode: "WO", reference: "CLM2600144", amount: 35 }],
  });
  await ingestReport(tx, practiceId, "835", `SIMDEMO-${Date.now()}`, report);

  // A 999 rejection (invalid member id at the clearinghouse) and a ready claim waiting for the next batch.
  const lee2 = await visit(tx, aisha, 9, [SINUS], [{ code: "99212", dx: [0] }]);
  await cover(tx, aisha, "UnitedHealthcare", "U9876-REJECT999");
  await releaseEncounter(tx, lee2, SYSTEM, "throw");
  await submitBatch(tx, practiceId, null, SYSTEM);
  await cover(tx, aisha, "UnitedHealthcare", "U9876-DENY");
  const ready = await visit(tx, maria, 1, [HTN], [{ code: "99212", dx: [0] }]);
  await releaseEncounter(tx, ready, SYSTEM, "throw");

  // Front-desk cash and check today (billing.day-close).
  for (const [p, amount, method] of [
    [maria, "25.00", "CASH"],
    [michael, "40.00", "CHECK"],
    [robert, "20.00", "CASH"],
  ])
    await takePayment(tx, {
      practiceId,
      patientId: p.id,
      amount,
      method,
      channel: "front-desk",
      locationId: ctx.location.id,
      takenById: ctx.frontdesk.id,
      idempotencyKey: `rcm-demo-${p.id}-${amount}`,
      ...(method === "CHECK" ? { checkNumber: "1042" } : {}),
    });
});

const summary = await run(async (tx) => {
  const by = await tx.claim.groupBy({ by: ["status"], _count: { _all: true } });
  const held = await tx.chargeItem.groupBy({ by: ["encounterId"], where: { status: "HELD" } });
  const remits = await tx.remittance.groupBy({ by: ["status"], _count: { _all: true } });
  return {
    claims: by.map((b) => `${b.status}:${b._count._all}`),
    held: held.length,
    remits: remits.map((r) => `${r.status}:${r._count._all}`),
  };
});
console.log(
  `rcm-scenarios: claims ${summary.claims.join(" ")}; held visits ${summary.held}; remittances ${summary.remits.join(" ")}`,
);
process.exit(0);
