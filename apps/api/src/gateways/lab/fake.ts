import { createHash } from "node:crypto";
import { buildOru, type OruInput } from "./hl7.js";

/**
 * Simulated reference lab (no lab vendor credentials exist: OPEN-Q2, agile-emr has none). It accepts ORM orders
 * with an accession number and produces ORU results the way a real lab would, so result ingestion, matching,
 * critical-value handling and trending run through the same code as production. Values are deterministic per
 * order (hash of the placer number) and fall inside the reference range unless an override is given.
 */

interface Analyte {
  loinc: string;
  display: string;
  unit: string;
  low: number;
  high: number;
  decimals: number;
  /** Critical limits (HH/LL). */
  critLow?: number;
  critHigh?: number;
}

const a = (
  loinc: string,
  display: string,
  unit: string,
  low: number,
  high: number,
  decimals = 1,
  crit: [number?, number?] = [],
): Analyte => ({ loinc, display, unit, low, high, decimals, critLow: crit[0], critHigh: crit[1] });

const SODIUM = a("2951-2", "Sodium", "mmol/L", 136, 145, 0, [120, 160]);
const POTASSIUM = a("2823-3", "Potassium", "mmol/L", 3.5, 5.1, 1, [2.8, 6.2]);
const CHLORIDE = a("2075-0", "Chloride", "mmol/L", 98, 107, 0);
const CO2 = a("2028-9", "Carbon dioxide", "mmol/L", 22, 29, 0);
const BUN = a("3094-0", "Urea nitrogen", "mg/dL", 7, 20, 0);
const CREATININE = a("2160-0", "Creatinine", "mg/dL", 0.57, 1.0, 2);
const GLUCOSE = a("2345-7", "Glucose", "mg/dL", 70, 99, 0, [50, 400]);
const CALCIUM = a("17861-6", "Calcium", "mg/dL", 8.6, 10.3, 1, [6.5, 13]);
const BMP = [SODIUM, POTASSIUM, CHLORIDE, CO2, BUN, CREATININE, GLUCOSE, CALCIUM];
const CMP = [
  ...BMP,
  a("2885-2", "Protein", "g/dL", 6.0, 8.5, 1),
  a("1751-7", "Albumin", "g/dL", 3.8, 4.9, 1),
  a("1975-2", "Bilirubin, total", "mg/dL", 0.2, 1.2, 1),
  a("6768-6", "Alkaline phosphatase", "U/L", 44, 121, 0),
  a("1920-8", "AST", "U/L", 10, 40, 0),
  a("1742-6", "ALT", "U/L", 7, 32, 0),
];

const PANELS: Record<string, Analyte[]> = {
  "58410-2": [
    a("6690-2", "WBC", "10*3/uL", 3.4, 10.8, 1, [1.5, 30]),
    a("789-8", "RBC", "10*6/uL", 3.77, 5.28, 2),
    a("718-7", "Hemoglobin", "g/dL", 11.1, 15.9, 1, [7, 20]),
    a("4544-3", "Hematocrit", "%", 34, 46.6, 1),
    a("777-3", "Platelets", "10*3/uL", 150, 450, 0, [50, 1000]),
  ],
  "24323-8": CMP,
  "51990-0": BMP,
  "57698-3": [
    a("2093-3", "Cholesterol, total", "mg/dL", 100, 199, 0),
    a("2571-8", "Triglycerides", "mg/dL", 0, 149, 0),
    a("2085-9", "HDL cholesterol", "mg/dL", 40, 90, 0),
    a("13457-7", "LDL cholesterol", "mg/dL", 0, 99, 0),
  ],
  "4548-4": [a("4548-4", "Hemoglobin A1c", "%", 4.0, 5.6, 1)],
  "3016-3": [a("3016-3", "TSH", "uIU/mL", 0.45, 4.5, 2)],
  "3024-7": [a("3024-7", "Free T4", "ng/dL", 0.82, 1.77, 2)],
  "24357-6": [
    a("5811-5", "Specific gravity", "", 1.005, 1.03, 3),
    a("2756-5", "pH", "", 5, 7.5, 1),
  ],
  "9318-7": [a("9318-7", "Albumin/creatinine ratio", "mg/g", 0, 29, 0)],
  "1989-3": [a("1989-3", "Vitamin D, 25-hydroxy", "ng/mL", 30, 100, 0)],
  "2857-1": [a("2857-1", "PSA", "ng/mL", 0, 4, 2)],
  "2276-4": [a("2276-4", "Ferritin", "ng/mL", 15, 150, 0)],
  "2132-9": [a("2132-9", "Vitamin B12", "pg/mL", 232, 1245, 0)],
  "2284-8": [a("2284-8", "Folate", "ng/mL", 3, 20, 1)],
  "19123-9": [a("19123-9", "Magnesium", "mg/dL", 1.6, 2.3, 1, [1, 4])],
  "2823-3": [POTASSIUM],
  "2160-0": [CREATININE],
  "2345-7": [GLUCOSE],
  "3040-3": [a("3040-3", "Lipase", "U/L", 13, 60, 0)],
  "1988-5": [a("1988-5", "C-reactive protein", "mg/L", 0, 10, 1)],
  "4537-7": [a("4537-7", "Sedimentation rate", "mm/h", 0, 32, 0)],
  "34714-6": [a("34714-6", "INR", "", 0.9, 1.2, 1, [undefined, 5])],
};

/** Qualitative tests the fake reports as text. */
const QUALITATIVE: Record<string, { loinc: string; display: string; value: string }> = {
  "13955-0": { loinc: "13955-0", display: "Hepatitis C virus Ab", value: "Nonreactive" },
  "56888-1": { loinc: "56888-1", display: "HIV 1+2 Ab + HIV1 p24 Ag", value: "Nonreactive" },
  "626-2": {
    loinc: "626-2",
    display: "Streptococcus pyogenes culture",
    value: "No group A Streptococcus isolated",
  },
};

export function flagFor(an: Pick<Analyte, "low" | "high" | "critLow" | "critHigh">, v: number) {
  if (an.critHigh !== undefined && v >= an.critHigh) return "HH";
  if (an.critLow !== undefined && v <= an.critLow) return "LL";
  if (v > an.high) return "H";
  if (v < an.low) return "L";
  return "N";
}

const rangeText = (an: Analyte) => (an.low <= 0 ? `<${an.high}` : `${an.low}-${an.high}`);

function seededFraction(key: string, i: number) {
  const h = createHash("sha256").update(`${key}:${i}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

export interface FakeOrder {
  placerOrderNumber: string;
  accessionNumber: string;
  testCode: string;
  display: string;
  loincCode: string | null;
  collectedAt: Date | null;
}

export interface FakeResultOptions {
  /** Override values by analyte LOINC, e.g. {"2823-3": 6.6} for a critical potassium. */
  values?: Record<string, number>;
  status?: "P" | "F" | "C";
  /** Patient identity as the lab has it (tests use this to produce an unmatched result). */
  patient: { mrn: string; lastName: string; firstName: string; birthDate: string; sex: string };
  practiceId: string;
  lab: string;
  at?: Date;
  comments?: string[];
}

export function analytesFor(loinc: string | null): Analyte[] {
  return (loinc && PANELS[loinc]) || [];
}

/** ORU for one order, as the lab would send it. */
export function fakeOru(order: FakeOrder, o: FakeResultOptions): string {
  const at = o.at ?? new Date();
  const qual = order.loincCode ? QUALITATIVE[order.loincCode] : undefined;
  const observations: OruInput["orders"][number]["observations"] = qual
    ? [
        {
          loinc: qual.loinc,
          display: qual.display,
          value: qual.value,
          valueType: "ST",
          unit: "",
          range: "",
          flag: "N",
        },
      ]
    : analytesFor(order.loincCode).map((an, i) => {
        const v =
          o.values?.[an.loinc] ??
          Number(
            (
              an.low +
              (an.high - an.low) * (0.2 + 0.6 * seededFraction(order.placerOrderNumber, i))
            ).toFixed(an.decimals),
          );
        return {
          loinc: an.loinc,
          display: an.display,
          value: v.toFixed(an.decimals),
          unit: an.unit,
          range: rangeText(an),
          flag: flagFor(an, v),
        };
      });
  return buildOru({
    messageControlId: `FK${at.getTime()}${order.placerOrderNumber.slice(-4)}`,
    lab: o.lab,
    receivingFacility: o.practiceId,
    at,
    patient: o.patient,
    orders: [
      {
        placerOrderNumber: order.placerOrderNumber,
        fillerOrderNumber: order.accessionNumber,
        testCode: order.testCode,
        display: order.display,
        loincCode: order.loincCode,
        resultStatus: o.status ?? "F",
        observedAt: order.collectedAt ?? at,
        observations,
        comments: o.comments,
      },
    ],
  });
}
