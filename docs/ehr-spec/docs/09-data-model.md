# Data model

`data/schema.prisma` is the persistence model (PostgreSQL, Prisma). It supports every screen in `spec/screens.yaml`, every state machine in `spec/states.yaml`, and the FHIR R4 facade in `spec/api/fhir.yaml`. `npm run db:check` validates it.

## Conventions

| Convention | Rule |
|---|---|
| Names | FHIR R4 resource names for clinical entities (ADR-004). Field names follow the FHIR element where one exists (`clinicalStatus`, `verificationStatus`, `effectiveAt`). |
| Ids | UUID v4 everywhere except `AuditEvent` and `ResourceVersion` (BigInt sequence: append rate, ordering). |
| Status | Status enums mirror `states.yaml` state ids in UPPER_SNAKE. `npm run api` fails if they drift. The `new` pseudo-state has no enum value. |
| Concurrency | Mutable clinical rows carry `version Int`. The API exposes it as the ETag and requires `If-Match` on PATCH; transition endpoints take `version` in the body. |
| Soft delete | No hard deletes of clinical or financial data (INV-ID-04). Use status `ENTERED_IN_ERROR`, `deactivatedAt`, or a reversal entry. |
| Money | `Decimal` with 2 decimal places (`@db.Decimal(10, 2)`); never float. The API sends money as a decimal string. Balances are derived from `LedgerEntry` (INV-FIN-02). |
| Time | `DateTime` is UTC (`timestamptz`). Business dates (`@db.Date`) are in the practice time zone (`Practice.timezone`). |
| Codes | Coded fields store `system` + `code` + `display` as captured. Look-ups validate against `CodeConcept` / `RxNormConcept`, but the stored display is what the clinician saw. |

## Doc-comment tags

The generator and reviewers rely on these tags. Add them to new models and fields.

| Tag | Level | Meaning | Enforced by |
|---|---|---|---|
| `@tenant` | model | Row has `practiceId`; RLS policy isolates tenants | migration (below), INV-SEC-02 |
| `@fhir <Type>` | model | Exposed by the FHIR facade as this resource | `spec/api/fhir.yaml` |
| `@append-only` | model | App role has no UPDATE/DELETE grant | migration grants |
| `@versioned` | model | Each change writes a `ResourceVersion` snapshot | repository layer |
| `@reference` | model | Global reference data, not tenant-scoped | — |
| `@phi` | field | Protected health information | `x-phi` in OpenAPI; log scrubbing |
| `@encrypted` | field | Application-level envelope encryption | repository layer |
| `@secret` | field | Never serialised; excluded from every API schema | generator |
| `@server` | field | Set by the server; excluded from create/update bodies | generator |

## Tenant isolation (INV-SEC-02)

Tenant-scoped tables have a `practiceId` column and no Prisma relation to `Practice` (avoids hundreds of back-relations). Isolation is enforced in Postgres, not only in code:

```sql
-- once per @tenant table, in the migration that creates it
ALTER TABLE "Patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Patient"
  USING ("practiceId" = current_setting('app.practice_id')::uuid)
  WITH CHECK ("practiceId" = current_setting('app.practice_id')::uuid);
```

Each request runs in a transaction that first executes `SET LOCAL app.practice_id = '<from token>'` (Prisma: `$transaction` with `$executeRaw`, or a client extension). The app connects as a role without `BYPASSRLS`. Migrations and the bulk-export worker use separate roles. A test per slice proves a query without the setting returns zero rows.

## Append-only tables

`AuditEvent`, `LedgerEntry`, `ResourceVersion`, `ProvenanceRecord`, `DisclosureLog`, `ClaimEvent`, `AppointmentStatusEvent`, `Addendum` and `OutboxEvent` (except `dispatchedAt`) are append-only:

```sql
REVOKE UPDATE, DELETE ON "AuditEvent", "LedgerEntry", "ResourceVersion" FROM app_role;
```

`AuditEvent.hash = sha256(prevHash || canonical(row))` makes tampering detectable. A nightly job verifies the chain and writes the head hash to the WORM backup.

## Staging and provenance (ADR-002, INV-DATA-01)

Clinical list rows (`Condition`, `AllergyIntolerance`, `MedicationStatement`, `Immunization`, `Observation`, `FamilyMemberHistory`) carry `stagingStatus` and `source`. Outside, patient-reported and interface data arrive `STAGED` and become `ACTIVE` only through a reconcile operation. Every create, reconcile and AI acceptance writes a `ProvenanceRecord`. Patient demographics changed from the portal go through `StagedChange`.

Queries for the chart, CDS, claims and FHIR filter `stagingStatus = ACTIVE`.

## Restricted records

`securityLabels` on Patient and sensitive clinical rows (e.g. `R`, `VIP`, `42CFRPart2`) gate reads. Without a matching consent or an active `EmergencyAccessGrant`, the API returns 403 `restricted_record` and the FHIR facade omits the row. Billing roles see note metadata but not note bodies (INV-SEC-05).

## Files

`FileObject` rows describe files on the Docker volume mounted at `/data/files`. `storageKey` is server-generated (`<practiceId>/<yyyy>/<mm>/<uuid>`), never derived from user input. Each file is encrypted with its own data key (AES-256-GCM); the key is wrapped by the KMS key and stored in `wrappedDataKey` (`@secret`). Files are served only through `GET /files/{fileId}` after an access check and audit write. Back up the volume with the database; restore both together.

## FHIR R4 mapping

The facade reads the relational model and builds US Core 6.1.0 resources. It does not store FHIR JSON.

| FHIR resource | Source model(s) | Notes |
|---|---|---|
| Patient | Patient, PatientIdentifier, PatientAddress, PatientContactPoint | race/ethnicity extensions from CDC REC codes; `birthsex` and `sex` per US Core 6.1 |
| Practitioner / PractitionerRole | Practitioner, UserRole, Location | NPI identifier; taxonomy as specialty |
| Organization | Practice, Payer, Pharmacy | |
| Location | Location | POS code as `type` |
| Encounter | Encounter | class from `EncounterClass` |
| Condition | Condition | category problem-list / encounter-diagnosis / health-concern |
| AllergyIntolerance | AllergyIntolerance | NKA as a negated record |
| MedicationRequest | MedicationRequest, MedicationStatement | statements as `intent=plan`, `reported=true` |
| Observation | Observation | vital signs, labs, smoking status, screening, SDOH profiles by category |
| DiagnosticReport | DiagnosticReport | lab and note categories |
| DocumentReference | DocumentReference, ClinicalNote, AfterVisitSummary | signed notes only; content via Binary |
| Immunization | Immunization | CVX code, lot, VIS |
| Procedure | Procedure, ChargeItem | in-office procedures |
| ServiceRequest | ServiceRequest, Referral | |
| CarePlan, Goal | CarePlan, Goal | |
| CareTeam | WorkPool + PCP | |
| Coverage | Coverage | |
| Device | Device | implantable devices with UDI |
| Specimen | Specimen | |
| QuestionnaireResponse | QuestionnaireResponse | |
| RelatedPerson, FamilyMemberHistory | same | |
| Provenance | ProvenanceRecord | |
| Appointment, Consent | same | base profiles |

`meta.versionId` = `version`; `_history` and `vread` read `ResourceVersion`. `meta.lastUpdated` = `updatedAt`. Search parameters per resource are in `spec/api/fhir.yaml`.

## Retention

| Data | Minimum retention | Mechanism |
|---|---|---|
| Medical record (adult) | State law; commonly 7–10 years after last visit | OPEN-Q11 (state list) |
| Minor's record | Until age of majority + state period | OPEN-Q11 |
| HIPAA documentation (policies, consents, audit, disclosures, BAAs) | 6 years from creation or last effective date (§164.316(b)(2)) | no purge before 6 years |
| Ledger and claims | 7 years (payer and tax rules) | |

Retention jobs set `FileObject.deletedAt` and purge content; they never delete audit rows.
