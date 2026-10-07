# Invariants

Rules the system must never break. Each one should have at least one automated test named with its ID.
Format: **ID — rule.** *Why.* Enforced at: where. Test: how to prove it.

The machine-readable index of these IDs is in `spec/invariants.yaml`; keep both in sync.

## Patient identity (INV-ID)
- **INV-ID-01 — Every patient-context screen shows full name, DOB and MRN in a banner that cannot scroll away or truncate those fields.** *Wrong-patient errors are a leading EHR safety event.* Enforced at: chart shell layout. Test: visual/DOM test on every route under `chart.*`, `encounter.*`.
- **INV-ID-02 — Creating a patient runs a duplicate search (name + DOB + phone) and shows matches before save.** *Duplicates split the record.* Enforced at: `patients.registration` API. Test: create with existing DOB+name returns `possibleDuplicates`.
- **INV-ID-03 — Signing orders or Rx requires the patient context to equal the encounter's patient.** *Prevents signing in the wrong tab.* Enforced at: sign API compares IDs server-side. Test: mismatched patientId → 409.
- **INV-ID-04 — Merging patients is reversible and audited; records are never hard-deleted.** Enforced at: merge service. Test: unmerge restores both.

## Clinical safety (INV-SAFE)
- **INV-SAFE-01 — Only users whose role grants `sign` for that item type may sign notes, orders, Rx or results.** Others can only pend. Enforced at: authorization layer, not UI. Test: MA token → 403 on sign endpoints.
- **INV-SAFE-02 — Signed notes are immutable. Changes are addenda with author and time.** Test: PATCH on signed note → 409; addendum creates new record.
- **INV-SAFE-03 — An inbound result that cannot be matched to exactly one patient and order goes to the reconciliation queue. It is never auto-filed.** Enforced at: result ingestion. Test: ORU with ambiguous demographics → `orders.result-reconciliation` task, not in any chart.
- **INV-SAFE-04 — Critical results create an escalating task that cannot be closed without documented communication.** Test: closing a critical result task without a contact note → 422.
- **INV-SAFE-05 — Controlled substance prescriptions require EPCS two-factor signing and a recorded PDMP check (or recorded exception).** Enforced at: eRx vendor + our pre-sign check. Test: sign without PDMP record → blocked.
- **INV-SAFE-06 — Drug-allergy and severe drug-drug interaction alerts are interruptive; overriding requires a reason that is stored and reportable.** Test: override without reason → 422.
- **INV-SAFE-07 — Every order has an expected-by date; orders past it without a result appear in `orders.tracking`.** Test: time-travel fixture.
- **INV-SAFE-08 — Note signing is blocked while the encounter has unsigned Rx, orders without a linked diagnosis, or charges without a diagnosis pointer.** Test: pre-flight returns each blocker with a link.

## Data provenance (INV-DATA)
- **INV-DATA-01 — Patient-entered, outside-record, device and AI-drafted data are stored with provenance and enter the active chart only through a staff reconcile action.** See ADR-002. Test: portal med submission does not appear in active med list until accepted.
- **INV-DATA-02 — AI-drafted note text is visibly marked until the author edits or accepts it; signing with unaccepted AI text is blocked.** Test: sign with unaccepted segment → blocker.
- **INV-DATA-03 — Status labels shown anywhere come from `spec/states.yaml`.** Test: lint/codegen check — no hard-coded status strings in UI.

## Privacy & security (INV-SEC)
- **INV-SEC-01 — Every read and write of PHI is written to an append-only audit log with user, patient, action, time and source.** Test: read chart → audit row exists; audit table has no UPDATE/DELETE grants.
- **INV-SEC-02 — Data never crosses tenants.** Enforced at: data access layer (row-level tenant filter), not in individual queries. Test: cross-tenant ID access → 404.
- **INV-SEC-03 — Restricted records (42 CFR Part 2, sensitive notes, adolescent confidential) require consent or break-the-glass with reason; access is time-limited and alerts the privacy officer.** Test: access without reason → 403.
- **INV-SEC-04 — MFA is required for all staff accounts; sessions time out per practice policy; drafts survive timeout.** Test: expired session preserves draft.
- **INV-SEC-05 — Billing-only roles cannot read clinical note bodies by default.** Test: biller token → note body redacted.
- **INV-SEC-06 — SMS and email bodies contain no clinical details; they link to the portal.** Test: template lint.

## Money (INV-FIN)
- **INV-FIN-01 — Ledger entries (charges, payments, adjustments) are append-only; corrections are reversing entries.** Test: no UPDATE on ledger rows.
- **INV-FIN-02 — Patient balance = sum of ledger for that patient; it is never stored as an editable field.** Test: property test across random ledgers.
- **INV-FIN-03 — A charge cannot be sent on a claim without a rendering provider NPI, billing NPI/TIN, POS, and at least one diagnosis pointer.** Test: scrubber rejects.
- **INV-FIN-04 — Day close cannot complete with an unexplained variance between posted payments and deposit.** Test: variance without reason → 422.
- **INV-FIN-05 — Every rejection and denial becomes a work item with a filing deadline.** Test: 277CA rejection → task with `dueAt`.

## Operations (INV-OPS)
- **INV-OPS-01 — Interface failures (lab, clearinghouse, eRx, HIE, IIS) create work items and show on `admin.interfaces`; messages are retried idempotently.** Test: simulated outage → task + retry without duplicates.
- **INV-OPS-02 — A read-only downtime snapshot (today's schedule, patient summaries) is available when the primary system is unavailable.** Test: snapshot job output exists and is current.
