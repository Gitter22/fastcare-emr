/**
 * Orders and results seed (S3): lab compendium (Quest and LabCorp), practice-wide order sets and reviewed historical
 * results for a few demo patients. Idempotent: compendium and order sets are upserted/skipped by name; result history
 * is skipped when the patient already has a service request.
 *
 * Panel and test codes are real LOINC. Lab-specific test codes are demo values (formats differ per lab).
 * No pending, critical, unmatched or overdue results are seeded here: those scenarios come from the ingestion code.
 */
import type { PrismaClient } from "../../generated/prisma-client/index.js";

const DAY = 86_400_000;

type Aoe = {
  code: string;
  text: string;
  type: "boolean" | "text" | "choice";
  options?: string[];
  required: boolean;
};
const FASTING: Aoe = { code: "fasting", text: "Patient fasting?", type: "boolean", required: true };
const COLLECTION: Aoe = {
  code: "collection-method",
  text: "Collection method",
  type: "choice",
  options: ["Clean catch", "Catheter"],
  required: true,
};
const ANTICOAG: Aoe = {
  code: "anticoagulant",
  text: "On anticoagulant?",
  type: "boolean",
  required: true,
};

interface Test {
  key: string;
  loinc: string;
  display: string;
  specimen: string;
  quest: string;
  labcorp: string;
  aoe?: Aoe[];
}

const TESTS: Test[] = [
  {
    key: "cbc",
    loinc: "58410-2",
    display: "CBC with differential",
    specimen: "whole blood",
    quest: "6399",
    labcorp: "005009",
  },
  {
    key: "cmp",
    loinc: "24323-8",
    display: "Comprehensive metabolic panel",
    specimen: "serum",
    quest: "10231",
    labcorp: "322000",
    aoe: [FASTING],
  },
  {
    key: "bmp",
    loinc: "51990-0",
    display: "Basic metabolic panel",
    specimen: "serum",
    quest: "10165",
    labcorp: "322758",
    aoe: [FASTING],
  },
  {
    key: "lipid",
    loinc: "57698-3",
    display: "Lipid panel",
    specimen: "serum",
    quest: "7600",
    labcorp: "303756",
    aoe: [FASTING],
  },
  {
    key: "a1c",
    loinc: "4548-4",
    display: "Hemoglobin A1c",
    specimen: "whole blood",
    quest: "496",
    labcorp: "001453",
  },
  {
    key: "tsh",
    loinc: "3016-3",
    display: "TSH",
    specimen: "serum",
    quest: "899",
    labcorp: "004259",
  },
  {
    key: "ft4",
    loinc: "3024-7",
    display: "Free T4",
    specimen: "serum",
    quest: "866",
    labcorp: "001974",
  },
  {
    key: "ua",
    loinc: "24357-6",
    display: "Urinalysis, complete",
    specimen: "urine",
    quest: "5463",
    labcorp: "003772",
    aoe: [COLLECTION],
  },
  {
    key: "uacr",
    loinc: "9318-7",
    display: "Urine albumin/creatinine ratio",
    specimen: "urine",
    quest: "11858",
    labcorp: "140285",
  },
  {
    key: "vitd",
    loinc: "1989-3",
    display: "Vitamin D, 25-hydroxy",
    specimen: "serum",
    quest: "17306",
    labcorp: "081950",
  },
  {
    key: "psa",
    loinc: "2857-1",
    display: "PSA, total",
    specimen: "serum",
    quest: "20255",
    labcorp: "010322",
  },
  {
    key: "hcv",
    loinc: "13955-0",
    display: "Hepatitis C antibody",
    specimen: "serum",
    quest: "8472",
    labcorp: "140376",
  },
  {
    key: "hiv",
    loinc: "56888-1",
    display: "HIV 1/2 Ag/Ab",
    specimen: "serum",
    quest: "91431",
    labcorp: "083824",
  },
  {
    key: "iron",
    loinc: "24373-3",
    display: "Iron and TIBC panel",
    specimen: "serum",
    quest: "7573",
    labcorp: "001321",
  },
  {
    key: "ferritin",
    loinc: "2276-4",
    display: "Ferritin",
    specimen: "serum",
    quest: "457",
    labcorp: "004598",
  },
  {
    key: "b12",
    loinc: "2132-9",
    display: "Vitamin B12",
    specimen: "serum",
    quest: "927",
    labcorp: "001503",
  },
  {
    key: "folate",
    loinc: "2284-8",
    display: "Folate",
    specimen: "serum",
    quest: "35519",
    labcorp: "002014",
  },
  {
    key: "mg",
    loinc: "19123-9",
    display: "Magnesium",
    specimen: "serum",
    quest: "737",
    labcorp: "001537",
  },
  {
    key: "k",
    loinc: "2823-3",
    display: "Potassium",
    specimen: "serum",
    quest: "6399P",
    labcorp: "001180",
  },
  {
    key: "creat",
    loinc: "2160-0",
    display: "Creatinine",
    specimen: "serum",
    quest: "375",
    labcorp: "001370",
  },
  {
    key: "glucose",
    loinc: "2345-7",
    display: "Glucose",
    specimen: "plasma",
    quest: "483",
    labcorp: "001032",
    aoe: [FASTING],
  },
  {
    key: "lipase",
    loinc: "3040-3",
    display: "Lipase",
    specimen: "serum",
    quest: "8130",
    labcorp: "001115",
  },
  {
    key: "crp",
    loinc: "1988-5",
    display: "C-reactive protein",
    specimen: "serum",
    quest: "4420",
    labcorp: "006627",
  },
  {
    key: "esr",
    loinc: "4537-7",
    display: "Erythrocyte sedimentation rate",
    specimen: "whole blood",
    quest: "801",
    labcorp: "005215",
  },
  {
    key: "ptinr",
    loinc: "34714-6",
    display: "PT/INR",
    specimen: "plasma",
    quest: "8847",
    labcorp: "005199",
    aoe: [ANTICOAG],
  },
  {
    key: "strep",
    loinc: "626-2",
    display: "Strep A culture, throat",
    specimen: "swab",
    quest: "6480",
    labcorp: "180013",
  },
];
const byKey = new Map(TESTS.map((t) => [t.key, t]));

const ORDER_SETS = [
  { name: "Diabetes annual labs", dx: "E11.9", keys: ["a1c", "cmp", "lipid", "uacr"] },
  { name: "Hypertension follow-up labs", dx: "I10", keys: ["bmp", "lipid", "ua"] },
  { name: "Annual physical labs", dx: "Z00.00", keys: ["cbc", "cmp", "lipid", "tsh", "a1c"] },
];

interface Obs {
  loinc: string;
  display: string;
  value: number;
  unit: string;
  low?: number;
  high?: number;
  refText: string;
  abnormal?: boolean;
}
interface Result {
  test: string;
  daysAgo: number | "may2";
  obs: Obs[];
  reason?: string;
}

const A1C = (value: number, abnormal = true): Obs => ({
  loinc: "4548-4",
  display: "Hemoglobin A1c",
  value,
  unit: "%",
  low: 4.0,
  high: 5.6,
  refText: "4.0-5.6",
  abnormal,
});

const RESULTS: Record<string, Result[]> = {
  "Maria Gonzalez": [
    { test: "a1c", daysAgo: "may2", reason: "E11.9", obs: [A1C(7.8)] },
    {
      test: "lipid",
      daysAgo: "may2",
      reason: "E11.9",
      obs: [
        {
          loinc: "13457-7",
          display: "LDL cholesterol (calculated)",
          value: 94,
          unit: "mg/dL",
          high: 100,
          refText: "<100",
        },
      ],
    },
    {
      test: "bmp",
      daysAgo: "may2",
      reason: "E11.9",
      obs: [
        {
          loinc: "2160-0",
          display: "Creatinine",
          value: 0.9,
          unit: "mg/dL",
          low: 0.57,
          high: 1.0,
          refText: "0.57-1.00",
        },
      ],
    },
    {
      test: "uacr",
      daysAgo: "may2",
      reason: "E11.9",
      obs: [
        {
          loinc: "9318-7",
          display: "Albumin/Creatinine [Mass Ratio] in Urine",
          value: 22,
          unit: "mg/g",
          high: 30,
          refText: "<30",
        },
      ],
    },
    { test: "a1c", daysAgo: 245, reason: "E11.9", obs: [A1C(8.1)] },
    { test: "a1c", daysAgo: 335, reason: "E11.9", obs: [A1C(8.4)] },
  ],
  "Michael Lee": [
    {
      test: "cmp",
      daysAgo: 60,
      reason: "I10",
      obs: [
        {
          loinc: "2160-0",
          display: "Creatinine",
          value: 1.0,
          unit: "mg/dL",
          low: 0.7,
          high: 1.3,
          refText: "0.70-1.30",
        },
        {
          loinc: "2823-3",
          display: "Potassium",
          value: 4.2,
          unit: "mmol/L",
          low: 3.5,
          high: 5.3,
          refText: "3.5-5.3",
        },
        {
          loinc: "2345-7",
          display: "Glucose",
          value: 92,
          unit: "mg/dL",
          low: 65,
          high: 99,
          refText: "65-99",
        },
      ],
    },
  ],
  "Aisha Patel": [
    {
      test: "lipid",
      daysAgo: 90,
      obs: [
        {
          loinc: "2093-3",
          display: "Total cholesterol",
          value: 165,
          unit: "mg/dL",
          high: 200,
          refText: "<200",
        },
        {
          loinc: "2085-9",
          display: "HDL cholesterol",
          value: 62,
          unit: "mg/dL",
          low: 50,
          refText: ">50",
        },
        {
          loinc: "13457-7",
          display: "LDL cholesterol (calculated)",
          value: 88,
          unit: "mg/dL",
          high: 100,
          refText: "<100",
        },
        {
          loinc: "2571-8",
          display: "Triglycerides",
          value: 80,
          unit: "mg/dL",
          high: 150,
          refText: "<150",
        },
      ],
    },
  ],
};

const SPECIMEN_SNOMED: Record<string, string> = {
  serum: "119364003",
  "whole blood": "119297000",
  plasma: "119361006",
  urine: "122575003",
  swab: "257261003",
};

function may2(): Date {
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), 4, 2, 13, 30));
  if (d.getTime() > now.getTime()) d = new Date(Date.UTC(now.getUTCFullYear() - 1, 4, 2, 13, 30));
  return d;
}

export async function seedOrders(prisma: PrismaClient, practiceId: string): Promise<void> {
  for (const lab of ["QUEST", "LABCORP"] as const)
    for (const t of TESTS) {
      const testCode = lab === "QUEST" ? t.quest : t.labcorp;
      const data = {
        loincCode: t.loinc,
        display: t.display,
        specimenType: t.specimen,
        aoeQuestions: { items: t.aoe ?? [] },
        active: true,
      };
      await prisma.labCompendiumItem.upsert({
        where: { practiceId_lab_testCode: { practiceId, lab, testCode } },
        create: { practiceId, lab, testCode, ...data },
        update: data,
      });
    }

  for (const s of ORDER_SETS) {
    if (await prisma.orderSet.findFirst({ where: { practiceId, name: s.name, ownerId: null } }))
      continue;
    await prisma.orderSet.create({
      data: {
        practiceId,
        name: s.name,
        ownerId: null,
        items: s.keys.map((k) => {
          const t = byKey.get(k)!;
          return {
            category: "LAB",
            codeSystem: "LOINC",
            code: t.loinc,
            display: t.display,
            defaultDxCode: s.dx,
            priority: "ROUTINE",
            aoeDefaults: {},
          };
        }),
      },
    });
  }

  const provider = await prisma.practitioner.findFirst({
    where: { practiceId, credential: { in: ["MD", "DO"] } },
    orderBy: { lastName: "asc" },
  });
  if (!provider?.userId) return;
  const reviewer = provider.userId;

  let accession = 4_821_700;
  let placer = 1;
  let n = 0;
  for (const [name, results] of Object.entries(RESULTS)) {
    const [first, last] = name.split(" ") as [string, string];
    const patient = await prisma.patient.findFirst({
      where: { practiceId, firstName: first, lastName: last, mergedIntoId: null },
    });
    if (!patient) continue;
    if (await prisma.serviceRequest.findFirst({ where: { practiceId, patientId: patient.id } }))
      continue;
    const conditions = await prisma.condition.findMany({
      where: { practiceId, patientId: patient.id, category: "PROBLEM_LIST_ITEM" },
    });

    for (const r of results) {
      const test = byKey.get(r.test)!;
      const collected = r.daysAgo === "may2" ? may2() : new Date(Date.now() - r.daysAgo * DAY);
      collected.setUTCHours(13, 30, 0, 0);
      const issued = new Date(collected.getTime() + DAY);
      const reviewed = new Date(collected.getTime() + 2 * DAY);
      const signed = new Date(collected.getTime() - 3 * DAY);
      const accessionNumber = `QD${accession++}`;
      const item = await prisma.labCompendiumItem.findFirst({
        where: { practiceId, lab: "QUEST", loincCode: test.loinc },
      });
      const sr = await prisma.serviceRequest.create({
        data: {
          practiceId,
          patientId: patient.id,
          category: "LAB",
          codeSystem: "LOINC",
          code: test.loinc,
          display: test.display,
          labCompendiumItemId: item?.id ?? null,
          performerLab: "QUEST",
          status: "REVIEWED",
          priority: "ROUTINE",
          collectionMode: "IN_OFFICE",
          placerOrderNumber: `PO${practiceId.slice(0, 6)}${String(placer++).padStart(5, "0")}${++n}`,
          accessionNumber,
          collectedAt: collected,
          pendedById: reviewer,
          signedById: reviewer,
          signedAt: signed,
          sentAt: signed,
          ...(test.aoe?.some((a) => a.code === "fasting") ? { aoeAnswers: { fasting: true } } : {}),
        },
      });
      const cond = r.reason ? conditions.find((c) => c.icd10Code === r.reason) : undefined;
      if (cond)
        await prisma.serviceRequestReason.create({
          data: { practiceId, serviceRequestId: sr.id, conditionId: cond.id },
        });
      await prisma.specimen.create({
        data: {
          practiceId,
          serviceRequestId: sr.id,
          type: SPECIMEN_SNOMED[test.specimen] ?? "119364003",
          collectedAt: collected,
          collectedById: reviewer,
          labelPrinted: true,
        },
      });
      const anyAbnormal = r.obs.some((o) => o.abnormal);
      const report = await prisma.diagnosticReport.create({
        data: {
          practiceId,
          patientId: patient.id,
          serviceRequestId: sr.id,
          category: "LAB",
          loincCode: test.loinc,
          display: test.display,
          status: "FINAL",
          effectiveAt: collected,
          issuedAt: issued,
          performerLab: "QUEST",
          accessionNumber,
          flag: anyAbnormal ? "ABNORMAL" : "NORMAL",
          isCritical: false,
          reviewedById: reviewer,
          reviewedAt: reviewed,
          releasedToPortalAt: reviewed,
        },
      });
      for (const o of r.obs)
        await prisma.observation.create({
          data: {
            practiceId,
            patientId: patient.id,
            diagnosticReportId: report.id,
            category: "LABORATORY",
            loincCode: o.loinc,
            display: o.display,
            status: "FINAL",
            effectiveAt: collected,
            valueQuantity: o.value,
            valueUnit: o.unit,
            referenceRangeLow: o.low ?? null,
            referenceRangeHigh: o.high ?? null,
            referenceRangeText: o.refText,
            interpretation: o.abnormal ? "H" : "N",
            flag: o.abnormal ? "ABNORMAL" : "NORMAL",
            stagingStatus: "ACTIVE",
            source: "INTERFACE",
          },
        });
    }
  }
  console.log("Orders seed: lab compendium, order sets and reviewed historical results created.");
}
