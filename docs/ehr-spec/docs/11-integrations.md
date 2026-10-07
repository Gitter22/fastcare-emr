# Integrations

Domain code calls gateway interfaces (`spec/integrations.yaml`, ADR-005). Each gateway has one adapter per vendor and a fake for tests and local development. In the OpenAPI file, `x-integration` names the gateway an operation uses; `npm run api` fails if a gateway has no operation.

## Gateways and vendors

| Gateway | Tentative vendor | Outbound (operations) | Inbound | PHI / BAA |
|---|---|---|---|---|
| ClearinghouseGateway | Stedi | `checkEligibility`, `runEligibilityBatch` (270/271), `submitClaims`, `resubmitClaim` (837P), `checkClaimStatus` (276/277) | `POST /webhooks/stedi`: 999, 277CA, 835 available | yes |
| LabGateway | Health Gorilla, or Quest and LabCorp direct | `signOrders`, `sendServiceRequest`, `cancelServiceRequest`, `checkOrderStatusWithLab`, `importLabCompendium`, `rejectInboundResult` | `POST /webhooks/labs/{provider}`: ORU results, order acks | yes |
| ErxGateway | LogiCoy | `checkPrescription` (DUR, formulary, RTBC), `signPrescription` (NewRx, EPCS), `cancelPrescription`, `approveRxRequest`, `denyRxRequest`, `submitElectronicPriorAuth`, `getMedicationFillHistory`, `searchPharmacies`, `startEpcsProofing` | `POST /webhooks/logicoy`: RxRenewal, RxChange, CancelRx response, Status/Error, RxFill | yes |
| PdmpGateway | State PDMP through the eRx vendor or a state hub | `queryPdmp` | — | yes |
| IisGateway | State immunization registry | `administerImmunization` (VXU), `queryImmunizationRegistry` (QBP) | `POST /webhooks/iis` (where the registry pushes) | yes |
| DirectGateway | HISP | `sendReferral`, `searchDirectAddresses` | `POST /webhooks/direct` | yes |
| FaxGateway | Cloud fax | `returnIncomingDocument`, referral fax | `POST /webhooks/fax` | yes |
| HieGateway | Regional HIE (optional) | `queryOutsideRecords` | `POST /webhooks/hie` | yes |
| PaymentGateway | Card processor with hosted fields | `createPayment`, `refundPayment`, `createPaymentMethod`, `createPaymentPlan`, portal pay | `POST /webhooks/payments` | no card data in our system (PCI scope stays with the processor) |
| MessagingGateway | Twilio (SMS, voice), SMTP relay (email) | reminders, invitations, password reset, statements, receipts, outreach | `POST /webhooks/twilio/status`, `/twilio/inbound`, `/webhooks/email` | minimum necessary; no clinical detail (INV-SEC-06); BAA required |
| VideoGateway | HIPAA-eligible video vendor | `createTelehealthSession`, `joinTelehealthSession`, `portalJoinVideo`, `addTelehealthParticipant`, `endTelehealthSession` | `POST /webhooks/video` | yes |
| MfaGateway | Built-in TOTP and WebAuthn; SMS, voice or push through a 2FA service (e.g. Twilio Verify) | `verifyMfa`, `resendMfaCode`, `portalLogin` | `POST /webhooks/mfa` | phone numbers only |
| ReferenceDataGateway | NPPES NPI Registry, NLM RxNav, CMS ICD-10-CM and POS files, CDC CVX/MVX, LOINC, X12 CARC/RARC, NUCC, AMA CPT (licence) | `lookupNpi`, `searchNpiRegistry`, `searchDrugs`, `getDrug`, `importCodeSystem`; NPI validation on `createPractitioner`, `createLocation`, `updatePractice` | — | no PHI |
| FileStore | Docker volume, envelope-encrypted | `uploadFile`, `downloadFile`, `getFilePage` | — | yes |

Vendors are tentative (OPEN-Q2). Swapping one means a new adapter; domain code and the API don't change.

## Reference data

| Code system | Source | Load | Used by |
|---|---|---|---|
| ICD-10-CM | CMS annual release (Oct 1) plus April update | `importCodeSystem` into `CodeConcept` (system `ICD10CM`, `billable` flag) | problems, encounter diagnoses, order reasons, claims |
| CVX / MVX | CDC | import | immunizations, vaccine lots |
| POS | CMS Place of Service list | import | `Location.placeOfService`, claim lines |
| LOINC | Regenstrief | import (subset) | results, document types, questionnaires |
| CPT / HCPCS | AMA licence / CMS | import | charges, fee schedules |
| CARC / RARC | X12 | import | ERA posting, denials |
| NUCC taxonomy | NUCC | import | practitioner specialty, claims |
| RxNorm | NLM RxNav REST (`/approximateTerm`, `/rxcui/{id}/related`, `/ndcstatus`) | live lookup, cached in `RxNormConcept` | drug search, allergies, medication lists |
| NPI | NPPES NPI Registry API v2.1 | live lookup, cached in `NpiRegistryEntry` | providers, locations, organisation, referral recipients |

`listCodeSystemVersions` shows what is loaded. A claim or order records the code-system version in force on the date of service.

## Delivery rules (INV-OPS-01)

**Outbound.** A domain change and its `OutboxEvent` are written in one transaction. A worker turns the event into an `InterfaceMessage` with an `idempotencyKey` derived from the business key (e.g. `claim:<id>:submit:<attempt>`), calls the adapter, and retries with backoff. After the last retry the message is `DEAD` and a Task of type `INTERFACE_FAILURE` is created. Nothing fails silently. Client-facing operations that call a vendor accept an `Idempotency-Key` header.

**Inbound.**
1. Verify the signature. On failure, reject with 401 and record the attempt on the connection.
2. Insert `WebhookEvent` (unique on provider + vendor event id). Duplicates return 200 and do nothing.
3. Store the payload encrypted as a `FileObject`, respond 2xx quickly, and process in a worker.
4. Handlers are idempotent. Results that cannot be matched to a patient and order become `InboundResult` rows in the unmatched queue (INV-SAFE-03), never auto-filed.
5. Outside clinical data is staged for reconciliation (INV-DATA-01).

**Health.** `IntegrationConnection.health` is updated from success and failure rates. `INTERFACE_DOWN` notifications go to managers; the front-desk and RCM homes show a banner when a gateway they depend on is down.

## Credentials

Vendor secrets live in a secret store; the database holds only `secretRef`. Secrets are written through `rotateIntegrationSecret` (step-up, write-only) and never returned. `IntegrationConnection.baaOnFile` must be true before a PHI gateway can be enabled.
