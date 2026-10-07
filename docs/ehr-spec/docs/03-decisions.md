# Decision records

Short ADRs. Status: Accepted unless noted. Add new ones at the bottom; never rewrite an accepted one — supersede it.

## ADR-001 — The patient chart is a context, not a navigation destination
**Context.** Staff move between schedule, inbox and chart dozens of times an hour. A chart buried under "Patients" forces navigation away from the work queue.
**Decision.** Opening a patient (from any list, search, or Cmd/Ctrl+K) mounts a chart context with a pinned banner. The global left rail stays. Up to N charts (practice setting, default 3) can be open as tabs with distinct colours.
**Consequences.** Routing is `/{module}/...` for work queues and `/patient/:id/...` for chart context. Every chart route must render the banner (INV-ID-01). Sign actions check context (INV-ID-03).

## ADR-002 — Nothing enters the active chart without reconciliation
**Context.** Portal forms, outside records (C-CDA, HIE), devices and AI drafts all produce clinical data of varying reliability.
**Decision.** Such data lands in a staged area with `Provenance`. Staff accept, edit or reject each item into the active chart. Accepted items keep their original provenance.
**Consequences.** Each clinical list (meds, allergies, problems, immunizations) has an "incoming" sub-view and reconcile actions. See INV-DATA-01.

## ADR-003 — Pend vs sign
**Context.** MAs and nurses prepare most orders and refills; providers commit them. Supervision rules for NPs/PAs vary by state.
**Decision.** Two verbs across the product: `pend` (no external effect, any clinical role) and `sign` (external effect, permission-gated). Co-sign requirements come from configurable rules per provider and item type.
**Consequences.** Every signable item has `pendedBy`, `signedBy`, `cosignRequired`, `cosignedBy`. Authorization is enforced server-side (INV-SAFE-01). State rules are config, not code (see OPEN-Q5).

## ADR-004 — FHIR R4 / US Core names are the domain vocabulary
**Context.** Certification requires FHIR APIs on US Core, and USCDI defines required data. Mapping a bespoke model to FHIR later is costly.
**Decision.** Domain entities and fields follow FHIR R4 resource names and US Core profile semantics where they exist. Internal storage is relational and optimised for our workflows; a FHIR facade serves the APIs.
**Consequences.** Use codes, not free text, where US Core binds a value set (LOINC, SNOMED CT, RxNorm, ICD-10-CM, CVX). Practice-management entities with no FHIR equivalent (ledger, batches, work pools) use our own names from the glossary.

## ADR-005 — Integrate certified networks, do not build them
**Context.** eRx/EPCS, clearinghouse connectivity, PDMP and IIS connections require certification, network agreements, or state onboarding.
**Decision.** Use vendors behind our own adapter interfaces: `ErxGateway`, `ClearinghouseGateway`, `LabGateway`, `PdmpGateway`, `IisGateway`, `DirectGateway`, `PaymentGateway`, `MessagingGateway`. Each has a fake implementation for tests and local dev.
**Consequences.** UI and domain code never call vendor SDKs directly. Vendor choice is OPEN-Q2.

## ADR-006 — Telehealth is a modality of the same encounter
**Decision.** A video visit is an `Appointment` with `modality: video`; it uses the same encounter, note, coding and claim path with telehealth POS/modifier defaults. No separate telehealth module data.

## ADR-007 — Work-queue homes per role
**Decision.** Each role's home (`spec/roles.yaml#home`) is composed of task lists with counts and a primary action. Generic analytics belong in `reports.*`.

## ADR-008 — Ledger is append-only
**Decision.** All money movements are ledger entries; balances are derived (INV-FIN-01, INV-FIN-02).

## ADR-009 — PostgreSQL with Prisma; tenancy enforced by row-level security
**Decision.** Persistence is PostgreSQL modelled in `data/schema.prisma`. Tenant-scoped tables carry `practiceId` and a Postgres RLS policy; the app sets `app.practice_id` per transaction (INV-SEC-02).
**Why.** A missing `where practiceId` in one query must not leak another practice's PHI. RLS fails closed. Tenant columns without Prisma relations keep the client small.
**Consequence.** RLS policies and append-only grants are hand-written in migrations. Partially answers OPEN-Q1 (database) and OPEN-Q4 (multi-tenant).

## ADR-010 — The OpenAPI file is generated from the schema and route sources
**Decision.** `api/openapi.yaml` is compiled from `data/schema.prisma` and `spec/api/**`. Each operation carries `x-screens`, `x-transitions`, `x-roles`, `x-audit`, `x-integration` and `x-invariants`. The build fails if any screen, transition or gateway is unserved.
**Why.** Model schemas can't drift from the database, and the UI spec, state machines and API are checked against each other on every change.
**Consequence.** Change behaviour in the sources and regenerate; never edit the output.

## ADR-011 — The FHIR R4 endpoint is a read-only projection
**Decision.** `/fhir/r4` builds US Core resources from relational rows on read (search, read, vread, history, `$everything`, Bulk Data). Writes go through the app API only.
**Why.** One write path keeps invariants (staging, sign rules, audit) in one place. The FHIR surface serves patient access (SMART apps), EHI export and payers or partners.
**Consequence.** `ResourceVersion` stores snapshots for `_history`. Only `ACTIVE` rows and permitted security labels are exposed.
