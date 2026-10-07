# Build slices

Build vertical slices in order. Each slice is done when its flows run end to end against fake gateways, its invariants have passing tests, and `npm run validate` passes. The machine-readable version is `spec/slices.yaml`.

## S0 — Foundation
Tenancy, auth with MFA, RBAC from `spec/roles.yaml`, audit log, Patient + Coverage model, gateway interfaces with fakes, design system tokens, app shell with left rail and command bar.
Invariants: INV-SEC-01, INV-SEC-02, INV-SEC-04, INV-ID-02, INV-ID-04.

## S1 — Patient access and front desk
Calendar, booking drawer, registration, eligibility (fake 270/271), reminders, flow board, front desk home, check-in with payment capture.
Flows: `access` (steps 01–04, 06), `checkin` (01–03).
Invariants: INV-ID-01, INV-FIN-01, INV-FIN-02.

## S2 — Clinical core
Chart context and banner, summary, problems, meds, allergies, vitals, rooming, encounter note with templates, diagnoses, sign/addendum, co-sign rules, AVS, checkout, provider and MA homes.
Flows: `checkin` (04–05), `encounter` (01–03, 07–08), `access/07`.
Invariants: INV-ID-01, INV-ID-03, INV-SAFE-01, INV-SAFE-02, INV-SAFE-08, INV-DATA-01, INV-DATA-02, INV-DATA-03.

## S3 — Orders and results
Order entry with compendium and AOE, lab gateway (fake HL7), result ingestion and matching, reconciliation queue, results inbox, order tracking.
Flows: `encounter/04`, `results`.
Invariants: INV-SAFE-03, INV-SAFE-04, INV-SAFE-07, INV-OPS-01.

## S4 — Prescribing
Rx composer, med reconciliation, DUR alerts, PDMP and EPCS through `ErxGateway`/`PdmpGateway`, renewal and change requests in inbox.
Flows: `encounter/05`, `refills`.
Invariants: INV-SAFE-05, INV-SAFE-06.

## S5 — Revenue cycle
Charge capture and coding, charge review, scrubber, 837P, 999/277CA, ERA posting, denials, statements, payment plans, day close, patient account.
Flows: `encounter/06`, `rcm`.
Invariants: INV-FIN-01..05, INV-SEC-05.

## S6 — Inbox, referrals, documents
Unified inbox with pools and SLAs, patient messages, document/fax filing, referrals worklist and loop closure, prior auth tasks.
Flows: `refills`, `referral`.
Invariants: INV-SEC-06, INV-OPS-01.

## S7 — Patient portal
Portal home, self-booking, e-check-in, forms, messages, results, record download, billing, proxy access.
Flows: `access/01`, `access/05`, `results/05`, `rcm/08`.
Invariants: INV-DATA-01, INV-SEC-03, INV-SEC-06.

## S8 — Reporting, quality, telehealth, admin completion
Reports with drill-down, registries, care gaps, CCM time tracking, eCQM, telehealth modality, remaining admin screens, downtime snapshot.
Flows: `quality`.
Invariants: INV-OPS-02.
