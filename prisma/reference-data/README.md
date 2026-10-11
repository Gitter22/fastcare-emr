# Reference data (Step 3 — FRD Sec. 24-25)

These files are real, unmodified subsets of official public code sets, loaded
into the non-tenant-scoped `DiagnosisCode` / `VaccineCode` / `LabTestCode`
tables by `prisma/loadReferenceData.ts` (invoked from `prisma/seed.ts`). No
code, name, or description in these files was invented.

## `cvx_codes.tsv` — CVX (vaccine codes)

Source: CDC, `https://www2a.cdc.gov/vaccines/iis/iisstandards/downloads/cvx.txt`
(fetched 2026-08-08). Format: `cvxCode<TAB>name<TAB>status`. This is the
**complete** CVX set (289 codes, Active and Inactive) — small enough to load
in full, so no subsetting was needed.

## `icd10cm_codes_2027.txt` — ICD-10-CM (diagnosis codes)

Source: CMS FY2027 ICD-10-CM code descriptions (tabular order),
`icd10cm_codes_2027.txt` from the CMS zip. **Complete set: 74,879 codes**, loaded
verbatim. Format is CMS fixed-width text, not TSV: `code<spaces>description`,
CRLF line endings, undotted codes (`E119`). `loadReferenceData.ts` parses it with
`readFixedWidthCodes` and fails loudly on a malformed line.

Loaded on every seed run (every deploy) as an upsert: new codes are inserted and
changed descriptions are updated; unchanged rows are not touched. Codes retired
from a newer file are **not** deleted, since historical problems/notes may
reference them; they are flagged `isActive = false` (hidden from the
`/reference/diagnosis-codes` search, still resolvable for existing charts and
lab-order descriptions) and flip back to active if a later file restores them. To refresh for a new CMS release: drop in the new file, update
`ICD10_FILE` in `loadReferenceData.ts`, redeploy.

## Drugs (RxNorm) — no longer a static file

The old 20-row `rxnorm_subset.tsv` stub and its `DrugReference` table were
removed. Drug search now queries NLM RxNav live (see
`apps/api/src/providers/drugTerminologyProvider.ts`) and stores each selected
product in the shared `DrugConcept` table. Seed data references
`prisma/fixtures/drug_concepts.json`, regenerated with
`prisma/scripts/captureDrugConcepts.ts`.

## Explicitly deferred (not loaded)

- **SNOMED CT** — still not loaded as a local table. The Allergies type-ahead
  (branch `feat/allergen-coding`) stores SNOMED/RxNorm codes on `Allergy` and
  looks them up live from a FHIR terminology server instead -- see
  `apps/api/src/providers/allergenTerminologyProvider.ts` and HANDOFF.md.
  SNOMED CT use still requires a licence (e.g. UMLS affiliate).

LOINC (needed for `LabTestCode`, Step 4) is loaded -- see
`loinc_subset.tsv` above. It was deferred out of Step 3 per this project's
"don't add models/data ahead of the step that needs them" convention, then
added here once Step 4 needed it.

## `loinc_subset.tsv` — LOINC (lab test codes, Step 4)

Source: NLM Clinical Table Search Service,
`https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search` (fetched
live, one exact-code lookup per row, 2026-08-08). This is NLM's public,
no-registration LOINC search API -- the same category of solution used for
`rxnorm_subset.tsv` in Step 3 (RxNav REST API) to avoid the full LOINC
Table download's free-but-click-through license/registration requirement.
Format: `loincCode<TAB>name` (matches `LabTestCode` exactly).

35 common outpatient lab codes covering CBC/differential components, basic
and comprehensive metabolic panel components, lipid panel components,
thyroid function (TSH, free T4), HbA1c, coagulation (PT/INR), a handful of
urinalysis dipstick components, CRP, and Hepatitis B surface antigen --
enough for the seeded Step 4 lab orders/reports to reference real codes.
Every row was verified individually against the live API by exact-code
match (not fuzzy name search) before being written to this file, so every
name is NLM's own `LONG_COMMON_NAME` for that code, not invented or
paraphrased.

To load the complete ~100k-concept LOINC table instead, register for a free
LOINC account at https://loinc.org, download the full LOINC Table Core
release, and point `loadReferenceData.ts` at that file (same two-column
tab format, no code changes needed beyond the file path).

## `pos_codes.csv` -- CMS Place of Service

Source: the CMS Place of Service Code Set, downloaded from
`https://www.cms.gov/medicare/coding-billing/place-of-service-codes/code-sets`
(the complete published set, 52 codes; columns `Place of Service Code`,
`Place of Service Name`, `Place of Service Description`). Unlike the files
above this one is loaded by **migration**, not `seed.ts`: every location must
reference a valid code and the Phase 0 migration backfills existing rows to
`11`, so the rows have to exist when the migration runs. The `INSERT` in
`prisma/migrations/20261002110000_location_phase0/migration.sql` was generated
from this file. To refresh after a CMS update, add a new migration that
upserts the changed rows (and sets `isActive = false` for retired codes);
do not edit the applied one.

## `procedure_codes.tsv` / `adjustment_codes.tsv` — CPT/HCPCS and CARC/RARC (curated, S5)

Not official files. CPT descriptors are AMA-licensed, so the CPT rows carry short practice-written descriptors (no AMA
text) for common primary-care codes, with the units-per-day limit (MUE) where the edit engine uses one. CARC/RARC
rows are a small abridged subset of the X12 lists used by ERA posting and denials. Replace both with licensed/full
imports (`importCodeSystem`) when available — OPEN-Q23.
