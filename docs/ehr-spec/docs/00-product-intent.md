# Product intent

## What this is
A single product that runs a small-to-medium US outpatient clinic end to end: scheduling, registration, clinical documentation, orders, prescribing, results, patient communication, billing and reporting. Clinical (EHR) and practice management (PM/RCM) share one patient, one encounter and one audit trail.

## Who it is for
Independent primary care and single-specialty practices with 2–25 providers, 1–5 locations, and staff who play several roles at once (the front desk person may also post payments). Seven roles are defined in `spec/roles.yaml`.

## The job, in one sentence
Get a patient from "I need to be seen" to "visit documented, results acted on, claim paid, balance collected" with the fewest clicks and no safety or compliance gaps.

## Design principles
1. **Work queues, not dashboards.** Every role's home is a list of things to do next, ranked by urgency. Every number drills down to records.
2. **The patient chart is a context, not a page.** It opens from anywhere and pins the patient banner until closed (ADR-001).
3. **Nothing enters the chart silently.** Patient-entered, outside, device and AI-generated data are reconciled by staff and keep their provenance (ADR-002).
4. **Pend vs sign.** Anyone can prepare work; only licensed roles commit clinical actions (ADR-003).
5. **Failures are work items.** An interface error, a rejected claim, an unmatched result becomes a task with an owner — never only a log line.
6. **Same words everywhere.** Status labels in lists, chips, filters and reports come from `spec/states.yaml` and nowhere else.
7. **Fast for daily users.** Keyboard-first, bulk actions, favourites. A front-desk booking should take under 60 seconds.

## Success measures
Tracked per flow in `spec/flows.yaml` (`measures`). Product-level: note close time, charge lag, clean-claim rate, days in AR, result-to-sign time, message turnaround, no-show rate.

## Non-goals (for v1)
- Inpatient, emergency department, or surgical center workflows
- Pharmacy dispensing, lab information system (LIS), PACS/image storage
- Building our own clearinghouse or eRx network (we integrate)
- Specialty-specific modules (dental charting, ophthalmology devices, OB flowsheets) beyond what templates provide
- Multi-country support; US only
