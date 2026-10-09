#!/usr/bin/env node
// Dev only: prescribing scenarios through the real e-prescribing ingestion code (ingestErxEvent), for the Riverbend
// demo practice in the local emr_v2 DB. Run after `npm run build -w apps/api` and a seed:
//   node tools/rx-scenarios.mjs
// Creates: a lisinopril prescription Dr. Rao sent 10 months ago for Maria Gonzalez with a pharmacy renewal request
// (protocol passes), an atorvastatin renewal for Michael Lee (protocol fails: no recent visit), and a pharmacy
// rejection that returns as a change request (Aisha Patel).
import { existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV ??= "development";
if (process.env.NODE_ENV === "production")
  throw new Error("rx-scenarios is for local development only");

const api = (p) => import(new URL(`../apps/api/dist/${p}`, import.meta.url));
const { withTenant, withoutTenant } = await api("platform/tenant.js");
const { ingestErxEvent } = await api("modules/prescribing/requests.js");

const rows = await withoutTenant(
  (tx) =>
    tx.$queryRaw`SELECT "practiceId" FROM find_staff_users_for_login(${"provider@example.com"})`,
);
if (!rows.length) throw new Error("seeded provider not found; seed first");
const practiceId = rows[0].practiceId;
const day = 86_400_000;
const stamp = Date.now().toString(36);

await withTenant(practiceId, async (tx) => {
  const find = (first, last) =>
    tx.patient.findFirst({ where: { firstName: first, lastName: last, mergedIntoId: null } });
  const [maria, michael, aisha] = await Promise.all([
    find("Maria", "Gonzalez"),
    find("Michael", "Lee"),
    find("Aisha", "Patel"),
  ]);
  const rao = await tx.practitioner.findFirst({ where: { lastName: "Rao" } });
  const raoUser = rao.userId;
  const pharmacy = await tx.pharmacy.findUnique({ where: { ncpdpId: "9900011" } });

  async function sent(patient, rxcui, display, sig, qty, daysAgo) {
    const signedAt = new Date(Date.now() - daysAgo * day);
    const rx = await tx.medicationRequest.create({
      data: {
        practiceId,
        patientId: patient.id,
        prescriberId: rao.id,
        rxnormCode: rxcui,
        display,
        sigText: sig,
        quantity: qty,
        quantityUnit: "each",
        refills: 3,
        daysSupply: 90,
        pharmacyId: pharmacy.id,
        status: "ACTIVE",
        signedById: raoUser,
        signedAt,
        erxStatus: "SENT",
        erxMessageId: `SIMRX${stamp}${rxcui}`,
        createdAt: signedAt,
      },
    });
    const stmt = await tx.medicationStatement.findFirst({
      where: { patientId: patient.id, rxnormCode: rxcui, stagingStatus: "ACTIVE" },
    });
    if (stmt)
      await tx.medicationStatement.update({
        where: { id: stmt.id },
        data: { prescriptionId: rx.id },
      });
    else
      await tx.medicationStatement.create({
        data: {
          practiceId,
          patientId: patient.id,
          rxnormCode: rxcui,
          display,
          dosageText: sig,
          prescriptionId: rx.id,
          effectiveStart: signedAt,
        },
      });
    return rx;
  }
  const who = (p) => ({
    mrn: p.mrn,
    lastName: p.lastName,
    firstName: p.firstName,
    birthDate: p.birthDate.toISOString().slice(0, 10),
  });
  const renewal = (patient, rx, n) =>
    ingestErxEvent(tx, practiceId, {
      type: "RxRenewalRequest",
      eventId: `dev-${stamp}-${n}`,
      practiceId,
      pharmacyNcpdpId: pharmacy.ncpdpId,
      prescriptionId: rx.id,
      patient: who(patient),
      requested: { quantity: 90, daysSupply: 90, refills: 0 },
    });

  if (maria) {
    const rx = await sent(
      maria,
      "314077",
      "lisinopril 20 MG Oral Tablet",
      "1 tab by mouth daily",
      90,
      300,
    );
    await renewal(maria, rx, 1);
  }
  if (michael) {
    const rx = await sent(
      michael,
      "617311",
      "atorvastatin 40 MG Oral Tablet",
      "1 tab by mouth at bedtime",
      90,
      420,
    );
    await renewal(michael, rx, 2);
  }
  if (aisha) {
    const rx = await sent(
      aisha,
      "1650142",
      "doxycycline hyclate 100 MG Oral Tablet",
      "1 tab by mouth twice daily",
      20,
      2,
    );
    await ingestErxEvent(tx, practiceId, {
      type: "Error",
      eventId: `dev-${stamp}-3`,
      practiceId,
      messageId: rx.erxMessageId,
      code: "900",
      description: "Drug not stocked; please send an alternative",
    });
  }
});
console.log(
  "rx-scenarios: renewal (Maria Gonzalez), renewal (Michael Lee), change request (Aisha Patel) created.",
);
process.exit(0);
