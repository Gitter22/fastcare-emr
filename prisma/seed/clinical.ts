/**
 * Clinical seed (S2): note templates, smart phrases, screening questionnaires, vaccine inventory and chart history
 * for a few demo patients. Idempotent: skipped when the practice already has note templates.
 *
 * Codes are real: ICD-10-CM from prisma/reference-data, RxNorm RXCUIs verified against RxNav on 2026-10-08, SNOMED
 * allergen concepts from the pinned list (gateways/referenceData/allergens.ts), LOINC for vitals and screenings.
 * PHQ-2/PHQ-9 are public domain; the SDOH items are the CMS Accountable Health Communities core questions.
 */
import type { PrismaClient } from "../../generated/prisma-client/index.js";

const DAY = 86_400_000;

const TEMPLATES = [
  {
    name: "Diabetes follow-up v3",
    specialty: "Family medicine",
    sections: [
      {
        key: "hpi",
        title: "History of present illness",
        defaultText:
          "Here for diabetes follow-up. Home glucose readings: . Hypoglycemia: none. Diet and exercise: . Medication adherence: .",
      },
      {
        key: "ros",
        title: "Review of systems",
        defaultText:
          "Negative for polyuria, polydipsia, visual change, chest pain, shortness of breath, numbness or tingling of the feet.",
      },
      {
        key: "exam",
        title: "Exam",
        defaultText:
          "General: well appearing.\nCV: regular rate and rhythm, no murmur.\nLungs: clear.\nFeet: monofilament intact bilaterally, pulses 2+, no ulcers.",
      },
      {
        key: "data",
        title: "Data reviewed",
        defaultText: "Reviewed last A1c, lipid panel and renal function.",
      },
    ],
  },
  {
    name: "Acute visit (URI/sinus)",
    specialty: "Family medicine",
    sections: [
      {
        key: "hpi",
        title: "History of present illness",
        defaultText:
          "Symptoms for  days: congestion, facial pressure, cough. Fever: . Sick contacts: .",
      },
      {
        key: "ros",
        title: "Review of systems",
        defaultText: "Positive as in HPI. Negative for chest pain, shortness of breath, rash.",
      },
      {
        key: "exam",
        title: "Exam",
        defaultText:
          "HEENT: TMs clear, nasal mucosa edematous, maxillary tenderness: . Pharynx: .\nNeck: no lymphadenopathy.\nLungs: clear.",
      },
    ],
  },
  {
    name: "Annual wellness (adult)",
    specialty: "Family medicine",
    sections: [
      {
        key: "hpi",
        title: "History of present illness",
        defaultText: "Here for annual preventive visit. Concerns today: .",
      },
      {
        key: "ros",
        title: "Review of systems",
        defaultText: "Complete review of systems negative except as noted.",
      },
      {
        key: "exam",
        title: "Exam",
        defaultText: "General, HEENT, neck, CV, lungs, abdomen, skin and extremities: normal.",
      },
      {
        key: "data",
        title: "Data reviewed",
        defaultText: "Reviewed immunizations, screenings due and family history.",
      },
    ],
  },
  {
    name: "General follow-up",
    specialty: null,
    sections: [
      {
        key: "hpi",
        title: "History of present illness",
        defaultText: "Follow-up of chronic conditions. Interval history: .",
      },
      {
        key: "exam",
        title: "Exam",
        defaultText: "General: no acute distress.\nCV: regular rate and rhythm.\nLungs: clear.",
      },
    ],
  },
];

const PHRASES = [
  { trigger: "rosneg", text: "Review of systems otherwise negative." },
  {
    trigger: "examnl",
    text: "General: well appearing, no acute distress. CV: regular rate and rhythm. Lungs: clear bilaterally. Abdomen: soft, non-tender.",
  },
  {
    trigger: "dmed",
    text: "Diet and exercise counselling given. Reviewed hypoglycemia symptoms and when to call.",
  },
  {
    trigger: "htned",
    text: "Reviewed home BP monitoring technique, sodium reduction and medication adherence.",
  },
  {
    trigger: "returnprn",
    text: "Return or message us if symptoms worsen, new fever, or no improvement in 7 days.",
  },
];

const freq = [
  { code: "0", display: "Not at all", score: 0 },
  { code: "1", display: "Several days", score: 1 },
  { code: "2", display: "More than half the days", score: 2 },
  { code: "3", display: "Nearly every day", score: 3 },
];
const PHQ9_ITEMS = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself, or that you are a failure or have let yourself or your family down",
  "Trouble concentrating on things, such as reading the newspaper or watching television",
  "Moving or speaking so slowly that other people could have noticed, or the opposite: being so fidgety or restless that you have been moving around a lot more than usual",
  "Thoughts that you would be better off dead, or of hurting yourself in some way",
];
const yesNo = [
  { code: "N", display: "No", score: 0 },
  { code: "Y", display: "Yes", score: 1 },
];
const QUESTIONNAIRES = [
  {
    name: "PHQ-2",
    loincCode: "55757-9",
    purpose: "screening",
    items: PHQ9_ITEMS.slice(0, 2).map((text, i) => ({
      linkId: `phq${i + 1}`,
      text,
      answerOption: freq,
    })),
    scoring: {
      method: "sum",
      bands: [
        { min: 0, label: "Negative" },
        { min: 3, label: "Positive: complete PHQ-9", positive: true },
      ],
    },
  },
  {
    name: "PHQ-9",
    loincCode: "44249-1",
    purpose: "screening",
    items: PHQ9_ITEMS.map((text, i) => ({ linkId: `phq${i + 1}`, text, answerOption: freq })),
    scoring: {
      method: "sum",
      bands: [
        { min: 0, label: "Minimal" },
        { min: 5, label: "Mild" },
        { min: 10, label: "Moderate", positive: true },
        { min: 15, label: "Moderately severe", positive: true },
        { min: 20, label: "Severe", positive: true },
      ],
    },
  },
  {
    name: "SDOH screening (AHC core)",
    loincCode: "96777-8",
    purpose: "sdoh",
    items: [
      {
        linkId: "housing",
        text: "Are you worried about losing your housing, or do you not have steady housing?",
        answerOption: yesNo,
      },
      {
        linkId: "food",
        text: "Within the past 12 months, did you worry that your food would run out before you got money to buy more?",
        answerOption: yesNo,
      },
      {
        linkId: "transport",
        text: "In the past 12 months, has lack of reliable transportation kept you from medical appointments, meetings, work or getting things needed for daily living?",
        answerOption: yesNo,
      },
      {
        linkId: "utilities",
        text: "In the past 12 months has the electric, gas, oil, or water company threatened to shut off services in your home?",
        answerOption: yesNo,
      },
      {
        linkId: "safety",
        text: "Does anyone, including family and friends, physically hurt you, insult you, threaten you or scream or curse at you?",
        answerOption: yesNo,
      },
    ],
    scoring: {
      method: "sum",
      bands: [
        { min: 0, label: "No needs identified" },
        { min: 1, label: "Needs identified", positive: true },
      ],
    },
  },
];

interface History {
  first: string;
  last: string;
  problems: Array<[string, string, string]>; // icd10, display, onset
  meds: Array<{
    rxcui: string | null;
    display: string;
    sig: string;
    reason?: string;
    source?: "ENTERED" | "PATIENT_REPORTED";
  }>;
  staged?: Array<{
    rxcui: string | null;
    display: string;
    sig: string;
    source: "PATIENT_REPORTED" | "OUTSIDE_RECORD";
    daysAgo: number;
  }>;
  allergies: Array<{
    system: "SNOMEDCT" | "RXNORM";
    code: string;
    display: string;
    category: "MEDICATION" | "FOOD" | "ENVIRONMENT";
    criticality: "LOW" | "HIGH";
    reaction: string;
    severity: string;
  }>;
  nka?: boolean;
  visits: Array<{
    daysAgo: number;
    bp: [number, number];
    hr: number;
    weightKg: number;
    heightCm: number;
    hpi: string;
    plans: Record<string, string>;
  }>;
  shots?: Array<{ cvx: string; display: string; daysAgo: number }>;
  restrictedNoteDaysAgo?: number;
  tobacco?: [string, string];
  phq2DaysAgo?: number;
}

const HISTORIES: History[] = [
  {
    first: "Maria",
    last: "Gonzalez",
    problems: [
      ["E11.9", "Type 2 diabetes mellitus without complications", "2019-03-01"],
      ["I10", "Essential (primary) hypertension", "2017-06-01"],
      ["E78.5", "Hyperlipidemia, unspecified", "2019-03-01"],
      ["E66.9", "Obesity, unspecified", "2021-01-15"],
    ],
    meds: [
      {
        rxcui: "861004",
        display: "Metformin 1000 mg tablet",
        sig: "1 tab by mouth twice daily with meals",
        reason: "E11.9",
      },
      {
        rxcui: "314077",
        display: "Lisinopril 20 mg tablet",
        sig: "1 tab by mouth daily",
        reason: "I10",
      },
      {
        rxcui: "617311",
        display: "Atorvastatin 40 mg tablet",
        sig: "1 tab by mouth at bedtime",
        reason: "E78.5",
      },
      {
        rxcui: null,
        display: "Vitamin D3 2000 IU capsule",
        sig: "1 capsule daily",
        source: "PATIENT_REPORTED",
      },
    ],
    staged: [
      {
        rxcui: "617320",
        display: "Lipitor 40 mg tablet",
        sig: "Once a day at night",
        source: "PATIENT_REPORTED",
        daysAgo: 2,
      },
      {
        rxcui: "866427",
        display: "Metoprolol succinate ER 25 mg tablet",
        sig: "1 tab daily · prescriber Dr. A. Wells (Valley Cardiology)",
        source: "OUTSIDE_RECORD",
        daysAgo: 10,
      },
    ],
    allergies: [
      {
        system: "SNOMEDCT",
        code: "764146007",
        display: "Penicillin",
        category: "MEDICATION",
        criticality: "HIGH",
        reaction: "Hives",
        severity: "moderate",
      },
      {
        system: "SNOMEDCT",
        code: "372788003",
        display: "Sulfonamide antibacterial",
        category: "MEDICATION",
        criticality: "LOW",
        reaction: "Rash",
        severity: "mild",
      },
    ],
    visits: [
      {
        daysAgo: 180,
        bp: [138, 86],
        hr: 78,
        weightKg: 85.7,
        heightCm: 162.6,
        hpi: "Diabetes and blood pressure follow-up. Taking medicines as prescribed.",
        plans: { "E11.9": "A1c 7.4%. Continue metformin.", I10: "At goal on lisinopril 20 mg." },
      },
      {
        daysAgo: 120,
        bp: [140, 88],
        hr: 82,
        weightKg: 85.0,
        heightCm: 162.6,
        hpi: "Routine follow-up. Some missed doses of atorvastatin.",
        plans: {
          "E11.9": "Continue metformin; diet counselling.",
          "E78.5": "Reinforced statin adherence.",
        },
      },
      {
        daysAgo: 56,
        bp: [142, 88],
        hr: 80,
        weightKg: 84.4,
        heightCm: 162.6,
        hpi: "Two-month follow-up of diabetes, hypertension and hyperlipidemia. Home BP readings 130s-140s.",
        plans: {
          "E11.9": "A1c 7.8% in May. Continue metformin; recheck A1c next visit.",
          I10: "Borderline. Home BP log; recheck in 2 months.",
          "E78.5": "Continue atorvastatin 40 mg.",
        },
      },
    ],
    shots: [
      {
        cvx: "140",
        display: "Influenza, split virus, trivalent, injectable, preservative free",
        daysAgo: 370,
      },
      { cvx: "115", display: "Tdap", daysAgo: 7 * 365 },
    ],
    restrictedNoteDaysAgo: 560,
    tobacco: ["266919005", "Never smoked tobacco"],
    phq2DaysAgo: 2,
  },
  {
    first: "Michael",
    last: "Lee",
    problems: [["I10", "Essential (primary) hypertension", "2022-04-01"]],
    meds: [
      {
        rxcui: "197361",
        display: "Amlodipine 5 mg tablet",
        sig: "1 tab by mouth daily",
        reason: "I10",
      },
    ],
    allergies: [],
    nka: true,
    visits: [
      {
        daysAgo: 30,
        bp: [148, 92],
        hr: 74,
        weightKg: 92.1,
        heightCm: 178,
        hpi: "Blood pressure check after starting amlodipine.",
        plans: { I10: "Above goal. Continue amlodipine 5 mg; home BP log; return in 4 weeks." },
      },
    ],
    tobacco: ["8517006", "Former smoker"],
  },
  {
    first: "Aisha",
    last: "Patel",
    problems: [["J45.909", "Unspecified asthma, uncomplicated", "2015-09-01"]],
    meds: [
      {
        rxcui: null,
        display: "Albuterol HFA 90 mcg inhaler",
        sig: "2 puffs every 4-6 hours as needed for wheeze",
        reason: "J45.909",
      },
    ],
    allergies: [
      {
        system: "SNOMEDCT",
        code: "762952008",
        display: "Peanut",
        category: "FOOD",
        criticality: "HIGH",
        reaction: "Anaphylaxis",
        severity: "severe",
      },
    ],
    visits: [],
  },
];

const LOTS = [
  { cvx: "140", lot: "FL2391", exp: "2027-06-30", qty: 24, mvx: "SKB" },
  { cvx: "115", lot: "TD8812", exp: "2027-12-31", qty: 10, mvx: "SKB" },
  { cvx: "216", lot: "PN5521", exp: "2027-03-31", qty: 8, mvx: "PFR" },
  // Expired on purpose: administration is blocked (flow:checkin/05 failure).
  { cvx: "187", lot: "ZS0193", exp: "2026-09-30", qty: 5, mvx: "SKB" },
  { cvx: "187", lot: "ZS0402", exp: "2027-09-30", qty: 6, mvx: "SKB" },
];

export async function seedClinical(prisma: PrismaClient, practiceId: string): Promise<void> {
  if (await prisma.noteTemplate.findFirst({ where: { practiceId } })) return;
  for (const t of TEMPLATES)
    await prisma.noteTemplate.create({
      data: {
        practiceId,
        name: t.name,
        specialty: t.specialty,
        shared: true,
        sections: t.sections,
      },
    });
  for (const p of PHRASES)
    await prisma.smartPhrase.create({
      data: { practiceId, trigger: p.trigger, text: p.text, shared: true },
    });
  const qns = new Map<string, string>();
  for (const q of QUESTIONNAIRES) {
    const row = await prisma.questionnaire.create({
      data: {
        practiceId,
        name: q.name,
        loincCode: q.loincCode,
        purpose: q.purpose,
        items: q.items,
        scoring: q.scoring,
        languages: ["en"],
        channels: ["staff", "portal"],
        status: "active",
      },
    });
    qns.set(q.loincCode, row.id);
  }
  const location = await prisma.location.findFirst({
    where: { practiceId, placeOfService: "11" },
    orderBy: { name: "asc" },
  });
  if (location)
    for (const l of LOTS)
      await prisma.vaccineLot.create({
        data: {
          practiceId,
          locationId: location.id,
          cvxCode: l.cvx,
          mvxCode: l.mvx,
          lotNumber: l.lot,
          expirationDate: new Date(`${l.exp}T00:00:00Z`),
          quantityOnHand: l.qty,
          fundingSource: "private",
        },
      });

  const provider = await prisma.practitioner.findFirst({
    where: { practiceId, credential: { in: ["MD", "DO"] } },
    orderBy: { lastName: "asc" },
  });
  const ma = await prisma.user.findFirst({
    where: { practiceId, roles: { some: { role: "MA" } } },
  });
  if (!provider?.userId || !location) return;
  const visitType = await prisma.visitType.findFirst({ where: { practiceId, name: "Follow-up" } });

  for (const h of HISTORIES) {
    const patient = await prisma.patient.findFirst({
      where: { practiceId, firstName: h.first, lastName: h.last, mergedIntoId: null },
    });
    if (!patient) continue;
    const pid = patient.id;
    const problemIds = new Map<string, string>();
    for (const [code, display, onset] of h.problems) {
      const c = await prisma.condition.create({
        data: {
          practiceId,
          patientId: pid,
          category: "PROBLEM_LIST_ITEM",
          icd10Code: code,
          display,
          onsetDate: new Date(`${onset}T00:00:00Z`),
          recordedById: provider.userId,
        },
      });
      problemIds.set(code, c.id);
    }
    for (const m of h.meds)
      await prisma.medicationStatement.create({
        data: {
          practiceId,
          patientId: pid,
          rxnormCode: m.rxcui,
          display: m.display,
          dosageText: m.sig,
          effectiveStart: new Date(Date.now() - 400 * DAY),
          reasonConditionId: m.reason ? (problemIds.get(m.reason) ?? null) : null,
          source: m.source ?? "ENTERED",
          recordedById: provider.userId,
        },
      });
    for (const s of h.staged ?? []) {
      const row = await prisma.medicationStatement.create({
        data: {
          practiceId,
          patientId: pid,
          rxnormCode: s.rxcui,
          display: s.display,
          dosageText: s.sig,
          stagingStatus: "STAGED",
          source: s.source,
          createdAt: new Date(Date.now() - s.daysAgo * DAY),
        },
      });
      await prisma.provenanceRecord.create({
        data: {
          practiceId,
          targetType: "MedicationStatement",
          targetId: row.id,
          source: s.source,
          activity: "create",
          agentType: s.source === "PATIENT_REPORTED" ? "patient" : "organization",
          agentDisplay: s.source === "PATIENT_REPORTED" ? "Patient portal" : "Valley Cardiology",
          recordedAt: new Date(Date.now() - s.daysAgo * DAY),
        },
      });
    }
    for (const a of h.allergies)
      await prisma.allergyIntolerance.create({
        data: {
          practiceId,
          patientId: pid,
          substanceSystem: a.system,
          substanceCode: a.code,
          substanceDisplay: a.display,
          category: a.category,
          criticality: a.criticality,
          reactions: { items: [{ manifestation: a.reaction, severity: a.severity }] },
          recordedById: provider.userId,
        },
      });
    if (h.nka)
      await prisma.patient.update({
        where: { id: pid },
        data: { noKnownAllergies: true, allergiesReviewedAt: new Date(Date.now() - 30 * DAY) },
      });
    else if (h.allergies.length)
      await prisma.patient.update({
        where: { id: pid },
        data: {
          allergiesReviewedAt: new Date(Date.now() - 56 * DAY),
          medsReconciledAt: new Date(Date.now() - 56 * DAY),
          medsReconciledById: ma?.id ?? null,
        },
      });

    for (const v of h.visits) {
      const at = new Date(Date.now() - v.daysAgo * DAY);
      at.setUTCHours(14, 40, 0, 0);
      const appt = visitType
        ? await prisma.appointment.create({
            data: {
              practiceId,
              patientId: pid,
              practitionerId: provider.id,
              locationId: location.id,
              visitTypeId: visitType.id,
              start: at,
              end: new Date(at.getTime() + visitType.durationMinutes * 60_000),
              status: "COMPLETED",
              reason: "Chronic care follow-up",
            },
          })
        : null;
      const enc = await prisma.encounter.create({
        data: {
          practiceId,
          patientId: pid,
          appointmentId: appt?.id ?? null,
          practitionerId: provider.id,
          locationId: location.id,
          status: "FINISHED",
          periodStart: at,
          periodEnd: new Date(at.getTime() + 25 * 60_000),
          chiefComplaint: "Chronic care follow-up",
          securityLabels: [],
          createdById: provider.userId,
        },
      });
      const bmi = Math.round((v.weightKg / (v.heightCm / 100) ** 2) * 10) / 10;
      const obs = (loincCode: string, display: string, value: number, unit: string) =>
        prisma.observation.create({
          data: {
            practiceId,
            patientId: pid,
            encounterId: enc.id,
            category: "VITAL_SIGNS",
            loincCode,
            display,
            effectiveAt: at,
            valueQuantity: value,
            valueUnit: unit,
          },
        });
      await prisma.observation.create({
        data: {
          practiceId,
          patientId: pid,
          encounterId: enc.id,
          category: "VITAL_SIGNS",
          loincCode: "85354-9",
          display: "Blood pressure",
          effectiveAt: at,
          valueString: `${v.bp[0]}/${v.bp[1]}`,
          valueUnit: "mm[Hg]",
          components: { systolic: v.bp[0], diastolic: v.bp[1], position: "sitting" },
          interpretation: v.bp[0] >= 160 || v.bp[1] >= 100 ? "H" : "N",
        },
      });
      await obs("8867-4", "Heart rate", v.hr, "/min");
      await obs("8310-5", "Body temperature", 98.4, "[degF]");
      await obs("9279-1", "Respiratory rate", 16, "/min");
      await obs("59408-5", "Oxygen saturation", 98, "%");
      await obs("8302-2", "Body height", v.heightCm, "cm");
      await obs("29463-7", "Body weight", v.weightKg, "kg");
      await obs("39156-5", "Body mass index", bmi, "kg/m2");
      await obs("72514-3", "Pain severity (0-10)", 0, "{score}");
      const note = await prisma.clinicalNote.create({
        data: {
          practiceId,
          encounterId: enc.id,
          patientId: pid,
          authorId: provider.userId,
          status: "SIGNED",
          signedById: provider.userId,
          signedAt: new Date(at.getTime() + 40 * 60_000),
          securityLabels: [],
        },
      });
      const sections: Array<[string, string]> = [
        ["cc", "Chronic care follow-up"],
        ["hpi", v.hpi],
        ["ros", "Negative for chest pain, shortness of breath, polyuria, visual change."],
        [
          "exam",
          `Vitals BP ${v.bp[0]}/${v.bp[1]}, HR ${v.hr}, BMI ${bmi}.\nCV: regular rate and rhythm. Lungs: clear. Feet: monofilament intact.`,
        ],
      ];
      for (const [i, [key, content]] of sections.entries())
        await prisma.noteSection.create({
          data: { practiceId, noteId: note.id, key, ordinal: i, content },
        });
      let rank = 1;
      for (const [code, plan] of Object.entries(v.plans)) {
        const problem = h.problems.find((p) => p[0] === code);
        const dx = await prisma.condition.create({
          data: {
            practiceId,
            patientId: pid,
            encounterId: enc.id,
            category: "ENCOUNTER_DIAGNOSIS",
            icd10Code: code,
            display: problem?.[1] ?? code,
            rank: rank++,
            recordedById: provider.userId,
          },
        });
        await prisma.noteSection.create({
          data: {
            practiceId,
            noteId: note.id,
            key: `ap:${dx.id}`,
            ordinal: 100 + dx.rank!,
            content: plan,
          },
        });
      }
      await prisma.afterVisitSummary.create({
        data: {
          practiceId,
          encounterId: enc.id,
          patientId: pid,
          content: { visit: { title: "Follow-up visit" } },
          releasedAt: new Date(at.getTime() + 60 * 60_000),
        },
      });
      for (const code of Object.keys(v.plans))
        await prisma.condition.updateMany({
          where: { patientId: pid, category: "PROBLEM_LIST_ITEM", icd10Code: code },
          data: { lastAddressedAt: at },
        });
    }

    for (const s of h.shots ?? [])
      await prisma.immunization.create({
        data: {
          practiceId,
          patientId: pid,
          cvxCode: s.cvx,
          display: s.display,
          occurrenceAt: new Date(Date.now() - s.daysAgo * DAY),
          primarySource: false,
          source: "REGISTRY",
        },
      });

    if (h.restrictedNoteDaysAgo) {
      const at = new Date(Date.now() - h.restrictedNoteDaysAgo * DAY);
      const enc = await prisma.encounter.create({
        data: {
          practiceId,
          patientId: pid,
          practitionerId: provider.id,
          locationId: location.id,
          class: "AMB",
          status: "FINISHED",
          periodStart: at,
          periodEnd: at,
          chiefComplaint: "Behavioral health visit",
          securityLabels: ["R"],
          createdById: provider.userId,
        },
      });
      const note = await prisma.clinicalNote.create({
        data: {
          practiceId,
          encounterId: enc.id,
          patientId: pid,
          authorId: provider.userId,
          status: "SIGNED",
          signedById: provider.userId,
          signedAt: at,
          securityLabels: ["R"],
        },
      });
      await prisma.noteSection.create({
        data: {
          practiceId,
          noteId: note.id,
          key: "cc",
          ordinal: 0,
          content: "Behavioral health visit (restricted).",
        },
      });
    }
    if (h.tobacco)
      await prisma.observation.create({
        data: {
          practiceId,
          patientId: pid,
          category: "SOCIAL_HISTORY",
          loincCode: "72166-2",
          display: "Tobacco smoking status",
          effectiveAt: new Date(Date.now() - 56 * DAY),
          valueCode: h.tobacco[0],
          valueString: h.tobacco[1],
        },
      });
    if (h.phq2DaysAgo && qns.get("55757-9"))
      await prisma.questionnaireResponse.create({
        data: {
          practiceId,
          questionnaireId: qns.get("55757-9")!,
          patientId: pid,
          answers: { phq1: "1", phq2: "0" },
          score: 1,
          authoredAt: new Date(Date.now() - h.phq2DaysAgo * DAY),
          source: "PATIENT_REPORTED",
        },
      });
  }
  console.log(
    "Clinical seed: templates, phrases, questionnaires, vaccine lots and chart history created.",
  );
}
