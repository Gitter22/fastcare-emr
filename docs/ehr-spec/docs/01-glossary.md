# Glossary

Use these terms in code, UI copy and tests. Code name in backticks.

| Term | Code name | Meaning |
|---|---|---|
| Patient | `Patient` | A person receiving care. One record per real person; duplicates are merged, never deleted. |
| Guarantor | `Guarantor` | Person financially responsible for the patient's balance (parent for a minor). |
| Coverage | `Coverage` | An insurance policy for a patient, ordered primary/secondary/tertiary. |
| Eligibility | `CoverageEligibility` | Result of a 270/271 check: active?, copay, deductible remaining, PCP, auth needs. |
| Appointment | `Appointment` | A booked time slot. Lifecycle in `states.yaml#appointment`. |
| Visit type | `VisitType` | Configured appointment kind: duration, allowed booking channels, default CPT hints. |
| Encounter | `Encounter` | The clinical event for an appointment (or unscheduled contact). Owns the note, orders, Rx, diagnoses and charges. |
| Note | `ClinicalNote` | The signed documentation of an encounter. Lifecycle in `states.yaml#note`. |
| Problem | `Condition` (category problem-list-item) | A persistent diagnosis on the problem list. |
| Encounter diagnosis | `Condition` (category encounter-diagnosis) | ICD-10-CM code addressed at a visit; linked to charges. |
| Order | `ServiceRequest` | Lab, imaging, procedure or referral request. Lifecycle in `states.yaml#order`. |
| Prescription | `MedicationRequest` | An outbound prescription or renewal. |
| Med list entry | `MedicationStatement` | What the patient is actually taking, from any source. |
| Result | `DiagnosticReport` + `Observation` | Lab/imaging results; observations coded in LOINC. |
| Pend | `pend` | Prepare an action for a licensed user to sign. No external effect. |
| Sign | `sign` | Commit an action with legal attestation. Creates audit + external effects. |
| Co-sign | `cosign` | Supervising provider's additional signature where required. |
| Addendum | `Addendum` | Text appended to a signed note. Signed notes are never edited. |
| AVS | `AfterVisitSummary` | Patient-facing summary of the visit. |
| Charge | `ChargeItem` | A billable line: CPT/HCPCS, modifiers, units, Dx pointers, fee. |
| Claim | `Claim` | One 837P submission grouping charges for a payer. Lifecycle in `states.yaml#claim`. |
| ERA | `Remittance` | 835 payment/adjustment file from a payer. |
| CARC / RARC | `carc`, `rarc` | Claim adjustment and remittance advice reason codes on denials/adjustments. |
| Work item | `Task` | Anything in an inbox/worklist: owner, pool, due time, status (`states.yaml#task`). |
| Pool | `WorkPool` | A team queue (e.g. "Dr Rao care team", "Billing") that tasks route to. |
| Flow board | `FlowBoard` | Live view of patients by appointment status within a day. |
| Care gap | `CareGap` | A due preventive or chronic-care action derived from rules. |
| Break-the-glass | `emergencyAccess` | Time-limited access to a restricted record with a recorded reason. |
| Provenance | `Provenance` | Source and author of a clinical fact: entered, patient-reported, outside, device, ai-draft. |
| Tenant | `Practice` | One clinic organization (TIN). Data never crosses tenants. |
