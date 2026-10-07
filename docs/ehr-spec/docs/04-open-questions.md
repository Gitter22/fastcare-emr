# Open questions

The agent adds questions here instead of guessing. Humans answer them; answered items move to an ADR or the spec and are marked Resolved with a link.

| ID | Question | Blocks | Safe default until answered | Status |
|---|---|---|---|---|
| OPEN-Q1 | Tech stack and hosting (language, framework, cloud, HIPAA-eligible services). Database decided: PostgreSQL + Prisma (ADR-009) | All slices | None — must be answered before S0 | Partly resolved |
| OPEN-Q2 | Confirm vendors. Tentative: Stedi (clearinghouse), LogiCoy (eRx/EPCS), Health Gorilla or Quest/LabCorp direct (labs), Twilio + SMTP (messaging), 2FA service TBD; still open: payments, fax, video, HISP | S3–S6 | Fake gateways (ADR-005) | Open |
| OPEN-Q3 | Will we pursue ONC certification in v1, and for which criteria? | S2, S7, S8 | Build to US Core / USCDI shapes anyway | Open |
| OPEN-Q4 | Single-tenant per practice or multi-tenant? | S0 | Multi-tenant with Postgres RLS (ADR-009) | Default implemented |
| OPEN-Q5 | Which states' NP/PA supervision and co-sign rules must be supported at launch? | S2 | Co-sign rule config exists; no rules seeded | Open |
| OPEN-Q6 | Result release timing to portal (immediate vs configured delays and exceptions) | S3, S7 | Immediate release; provider can apply documented exception | Open |
| OPEN-Q7 | Launch specialties (primary care only?) — drives templates, order sets, measures | S2, S8 | Primary care | Open |
| OPEN-Q8 | Ambient AI documentation in v1? Which vendor? | S2 | Off; note editor supports provenance markers | Open |
| OPEN-Q9 | Max simultaneously open charts | S2 | 3 | Open |
| OPEN-Q10 | Adolescent confidentiality rules for proxy access (age thresholds by state) | S7 | Proxy access ends at 12; adolescent account separate | Open |
| OPEN-Q11 | Record retention periods by state (adult and minor records) | S0 retention job | Keep everything; no purge job enabled | Open |
| OPEN-Q12 | Key management: cloud KMS, or a local KMS for on-prem Docker deployments? | S0 | Single master key from the secret store, rotated yearly | Open |
| OPEN-Q13 | Session timeouts (idle and absolute) per role, and whether "remember this device" may skip MFA | S0 | 15 min idle, 12 h absolute; MFA every sign-in | Open |
| OPEN-Q14 | Operations list roles in `x-roles` that the state machine `by` does not (24 transitions, e.g. manager on arriveAppointment, ma/provider on bookAppointment). Which wins? | S1, S5, S6 | Follow `states.yaml` (precedence rule); extra roles get 403 | Open |
| OPEN-Q15 | Breached-password check: agile-emr has no k-anonymity breach service (e.g. HIBP). Add one as a new integration, or keep a local list? | S0 | Local list of common leaked passwords + 12-character minimum + name/email check | Open |
| OPEN-Q16 | WebAuthn (security keys) is specified for staff MFA. Which library/attestation policy? | S0 | TOTP, SMS, email codes and recovery codes only; the security-key option is shown disabled with the reason | Open |
| OPEN-Q17 | Which consents (if any) let staff open a restricted record (VIP, confidential, Part 2) without break-the-glass — e.g. the patient's PCP or care team? | S0, S2 | Every staff read of restricted clinical detail needs an active EmergencyAccessGrant; identity banner and search rows stay visible | Open |
| OPEN-Q18 | Which consents must be on file before a visit (front-desk "Forms" column and arrive checklist)? Should the list be practice-configurable or vary by visit type? | S1 | Every visit needs Notice of Privacy Practices and Financial policy; the list is fixed in code (`REQUIRED_CONSENTS`) | Open |

## Spec corrections made during the build

| Date | Item | Change | Why |
|---|---|---|---|
| 2026-10-07 | `EligibilityCheckDetail.benefits`, `RecallView.attempts`, `InboundResultDetail.candidates`, `TelehealthSessionView.participants`, `DepositBatchView.expected/counted` | Renamed to `benefitLines`, `outreach`, `candidateMatches`, `participantList`, `expectedTotal/countedTotal` | Each view extends a model (`_base`) that already has a field of that name with a different type (object or int vs array/money), so the combined schema could never validate. The model field keeps its meaning. |
| 2026-10-07 | `PaymentCreateRequest.patientId` | Added (optional) | Balance payments at `billing.payment-capture` have no appointment, so the request had no way to say whose ledger to post to. |
| 2026-10-07 | `PatientBanner.balance/eligibility/preferredLanguage/interpreterNeeded`, `AuditEventEntry.patientName/patientMrn/operation`, `DuplicateCandidateView.mergeId/survivorId`, `MfaEnrollmentChallenge.qrCodeDataUrl` | Added | `spec/ui` binds these (banner-balance, banner-language, au-table patient column, unmerge, totp-qr) but the DTOs had no field for them. |
| 2026-10-07 | `MfaFactorType.RECOVERY_CODE`, `PatientContactPoint.valueIndex`, `@encrypted` tags on contact values, member id, TIN, guarantor contacts | Added | Recovery codes had no storage; contact values are encrypted (agile-emr's PHI model) and need a keyed blind index for phone search. |
