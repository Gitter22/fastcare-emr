/**
 * Minimal HL7 v2.5.1 codec for lab orders (ORM^O01) and results (ORU^R01). Only the segments and fields the order
 * and result flows use are read or written; everything else in an inbound message is kept verbatim in the stored
 * payload. Encoding characters are the defaults (|^~\&).
 */

const ESC: Array<[string, string]> = [
  ["\\", "\\E\\"],
  ["|", "\\F\\"],
  ["^", "\\S\\"],
  ["~", "\\R\\"],
  ["&", "\\T\\"],
];

export const escapeHl7 = (v: string) => ESC.reduce((s, [c, e]) => s.split(c).join(e), v);
export const unescapeHl7 = (v: string) =>
  [...ESC].reverse().reduce((s, [c, e]) => s.split(e).join(c), v);

/** yyyyMMddHHmmss in UTC (HL7 TS without offset is read as UTC on both sides). */
export function hl7Time(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function parseHl7Time(v: string | undefined): Date | null {
  const m = v ? /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(v) : null;
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export const hl7Date = (iso: string) => iso.replace(/-/g, "");
export function parseHl7Date(v: string | undefined): string | null {
  const m = v ? /^(\d{4})(\d{2})(\d{2})/.exec(v) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

type Field = string | Array<string | undefined> | undefined | null;
const field = (f: Field) =>
  f == null ? "" : Array.isArray(f) ? f.map((c) => escapeHl7(c ?? "")).join("^") : escapeHl7(f);

/** One segment: name followed by fields 1..n. */
export const segment = (name: string, fields: Field[]) => [name, ...fields.map(field)].join("|");

/** MSH carries the encoding characters literally in MSH-2, so it is written without escaping that field. */
const msh = (fields: Field[]) => `MSH|^~\\&|${fields.map(field).join("|")}`;

export interface Segment {
  name: string;
  /** fields[n] is HL7 field n (fields[0] is the segment name). Components split on ^, unescaped. */
  fields: string[][];
}

export function parseMessage(raw: string): Segment[] {
  return raw
    .replace(/\r\n|\n/g, "\r")
    .split("\r")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const name = parts[0]!;
      // MSH-1 is the field separator itself, so MSH fields are offset by one.
      const values = name === "MSH" ? ["MSH", "|", ...parts.slice(1)] : parts;
      return {
        name,
        fields: values.map((v, i) =>
          name === "MSH" && i === 2 ? [v] : v.split("^").map(unescapeHl7),
        ),
      };
    });
}

export const comp = (s: Segment | undefined, f: number, c = 1): string =>
  s?.fields[f]?.[c - 1]?.trim() ?? "";

// ---------- ORM^O01 ----------

export interface OrmInput {
  messageControlId: string;
  sendingFacility: string;
  receivingLab: string;
  at: Date;
  patient: {
    mrn: string;
    lastName: string;
    firstName: string;
    middleName?: string | null;
    birthDate: string;
    sex: string;
  };
  order: {
    placerOrderNumber: string;
    testCode: string;
    display: string;
    loincCode?: string | null;
    priority: "ROUTINE" | "URGENT" | "ASAP" | "STAT";
    orderingProvider: { npi: string | null; lastName: string; firstName: string };
    diagnoses: Array<{ code: string; display: string }>;
    aoe: Array<{ code: string; text: string; answer: string }>;
    collectedAt?: Date | null;
  };
}

const PRIORITY: Record<OrmInput["order"]["priority"], string> = {
  ROUTINE: "R",
  URGENT: "A",
  ASAP: "A",
  STAT: "S",
};

export function buildOrm(o: OrmInput): string {
  const p = o.patient;
  const ord = o.order;
  const prov = [
    ord.orderingProvider.npi ?? "",
    ord.orderingProvider.lastName,
    ord.orderingProvider.firstName,
  ];
  return [
    msh([
      "AGILEEMR",
      o.sendingFacility,
      o.receivingLab,
      o.receivingLab,
      hl7Time(o.at),
      "",
      ["ORM", "O01"],
      o.messageControlId,
      "P",
      "2.5.1",
    ]),
    segment("PID", [
      "1",
      "",
      [p.mrn, "", "", "AGILEEMR", "MR"],
      "",
      [p.lastName, p.firstName, p.middleName ?? ""],
      "",
      hl7Date(p.birthDate),
      p.sex,
    ]),
    segment("ORC", [
      "NW",
      ord.placerOrderNumber,
      "",
      "",
      "",
      "",
      "",
      "",
      hl7Time(o.at),
      "",
      "",
      prov,
    ]),
    segment("OBR", [
      "1",
      ord.placerOrderNumber,
      "",
      [ord.testCode, ord.display, "L", ord.loincCode ?? "", "", ord.loincCode ? "LN" : ""],
      PRIORITY[ord.priority],
      "",
      ord.collectedAt ? hl7Time(ord.collectedAt) : "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      prov,
    ]),
    ...ord.diagnoses.map((d, i) =>
      segment("DG1", [String(i + 1), "I10", [d.code, d.display, "I10"]]),
    ),
    ...ord.aoe.map((a, i) =>
      segment("OBX", [
        String(i + 1),
        "ST",
        [a.code, a.text, "L"],
        "",
        a.answer,
        "",
        "",
        "",
        "",
        "",
        "F",
      ]),
    ),
  ].join("\r");
}

// ---------- ORU^R01 ----------

export interface OruObservation {
  code: string;
  display: string;
  codeSystem: string;
  valueType: string;
  value: string;
  unit: string;
  referenceRange: string;
  abnormalFlag: string;
  status: string;
  observedAt: Date | null;
}

export interface OruOrder {
  placerOrderNumber: string;
  fillerOrderNumber: string;
  testCode: string;
  display: string;
  loincCode: string;
  /** OBR-25: P preliminary, F final, C correction, X cancelled. */
  resultStatus: string;
  observedAt: Date | null;
  resultedAt: Date | null;
  observations: OruObservation[];
  comments: string[];
}

export interface Oru {
  messageControlId: string;
  sendingLab: string;
  receivingFacility: string;
  patient: {
    mrn: string;
    lastName: string;
    firstName: string;
    birthDate: string | null;
    sex: string;
  };
  orders: OruOrder[];
}

export class Hl7Error extends Error {}

export function parseOru(raw: string): Oru {
  const segs = parseMessage(raw);
  const header = segs[0];
  if (header?.name !== "MSH") throw new Hl7Error("Message does not start with MSH.");
  if (comp(header, 9, 1) !== "ORU")
    throw new Hl7Error(`Expected ORU, got ${comp(header, 9, 1) || "nothing"}.`);
  const pid = segs.find((s) => s.name === "PID");
  if (!pid) throw new Hl7Error("ORU has no PID segment.");
  const orders: OruOrder[] = [];
  let current: OruOrder | null = null;
  for (const s of segs) {
    if (s.name === "OBR") {
      const code = comp(s, 4, 1);
      const alt = comp(s, 4, 4);
      current = {
        placerOrderNumber: comp(s, 2),
        fillerOrderNumber: comp(s, 3),
        testCode: code,
        display: comp(s, 4, 2) || comp(s, 4, 5),
        loincCode: comp(s, 4, 3) === "LN" ? code : comp(s, 4, 6) === "LN" ? alt : "",
        resultStatus: comp(s, 25) || "F",
        observedAt: parseHl7Time(comp(s, 7)),
        resultedAt: parseHl7Time(comp(s, 22)),
        observations: [],
        comments: [],
      };
      orders.push(current);
    } else if (s.name === "OBX" && current) {
      current.observations.push({
        code: comp(s, 3, 1),
        display: comp(s, 3, 2),
        codeSystem: comp(s, 3, 3),
        valueType: comp(s, 2),
        value: s.fields[5]?.join("^").trim() ?? "",
        unit: comp(s, 6, 1),
        referenceRange: comp(s, 7),
        abnormalFlag: comp(s, 8),
        status: comp(s, 11) || "F",
        observedAt: parseHl7Time(comp(s, 14)),
      });
    } else if (s.name === "NTE" && current) {
      const text = s.fields[3]?.join("^").trim();
      if (text) current.comments.push(text);
    }
  }
  if (!orders.length) throw new Hl7Error("ORU has no OBR segment.");
  return {
    messageControlId: comp(header, 10),
    sendingLab: comp(header, 4) || comp(header, 3),
    receivingFacility: comp(header, 6),
    patient: {
      mrn: comp(pid, 3, 1),
      lastName: comp(pid, 5, 1),
      firstName: comp(pid, 5, 2),
      birthDate: parseHl7Date(comp(pid, 7)),
      sex: comp(pid, 8),
    },
    orders,
  };
}

export interface OruInput {
  messageControlId: string;
  lab: string;
  receivingFacility: string;
  at: Date;
  patient: { mrn: string; lastName: string; firstName: string; birthDate: string; sex: string };
  orders: Array<{
    placerOrderNumber: string;
    fillerOrderNumber: string;
    testCode: string;
    display: string;
    loincCode?: string | null;
    resultStatus: "P" | "F" | "C";
    observedAt: Date;
    observations: Array<{
      loinc: string;
      display: string;
      value: string;
      valueType?: "NM" | "ST";
      unit: string;
      range: string;
      flag: string;
    }>;
    comments?: string[];
  }>;
}

export function buildOru(o: OruInput): string {
  const out = [
    msh([
      o.lab,
      o.lab,
      "AGILEEMR",
      o.receivingFacility,
      hl7Time(o.at),
      "",
      ["ORU", "R01"],
      o.messageControlId,
      "P",
      "2.5.1",
    ]),
    segment("PID", [
      "1",
      "",
      [o.patient.mrn, "", "", "AGILEEMR", "MR"],
      "",
      [o.patient.lastName, o.patient.firstName],
      "",
      hl7Date(o.patient.birthDate),
      o.patient.sex,
    ]),
  ];
  o.orders.forEach((ord, i) => {
    out.push(
      segment("OBR", [
        String(i + 1),
        ord.placerOrderNumber,
        ord.fillerOrderNumber,
        [ord.testCode, ord.display, "L", ord.loincCode ?? "", "", ord.loincCode ? "LN" : ""],
        "",
        "",
        hl7Time(ord.observedAt),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        hl7Time(o.at),
        "",
        "",
        ord.resultStatus,
      ]),
    );
    ord.observations.forEach((x, j) =>
      out.push(
        segment("OBX", [
          String(j + 1),
          x.valueType ?? "NM",
          [x.loinc, x.display, "LN"],
          "",
          x.value,
          x.unit,
          x.range,
          x.flag,
          "",
          "",
          ord.resultStatus === "C" ? "C" : ord.resultStatus,
          "",
          "",
          hl7Time(ord.observedAt),
        ]),
      ),
    );
    (ord.comments ?? []).forEach((c, j) => out.push(segment("NTE", [String(j + 1), "L", c])));
  });
  return out.join("\r");
}
