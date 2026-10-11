/**
 * Loads the reference code sets in prisma/reference-data (see its README for sources) into CodeConcept
 * (docs/ehr-spec/docs/11-integrations.md#reference-data). Idempotent: safe to run on every deploy (seed.ts calls it).
 * Codes in the current file are upserted active; codes that disappear from a newer release are flagged inactive,
 * never deleted (historical charts and claims reference them).
 *
 * CPT is AMA-licensed and is not shipped here; a licensed practice loads it with importCodeSystem.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PrismaClient } from "../generated/prisma-client/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "reference-data");

function readTsv(filename: string): string[][] {
  return readFileSync(join(DATA_DIR, filename), "utf-8")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split("\t"));
}

// CMS publishes ICD-10-CM as fixed-width text: code, run of spaces, description.
function readFixedWidthCodes(filename: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  readFileSync(join(DATA_DIR, filename), "utf-8")
    .split("\n")
    .forEach((line, i) => {
      const clean = line.replace(/\r$/, "");
      if (!clean.trim()) return;
      const m = /^(\S+)\s+(.*\S)\s*$/.exec(clean);
      if (!m) throw new Error(`${filename}: malformed line ${i + 1}`);
      rows.push([m[1]!, m[2]!]);
    });
  return rows;
}

function readCsv(filename: string): string[][] {
  const rows: string[][] = [];
  for (const line of readFileSync(join(DATA_DIR, filename), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"' && line[i + 1] === '"' && quoted) {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.replace(/\r$/, ""));
    rows.push(cells);
  }
  return rows;
}

/** ICD-10-CM codes are stored dotted (E11.9), the way clinicians read them; claims strip the dot. */
export const dotIcd10 = (code: string) =>
  code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;

type Row = { code: string; display: string; billable?: boolean | null; attributes?: object | null };
const CHUNK = 5000;

async function upsertSystem(
  prisma: PrismaClient,
  system: string,
  sourceVersion: string,
  rows: Row[],
) {
  let changed = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    changed += await prisma.$executeRaw`
      INSERT INTO "CodeConcept" (id, system, code, display, billable, attributes, "sourceVersion", active)
      SELECT gen_random_uuid(), ${system}::"CodeSystem", c, d, b, a::jsonb, ${sourceVersion}, true
      FROM unnest(${chunk.map((r) => r.code)}::text[], ${chunk.map((r) => r.display)}::text[],
                  ${chunk.map((r) => r.billable ?? null)}::boolean[], ${chunk.map((r) => (r.attributes ? JSON.stringify(r.attributes) : null))}::text[])
        AS t(c, d, b, a)
      ON CONFLICT (system, code, "sourceVersion") DO UPDATE
        SET display = EXCLUDED.display, billable = EXCLUDED.billable, attributes = EXCLUDED.attributes, active = true
      WHERE "CodeConcept".display IS DISTINCT FROM EXCLUDED.display OR NOT "CodeConcept".active
         OR "CodeConcept".attributes IS DISTINCT FROM EXCLUDED.attributes`;
  }
  const retired = await prisma.$executeRaw`
    UPDATE "CodeConcept" SET active = false
    WHERE system = ${system}::"CodeSystem" AND active AND code <> ALL(${rows.map((r) => r.code)}::text[])`;
  return { total: rows.length, changed, retired };
}

export async function loadReferenceData(prisma: PrismaClient): Promise<void> {
  // CMS FY2027 ICD-10-CM: the codes file lists billable (leaf) codes only.
  const icd = await upsertSystem(
    prisma,
    "ICD10CM",
    "ICD-10-CM 2027",
    readFixedWidthCodes("icd10cm_codes_2027.txt").map(([code, display]) => ({
      code: dotIcd10(code),
      display,
      billable: true,
    })),
  );
  const cvx = await upsertSystem(
    prisma,
    "CVX",
    "CDC CVX 2026-08-08",
    readTsv("cvx_codes.tsv").map(([code, display, status]) => ({
      code: code!.trim(),
      display: display!,
      attributes: { status },
    })),
  );
  const loinc = await upsertSystem(
    prisma,
    "LOINC",
    "LOINC subset 2026-08-08",
    readTsv("loinc_subset.tsv").map(([code, display]) => ({ code: code!, display: display! })),
  );
  const pos = await upsertSystem(
    prisma,
    "POS",
    "CMS POS",
    readCsv("pos_codes.csv")
      .slice(1)
      .map(([code, name, description]) => ({
        code: code!,
        display: name!,
        attributes: { description },
      })),
  );
  // CPT/HCPCS and CARC/RARC: curated subsets until the licensed/full lists are imported (OPEN-Q23).
  const proc = readTsv("procedure_codes.tsv").filter((r) => !r[0]!.startsWith("#"));
  for (const system of ["CPT", "HCPCS"])
    await upsertSystem(
      prisma,
      system,
      "Curated subset 2026-10",
      proc
        .filter((r) => r[0] === system)
        .map(([, code, category, mue, display]) => ({
          code: code!,
          display: display!,
          billable: true,
          attributes: { category, ...(mue ? { mue: Number(mue) } : {}) },
        })),
    );
  const adj = readTsv("adjustment_codes.tsv").filter((r) => !r[0]!.startsWith("#"));
  for (const system of ["CARC", "RARC"])
    await upsertSystem(
      prisma,
      system,
      "Curated subset 2026-10",
      adj
        .filter((r) => r[0] === system)
        .map(([, code, display]) => ({ code: code!, display: display! })),
    );
  console.log(`Reference data: CPT/HCPCS ${proc.length}, CARC/RARC ${adj.length}`);
  console.log(
    `Reference data: ICD-10-CM ${icd.total} (${icd.changed} changed, ${icd.retired} retired), CVX ${cvx.total}, LOINC ${loinc.total}, POS ${pos.total}`,
  );
}
