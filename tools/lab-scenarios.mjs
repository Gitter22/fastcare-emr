#!/usr/bin/env node
// Dev only: results-flow scenarios through the real ingestion code (gateways/lab ORU -> ingestLabMessage), for the
// Riverbend demo practice in the local emr_v2 DB. Run after `npm run build -w apps/api` and a seed:
//   node tools/lab-scenarios.mjs
// Creates: a critical potassium (Michael Lee), an unmatched result with a misspelled name (Aisha Patel), a normal CMP
// and an abnormal A1c awaiting review (Maria Gonzalez), and an overdue TSH order (Maria Gonzalez).
import { existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV ??= "development";
if (process.env.NODE_ENV === "production")
  throw new Error("lab-scenarios is for local development only");

const api = (p) => import(new URL(`../apps/api/dist/${p}`, import.meta.url));
const { prisma } = await api("db.js");
const { withTenant, withoutTenant } = await api("platform/tenant.js");
const { fakeOru } = await api("gateways/lab/index.js");
const { ingestLabMessage } = await api("modules/results/ingest.js");
const { newPlacerOrderNumber } = await api("modules/orders/lab.js");

// The Riverbend demo practice is the one the seeded provider@example.com belongs to (tenant lookup under RLS).
const rows = await withoutTenant(
  (tx) =>
    tx.$queryRaw`SELECT "practiceId" FROM find_staff_users_for_login(${"provider@example.com"})`,
);
if (!rows.length) throw new Error("seeded provider not found; seed first");
const practice = { id: rows[0].practiceId };

const day = 86_400_000;
const ident = (p) => ({
  mrn: p.mrn,
  lastName: p.lastName,
  firstName: p.firstName,
  birthDate: p.birthDate.toISOString().slice(0, 10),
  sex: (p.sexForClinicalUse ?? p.administrativeGender).slice(0, 1),
});

await withTenant(practice.id, async (tx) => {
  const find = (first, last) =>
    tx.patient.findFirst({ where: { firstName: first, lastName: last, mergedIntoId: null } });
  const [maria, michael, aisha] = await Promise.all([
    find("Maria", "Gonzalez"),
    find("Michael", "Lee"),
    find("Aisha", "Patel"),
  ]);
  const rao = await tx.practitioner.findFirst({ where: { lastName: "Rao" } });

  async function sentOrder(patient, loinc, { expectedBy, daysAgo = 1, inOffice = false } = {}) {
    const comp = await tx.labCompendiumItem.findFirst({
      where: { loincCode: loinc, lab: "QUEST" },
    });
    const dx = await tx.condition.findFirst({
      where: { patientId: patient.id, clinicalStatus: "ACTIVE" },
    });
    const signedAt = new Date(Date.now() - daysAgo * day);
    const sr = await tx.serviceRequest.create({
      data: {
        practiceId: practice.id,
        patientId: patient.id,
        category: "LAB",
        codeSystem: "LOINC",
        code: loinc,
        display: comp.display,
        labCompendiumItemId: comp.id,
        performerLab: "QUEST",
        status: "SENT",
        // In-office draws wait for collection, so the simulated lab never results them on its own.
        collectionMode: inOffice ? "IN_OFFICE" : "PATIENT_SERVICE_CENTER",
        expectedBy: expectedBy ?? new Date(Date.now() + 10 * day),
        placerOrderNumber: newPlacerOrderNumber(),
        accessionNumber: `FK${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        signedById: rao.userId,
        signedAt,
        sentAt: signedAt,
        pendedById: rao.userId,
        createdAt: signedAt,
      },
    });
    if (dx)
      await tx.serviceRequestReason.create({
        data: { practiceId: practice.id, serviceRequestId: sr.id, conditionId: dx.id },
      });
    return { sr, comp };
  }

  const result = (patient, { sr, comp }, opts = {}) =>
    ingestLabMessage(
      tx,
      practice.id,
      "HEALTH_GORILLA",
      fakeOru(
        {
          placerOrderNumber: sr.placerOrderNumber,
          accessionNumber: sr.accessionNumber,
          testCode: comp.testCode,
          display: comp.display,
          loincCode: comp.loincCode,
          collectedAt: new Date(Date.now() - 6 * 3_600_000),
        },
        {
          practiceId: practice.id,
          lab: "QUEST",
          patient: opts.identity ?? ident(patient),
          values: opts.values,
        },
      ),
    );

  const k = await result(michael, await sentOrder(michael, "2823-3"), {
    values: { "2823-3": 6.4 },
  });
  const cmp = await result(maria, await sentOrder(maria, "24323-8"));
  const a1c = await result(maria, await sentOrder(maria, "4548-4"), { values: { "4548-4": 7.8 } });
  const typo = await result(aisha, await sentOrder(aisha, "57698-3"), {
    identity: { ...ident(aisha), lastName: "Patell" },
  });
  await sentOrder(maria, "3016-3", {
    expectedBy: new Date(Date.now() - 9 * day),
    daysAgo: 30,
    inOffice: true,
  });
  console.log(
    `critical K filed: ${k.filed.length}, CMP filed: ${cmp.filed.length}, A1c filed: ${a1c.filed.length}, ` +
      `unmatched: ${typo.unmatched.length}, overdue TSH order: 1`,
  );
});
await prisma.$disconnect();
