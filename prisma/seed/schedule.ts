import type { PrismaClient } from "../../generated/prisma-client/index.js";
import { encryptField } from "../../apps/api/src/encryption.js";
import { addDays, dayRange, localParts, zonedToUtc } from "../../apps/api/src/platform/time.js";

/**
 * Scheduling demo data for the demo practices: visit types, provider templates, coverages, consents and a demo
 * day (today + tomorrow). `ensureDemoDay` runs on every seed and only adds appointments when today has none, so a
 * long-running dev environment always has a realistic day to work with.
 */
const VISIT_TYPES = [
  {
    name: "New patient",
    durationMinutes: 40,
    newPatientOnly: true,
    onlineBookable: true,
    color: "#145c48",
    modalities: ["IN_PERSON"],
  },
  {
    name: "Follow-up",
    durationMinutes: 20,
    onlineBookable: true,
    color: "#353b37",
    modalities: ["IN_PERSON", "VIDEO"],
  },
  {
    name: "Sick visit",
    durationMinutes: 20,
    onlineBookable: true,
    color: "#7a4f00",
    modalities: ["IN_PERSON", "VIDEO"],
  },
  {
    name: "Annual wellness",
    durationMinutes: 40,
    onlineBookable: true,
    color: "#0f4a3a",
    modalities: ["IN_PERSON"],
  },
  {
    name: "Lab draw",
    durationMinutes: 10,
    onlineBookable: false,
    color: "#565e59",
    modalities: ["IN_PERSON"],
  },
] as const;

const WEEKDAY_WINDOWS = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, start: "08:00", end: "12:00", visitTypeIds: [], overbook: 0 },
  { weekday, start: "13:00", end: "17:00", visitTypeIds: [], overbook: 0 },
]);

export async function seedScheduling(prisma: PrismaClient, practiceId: string): Promise<void> {
  const exists = await prisma.visitType.findFirst({ where: { practiceId } });
  if (exists) return;
  const vts = [];
  for (const v of VISIT_TYPES)
    vts.push(
      await prisma.visitType.create({
        data: {
          practiceId,
          ...v,
          modalities: [...v.modalities],
          defaultCptHints: [],
          previsitQuestionnaireIds: [],
        },
      }),
    );
  const practitioners = await prisma.practitioner.findMany({ where: { practiceId } });
  const loc = await prisma.location.findFirst({
    where: { practiceId, placeOfService: "11" },
    orderBy: { name: "asc" },
  });
  if (!loc) return;
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const p of practitioners) {
    await prisma.scheduleTemplate.create({
      data: {
        practiceId,
        practitionerId: p.id,
        locationId: loc.id,
        effectiveFrom: new Date(`${from}T00:00:00Z`),
        slots: WEEKDAY_WINDOWS,
      },
    });
  }
  const payers = await prisma.payer.findMany({ where: { practiceId }, include: { plans: true } });
  const patients = await prisma.patient.findMany({
    where: { practiceId },
    orderBy: { mrn: "asc" },
  });
  const memberIds = [
    "W123456789",
    "XQ88201734",
    "MBI1EG4TE5MK73",
    "IL9988776",
    "W987654321-INACTIVE",
    null,
    "U5544332",
    "W5550001",
    "IL1112223",
    null,
    "W123456789",
  ];
  for (const [i, pt] of patients.entries()) {
    const memberId = memberIds[i % memberIds.length];
    if (memberId) {
      const payer = payers[i % payers.length]!;
      await prisma.coverage.create({
        data: {
          practiceId,
          patientId: pt.id,
          payerId: payer.id,
          planId: payer.plans[0]?.id ?? null,
          order: 1,
          memberId: encryptField(memberId),
          groupNumber: i % 2 ? `G${1000 + i}` : null,
        },
      });
    }
    if (i % 3 !== 2) {
      for (const type of ["NOTICE_OF_PRIVACY_PRACTICES", "FINANCIAL_POLICY", "SMS_TCPA"] as const) {
        await prisma.consent.create({
          data: {
            practiceId,
            patientId: pt.id,
            type,
            status: "ACTIVE",
            signedAt: new Date(Date.now() - 200 * 86_400_000),
            signedBy: `${pt.firstName} ${pt.lastName}`,
            method: "tablet",
          },
        });
      }
    }
  }
  // A prior patient balance for the first patient (ledger is the only source of balances, INV-FIN-02).
  if (patients[0]) {
    await prisma.ledgerEntry.create({
      data: {
        practiceId,
        patientId: patients[0].id,
        type: "CHARGE",
        responsibility: "PATIENT",
        amount: "40.00",
        memo: "Patient responsibility, prior visit (demo)",
      },
    });
  }
  void vts;
}

/** Today's and tomorrow's appointments for the demo practice, if today has none yet. */
export async function ensureDemoDay(prisma: PrismaClient, practiceId: string): Promise<void> {
  const practice = await prisma.practice.findUnique({ where: { id: practiceId } });
  if (!practice) return;
  const tz = practice.timezone;
  const today = localParts(new Date(), tz).date;
  const { start, end } = dayRange(today, tz);
  if (await prisma.appointment.findFirst({ where: { practiceId, start: { gte: start, lt: end } } }))
    return;
  const loc = await prisma.location.findFirst({
    where: { practiceId, placeOfService: "11" },
    orderBy: { name: "asc" },
  });
  const vts = await prisma.visitType.findMany({ where: { practiceId } });
  const practitioners = await prisma.practitioner.findMany({
    where: { practiceId },
    orderBy: { lastName: "desc" },
  });
  const patients = await prisma.patient.findMany({
    where: { practiceId, mergedIntoId: null },
    orderBy: { mrn: "asc" },
    take: 9,
  });
  if (!loc || !vts.length || !practitioners.length || !patients.length) return;
  const vt = (name: string) => vts.find((v) => v.name === name) ?? vts[0]!;
  const plan: Array<[string, string, number, string]> = [
    ["09:00", "Follow-up", 0, "CONFIRMED"],
    ["09:20", "New patient", 1, "BOOKED"],
    ["09:40", "Sick visit", 0, "CONFIRMED"],
    ["10:00", "Annual wellness", 1, "CONFIRMED"],
    ["10:40", "Follow-up", 0, "BOOKED"],
    ["11:00", "Follow-up", 1, "BOOKED"],
    ["13:20", "Lab draw", 0, "BOOKED"],
    ["14:00", "Follow-up", 1, "CONFIRMED"],
    ["15:00", "Sick visit", 0, "BOOKED"],
  ];
  for (const [i, [time, type, prIdx, status]] of plan.entries()) {
    const patient = patients[i % patients.length]!;
    const v = vt(type);
    const pr = practitioners[prIdx % practitioners.length]!;
    for (const day of [today, addDays(today, 1)]) {
      if (day !== today && i % 2) continue;
      const s = zonedToUtc(day, time, tz);
      const a = await prisma.appointment.create({
        data: {
          practiceId,
          patientId: patient.id,
          practitionerId: pr.id,
          locationId: loc.id,
          visitTypeId: v.id,
          start: s,
          end: new Date(s.getTime() + v.durationMinutes * 60_000),
          status: day === today ? (status as "BOOKED") : "BOOKED",
          reason: type === "Sick visit" ? "Cough and congestion" : null,
        },
      });
      await prisma.appointmentStatusEvent.create({
        data: {
          practiceId,
          appointmentId: a.id,
          toStatus: "BOOKED",
          at: new Date(Date.now() - 5 * 86_400_000),
        },
      });
      if (a.status === "CONFIRMED")
        await prisma.appointmentStatusEvent.create({
          data: {
            practiceId,
            appointmentId: a.id,
            fromStatus: "BOOKED",
            toStatus: "CONFIRMED",
            at: new Date(Date.now() - 86_400_000),
            note: "Confirmed by SMS",
          },
        });
    }
  }
  const p0 = patients[3];
  if (p0)
    await prisma.waitlistEntry.create({
      data: {
        practiceId,
        patientId: p0.id,
        visitTypeId: vt("Follow-up").id,
        earliest: new Date(),
        latest: new Date(Date.now() + 14 * 86_400_000),
      },
    });
  const p1 = patients[4];
  if (p1)
    await prisma.recall.create({
      data: {
        practiceId,
        patientId: p1.id,
        reason: "Follow-up due",
        dueDate: new Date(`${addDays(today, -3)}T00:00:00Z`),
      },
    });
  console.log(`Demo day ${today}: appointments created.`);
}
