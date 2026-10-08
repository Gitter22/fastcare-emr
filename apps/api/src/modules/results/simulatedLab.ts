import type { Tx } from "../../db.js";
import { fakeOru, isLabConnected } from "../../gateways/lab/index.js";
import { ingestLabMessage } from "./ingest.js";

/**
 * The simulated lab's turnaround (dev only, never in production or tests): orders it accepted are resulted a few
 * minutes after collection (in-office draws) or after sending (patient service center), and the ORU goes through
 * the same ingestion as a real lab's webhook. Values are in range, except A1c for patients with a diabetes
 * diagnosis, so the demo shows an abnormal result and a trend.
 */
export async function runSimulatedLab(
  tx: Tx,
  practiceId: string,
  now = new Date(),
  delayMs = 3 * 60_000,
) {
  if (!isLabConnected()) return 0;
  const cutoff = new Date(now.getTime() - delayMs);
  const due = await tx.serviceRequest.findMany({
    where: {
      category: "LAB",
      performerLab: { not: null },
      diagnosticReports: { none: {} },
      OR: [
        { status: "COLLECTED", collectedAt: { lt: cutoff } },
        { status: "SENT", collectionMode: { not: "IN_OFFICE" }, sentAt: { lt: cutoff } },
      ],
    },
    include: { patient: { include: { conditions: { where: { clinicalStatus: "ACTIVE" } } } } },
    take: 50,
  });
  for (const sr of due) {
    const p = sr.patient;
    const comp = sr.labCompendiumItemId
      ? await tx.labCompendiumItem.findUnique({ where: { id: sr.labCompendiumItemId } })
      : null;
    const diabetic = p.conditions.some((c) => c.icd10Code?.startsWith("E11"));
    const raw = fakeOru(
      {
        placerOrderNumber: sr.placerOrderNumber!,
        accessionNumber: sr.accessionNumber ?? "",
        testCode: comp?.testCode ?? sr.code,
        display: sr.display,
        loincCode: comp?.loincCode ?? sr.code,
        collectedAt: sr.collectedAt,
      },
      {
        practiceId,
        lab: sr.performerLab!,
        patient: {
          mrn: p.mrn,
          lastName: p.lastName,
          firstName: p.firstName,
          birthDate: p.birthDate.toISOString().slice(0, 10),
          sex: (p.sexForClinicalUse ?? p.administrativeGender).slice(0, 1),
        },
        values: diabetic ? { "4548-4": 7.4 } : undefined,
        at: now,
      },
    );
    await ingestLabMessage(tx, practiceId, "HEALTH_GORILLA", raw);
  }
  return due.length;
}
