# HIPAA controls

Where each HIPAA Security Rule and Privacy Rule requirement lives in the schema and the API. This document doesn't replace a risk analysis, policies or BAAs. It shows the engineering controls the code must provide. Section references are 45 CFR Part 164.

## Technical safeguards (§164.312)

| Requirement | Control | Where |
|---|---|---|
| Unique user identification (a)(2)(i) | One `User` per person; no shared logins. Every row change records `changedById`; every request records the actor on `AuditEvent`. | `User`, `AuditEvent.actorId` |
| Emergency access procedure (a)(2)(ii) | Break-the-glass: reason required, time-limited grant, unlocks only the labels needed, reviewed by a manager afterwards. | `EmergencyAccessGrant`; `requestEmergencyAccess`, `listEmergencyAccessGrants`, `reviewEmergencyAccess`; header `X-Emergency-Access`; INV-SEC-03 |
| Automatic logoff (a)(2)(iii) | Idle and absolute session timeouts from practice settings (`security.sessionTimeoutMinutes`). Short access tokens, server-side refresh sessions that can be revoked. Unsaved drafts survive (INV-SEC-04). | `Session.idleExpiresAt`, `absoluteExpiresAt`, `revokedAt`; `refreshSession`, `revokeSession` |
| Encryption and decryption (a)(2)(iv) | Postgres and the file volume are encrypted at rest. `@encrypted` fields and all files use envelope encryption with per-file data keys. | `@encrypted` tags; `FileObject.wrappedDataKey`, `encryptionKeyId` |
| Audit controls (b) | Every operation with `x-audit` writes an `AuditEvent` (who, what, which patient, which operation, purpose, outcome). The table is append-only and hash-chained. Reads of PHI are audited, not only writes. Bulk and FHIR access record the client id. | `AuditEvent`; `listAuditEvents`, `exportAuditEvents`, `listMySecurityEvents`; INV-SEC-01 |
| Integrity (c)(1) | Optimistic concurrency (`If-Match`). Signed notes are immutable; changes go through addenda (INV-SAFE-02). Every change to a `@versioned` row writes a `ResourceVersion` snapshot. Files carry a sha256. The ledger is append-only. | `version`, `ResourceVersion`, `Addendum`, `FileObject.sha256`, `LedgerEntry` |
| Person or entity authentication (d) | Password (argon2id, breached-password check) plus mandatory MFA for all staff (TOTP, WebAuthn, SMS fallback through `MfaGateway`). Step-up re-authentication for signing controlled substances, role changes, MFA reset, exports and security settings. Portal: password plus a one-time code. Lockout and rate limits. | `MfaFactor`, `MfaChallenge`, `LoginAttempt`, `Session.stepUpAt`; `x-step-up` operations; `auth.*` screens |
| Transmission security (e)(1) | TLS 1.2+ for every endpoint. Webhooks are signature-verified (`webhookSignature`, `twilioSignature`) with replay windows. No PHI in SMS or email bodies (INV-SEC-06). No PHI in URLs or query strings beyond opaque ids. | `securitySchemes`; `MessagingGateway` |

## Administrative safeguards the system supports (§164.308)

| Requirement | Control | Where |
|---|---|---|
| Workforce authorization and minimum necessary | Role-based access from `spec/roles.yaml` (`x-roles` per operation), location scoping, active-role switching, and least privilege on role changes. Billing roles can't read note bodies by default (INV-SEC-05). | `UserRole`, `UserLocation`; `setUserRoles` (step-up, audited) |
| Termination procedures | Deactivating a user revokes all sessions at once; history is kept. | `deactivateUser` |
| Log-in monitoring | Failed attempts recorded; lockout; security events visible to the user and to admins. | `LoginAttempt`, `AuditEvent` action `LOGIN_FAILED` |
| Contingency plan, data backup | Database PITR plus volume snapshots taken together; read-only downtime snapshot (INV-OPS-02). | ops runbook; `FileObject` on the volume |
| Business associate contracts (b)(1) | An integration can't be enabled for PHI traffic without a BAA on file. | `IntegrationConnection.baaOnFile`; `updateIntegration` rejects `enabled=true` for PHI gateways when false |
| Evaluation | Break-glass reviews, audit export, integration health. | `admin.audit-log`, `admin.integrations` |

## Privacy Rule features

| Requirement | Control | Where |
|---|---|---|
| Right of access (§164.524) | Patient downloads their record (C-CDA, PDF, FHIR NDJSON) from the portal; third-party apps through SMART on FHIR; full EHI export. | `requestRecordDownload`, `fhirPatientEverything`, `createExport` (EHI) |
| Right to amend (§164.526) | Request, accept or deny with a written explanation; a denial statement is linked to the record. | `AmendmentRequest`; `requestPortalAmendment`, `createAmendmentRequest`, `decideAmendmentRequest` |
| Accounting of disclosures (§164.528) | Disclosures outside treatment, payment and operations are logged with recipient, purpose and method. Releases sent by fax or Direct are logged automatically. | `DisclosureLog`; `recordDisclosure`, `listDisclosures` |
| Restrictions and confidential communications (§164.522) | Restricted labels on patients and rows; communication preferences and TCPA consent. | `securityLabels`, `Consent` (SMS_TCPA, EMAIL), `PortalPreferences` |
| Personal representatives | Proxy access with scopes; adolescent rules are OPEN-Q10. | `PortalAccess`, `invitePortalProxy`, `revokePortalProxy` |
| Notice of privacy practices | Acknowledgement captured as a consent at registration or check-in. | `Consent` type `NOTICE_OF_PRIVACY_PRACTICES` |
| 42 CFR Part 2 (SUD records) | Part 2 data is labelled `42CFRPart2` and released only with a Part 2 consent that names the recipient and purpose. Redisclosure notice attached. | `securityLabels`, `Consent` type `PART2_SUD` |

## API rules every handler follows

1. Authenticate with the scheme on the operation, then authorise by `x-roles`, tenant (RLS) and patient restrictions. Return 404 rather than 403 when existence would leak.
2. Write the `AuditEvent` in the same transaction as the change. For reads, write it before returning the data.
3. Never log request or response bodies of `x-phi: true` operations. Log the request id and operation id only.
4. Error messages and `Problem.detail` contain no PHI.
5. File downloads stream through the API with `Cache-Control: no-store`. There are no pre-signed public URLs.
6. Exports (`EXPORT`) require step-up, are audited, are scoped to minimum necessary and expire. Integration credentials are write-only (`SecretWrite`), stored in a secret store, and referenced by `secretRef`.
