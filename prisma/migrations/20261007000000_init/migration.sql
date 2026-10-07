-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('FRONTDESK', 'MA', 'PROVIDER', 'BILLER', 'MANAGER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'BOOKED', 'CONFIRMED', 'ARRIVED', 'ROOMED', 'READY_FOR_PROVIDER', 'WITH_PROVIDER', 'CHECKOUT', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'LEFT_WITHOUT_BEING_SEEN');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('DRAFT', 'READY_TO_SIGN', 'PENDING_COSIGN', 'SIGNED', 'ADDENDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDED', 'SIGNED', 'SENT', 'COLLECTED', 'RESULTED_PRELIM', 'RESULTED_FINAL', 'REVIEWED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'READY', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'PAID', 'PARTIALLY_PAID', 'DENIED', 'APPEALED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PENDED_TO_PROVIDER', 'COMPLETED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('ORDERED', 'AUTH_PENDING', 'SENT', 'SCHEDULED', 'CONSULT_RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('TOTP', 'SMS', 'EMAIL', 'WEBAUTHN', 'PUSH');

-- CreateEnum
CREATE TYPE "SessionSubject" AS ENUM ('STAFF', 'PORTAL', 'SMART_APP');

-- CreateEnum
CREATE TYPE "AdministrativeGender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SexForClinicalUse" AS ENUM ('FEMALE', 'MALE', 'SPECIFIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactPointSystem" AS ENUM ('PHONE', 'SMS', 'EMAIL', 'FAX');

-- CreateEnum
CREATE TYPE "ContactPointUse" AS ENUM ('HOME', 'WORK', 'MOBILE', 'TEMP');

-- CreateEnum
CREATE TYPE "ProvenanceSource" AS ENUM ('ENTERED', 'PATIENT_REPORTED', 'OUTSIDE_RECORD', 'DEVICE', 'AI_DRAFT', 'INTERFACE', 'REGISTRY', 'PHARMACY');

-- CreateEnum
CREATE TYPE "StagingStatus" AS ENUM ('ACTIVE', 'STAGED', 'REJECTED', 'MERGED');

-- CreateEnum
CREATE TYPE "ConditionCategory" AS ENUM ('PROBLEM_LIST_ITEM', 'ENCOUNTER_DIAGNOSIS', 'HEALTH_CONCERN');

-- CreateEnum
CREATE TYPE "ConditionClinicalStatus" AS ENUM ('ACTIVE', 'RECURRENCE', 'RELAPSE', 'INACTIVE', 'REMISSION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNCONFIRMED', 'PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "AllergyCategory" AS ENUM ('FOOD', 'MEDICATION', 'ENVIRONMENT', 'BIOLOGIC');

-- CreateEnum
CREATE TYPE "AllergyCriticality" AS ENUM ('LOW', 'HIGH', 'UNABLE_TO_ASSESS');

-- CreateEnum
CREATE TYPE "AllergyClinicalStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReactionSeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');

-- CreateEnum
CREATE TYPE "MedicationStatementStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ENTERED_IN_ERROR', 'INTENDED', 'STOPPED', 'ON_HOLD', 'UNKNOWN', 'NOT_TAKEN');

-- CreateEnum
CREATE TYPE "MedicationRequestStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ON_HOLD', 'CANCELLED', 'COMPLETED', 'ENTERED_IN_ERROR', 'STOPPED');

-- CreateEnum
CREATE TYPE "ErxStatus" AS ENUM ('NOT_SENT', 'QUEUED', 'SENT', 'ACCEPTED', 'ERROR', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RxRequestType" AS ENUM ('RENEWAL', 'CHANGE', 'CANCEL_RESPONSE', 'PORTAL_REFILL');

-- CreateEnum
CREATE TYPE "DurAlertType" AS ENUM ('DRUG_ALLERGY', 'DRUG_DRUG', 'DOSE', 'DUPLICATE_THERAPY', 'DRUG_CONDITION');

-- CreateEnum
CREATE TYPE "ObservationStatus" AS ENUM ('REGISTERED', 'PRELIMINARY', 'FINAL', 'AMENDED', 'CORRECTED', 'CANCELLED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "ObservationCategory" AS ENUM ('VITAL_SIGNS', 'LABORATORY', 'SOCIAL_HISTORY', 'SURVEY', 'EXAM', 'IMAGING', 'PROCEDURE', 'SDOH', 'POINT_OF_CARE');

-- CreateEnum
CREATE TYPE "DiagnosticReportStatus" AS ENUM ('REGISTERED', 'PARTIAL', 'PRELIMINARY', 'FINAL', 'AMENDED', 'CORRECTED', 'CANCELLED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "ResultFlag" AS ENUM ('NORMAL', 'ABNORMAL', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ImmunizationStatus" AS ENUM ('COMPLETED', 'ENTERED_IN_ERROR', 'NOT_DONE');

-- CreateEnum
CREATE TYPE "OrderCategory" AS ENUM ('LAB', 'IMAGING', 'PROCEDURE', 'REFERRAL', 'DME', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderPriority" AS ENUM ('ROUTINE', 'URGENT', 'ASAP', 'STAT');

-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('IN_OFFICE', 'PATIENT_SERVICE_CENTER', 'HOME_KIT', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('PLANNED', 'ARRIVED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "EncounterClass" AS ENUM ('AMB', 'VR', 'PHONE', 'ASYNC', 'HH');

-- CreateEnum
CREATE TYPE "Modality" AS ENUM ('IN_PERSON', 'VIDEO', 'PHONE');

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('STAFF', 'PORTAL', 'WAITLIST', 'INTEROP');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('RESULT_REVIEW', 'CRITICAL_RESULT', 'RX_REQUEST', 'COSIGN', 'PATIENT_MESSAGE', 'GENERAL', 'PREVISIT_RECONCILE', 'DOCUMENT_FILING', 'PRIOR_AUTH', 'SPECIMEN_COLLECTION', 'OVERDUE_ORDER', 'UNMATCHED_RESULT', 'REFERRAL', 'CHARGE_HOLD', 'PROVIDER_QUERY', 'CLAIM_REJECTION', 'DENIAL', 'INTERFACE_FAILURE', 'ELIGIBILITY_FAILURE', 'RECALL');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('NOTICE_OF_PRIVACY_PRACTICES', 'FINANCIAL_POLICY', 'SMS_TCPA', 'EMAIL', 'TELEHEALTH', 'CCM', 'PART2_SUD', 'RELEASE_OF_INFORMATION', 'PORTAL_PROXY', 'CARD_ON_FILE', 'TREATMENT');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'REJECTED', 'INACTIVE', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('CURRENT', 'SUPERSEDED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "IncomingDocumentSource" AS ENUM ('FAX', 'SCAN', 'DIRECT', 'UPLOAD', 'PORTAL');

-- CreateEnum
CREATE TYPE "IncomingDocumentStatus" AS ENUM ('NEW', 'NEEDS_REVIEW', 'FILED', 'RETURNED', 'SPLIT');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('CLINICAL', 'BILLING', 'SCHEDULING', 'REFILL', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('PATIENT', 'STAFF', 'INTERNAL_NOTE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CommChannel" AS ENUM ('SMS', 'EMAIL', 'VOICE', 'PORTAL', 'LETTER', 'FAX');

-- CreateEnum
CREATE TYPE "CommStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'OPTED_OUT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'HELD', 'READY', 'BILLED', 'VOID');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'INSURANCE_PAYMENT', 'PATIENT_PAYMENT', 'CONTRACTUAL_ADJUSTMENT', 'TRANSFER_TO_PATIENT', 'TRANSFER_TO_INSURANCE', 'WRITE_OFF', 'REFUND', 'RECOUPMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "Responsibility" AS ENUM ('INSURANCE', 'PATIENT');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('CARD', 'CASH', 'CHECK', 'ACH', 'EFT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('RECEIVED', 'POSTING', 'EXCEPTION', 'POSTED');

-- CreateEnum
CREATE TYPE "AdjustmentGroup" AS ENUM ('CO', 'PR', 'OA', 'PI', 'CR');

-- CreateEnum
CREATE TYPE "DenialStatus" AS ENUM ('OPEN', 'APPEALED', 'CORRECTED', 'WRITTEN_OFF', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DenialAction" AS ENUM ('APPEAL', 'CORRECTED_CLAIM', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'UNKNOWN', 'ERROR');

-- CreateEnum
CREATE TYPE "ClaimEventType" AS ENUM ('CREATED', 'SUBMITTED', 'ACK_999', 'ACK_277CA', 'STATUS_277', 'REMIT_835', 'CORRECTED', 'VOIDED', 'NOTE');

-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('NOT_REQUIRED', 'DRAFT', 'SUBMITTED', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CareGapStatus" AS ENUM ('OPEN', 'CLOSED', 'EXCLUDED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('READ', 'CREATE', 'UPDATE', 'DELETE', 'SIGN', 'PRINT', 'EXPORT', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'MFA', 'BREAK_GLASS', 'DISCLOSE', 'QUERY', 'MERGE', 'PERMISSION_CHANGE');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('STEDI', 'LOGICOY', 'HEALTH_GORILLA', 'LABCORP', 'QUEST', 'TWILIO', 'SMTP', 'NPPES', 'RXNAV', 'IIS', 'PDMP', 'DIRECT', 'FAX', 'MFA', 'PAYMENT', 'VIDEO', 'HIE');

-- CreateEnum
CREATE TYPE "InterfaceDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "InterfaceMessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'RETRYING', 'DEAD');

-- CreateEnum
CREATE TYPE "IntegrationHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'DOWN', 'DISABLED');

-- CreateEnum
CREATE TYPE "CodeSystem" AS ENUM ('ICD10CM', 'SNOMEDCT', 'LOINC', 'CPT', 'HCPCS', 'CVX', 'MVX', 'RXNORM', 'NDC', 'POS', 'CARC', 'RARC', 'NUCC_TAXONOMY', 'UCUM', 'CDCREC', 'LANGUAGE', 'CMS_MEASURE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('CSV', 'BULK_FHIR', 'EHI_PATIENT', 'EHI_PRACTICE', 'QRDA_I', 'QRDA_III', 'C_CDA');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PortalRelationship" AS ENUM ('SELF', 'PARENT', 'GUARDIAN', 'CAREGIVER', 'SPOUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('READY', 'OCCUPIED', 'NEEDS_CLEANING', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CRITICAL_RESULT', 'TASK_ESCALATED', 'INTERFACE_DOWN', 'EMERGENCY_ACCESS', 'GENERAL');

-- CreateEnum
CREATE TYPE "BreakGlassOutcome" AS ENUM ('PENDING_REVIEW', 'APPROPRIATE', 'FOLLOW_UP', 'POSSIBLE_INCIDENT');

-- CreateEnum
CREATE TYPE "CdsSeverity" AS ENUM ('INFO', 'PASSIVE', 'INTERRUPTIVE', 'HARD_STOP');

-- CreateEnum
CREATE TYPE "StagedChangeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "DisclosurePurpose" AS ENUM ('TREATMENT', 'PAYMENT', 'OPERATIONS', 'PATIENT_REQUEST', 'LEGAL', 'PUBLIC_HEALTH', 'RESEARCH', 'OTHER');

-- CreateEnum
CREATE TYPE "AiSegmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EDITED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('ACTIVE', 'OFFERED', 'BOOKED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DUE', 'CONTACTED', 'BOOKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CheckinStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('UNMATCHED', 'AUTO_MATCHED', 'MANUALLY_MATCHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('OPEN', 'MERGED', 'NOT_DUPLICATE', 'UNMERGED');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TelehealthStatus" AS ENUM ('WAITING', 'IN_CALL', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AmendmentStatus" AS ENUM ('RECEIVED', 'ACCEPTED', 'DENIED');

-- CreateTable
CREATE TABLE "Practice" (
    "id" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "tin" TEXT NOT NULL,
    "groupNpi" TEXT,
    "taxonomyCode" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "postalCode" TEXT NOT NULL,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Practice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSetting" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "PracticeSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "npi" TEXT,
    "placeOfService" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "postalCode" TEXT NOT NULL,
    "phone" TEXT,
    "fax" TEXT,
    "hours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'READY',
    "equipment" TEXT[],
    "isVirtual" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Practitioner" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "userId" UUID,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "credential" TEXT,
    "npi" TEXT,
    "taxonomyCode" TEXT,
    "supervisingId" UUID,
    "epcsProofedAt" TIMESTAMP(3),
    "epcsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isBillingProvider" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerLicense" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "state" CHAR(2) NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresOn" DATE NOT NULL,

    CONSTRAINT "PractitionerLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeaRegistration" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "schedules" TEXT[],
    "expiresOn" DATE NOT NULL,

    CONSTRAINT "DeaRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayerEnrollment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveFrom" DATE,

    CONSTRAINT "PayerEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkPool" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slaHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WorkPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkPoolMember" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "WorkPoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'INVITED',
    "passwordHash" TEXT,
    "passwordChangedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "mfaEnrolledAt" TIMESTAMP(3),
    "activeRole" "Role",
    "deactivatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLocation" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "locationId" UUID NOT NULL,

    CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CosignRule" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "supervisorId" UUID NOT NULL,
    "appliesTo" TEXT[],
    "criteria" JSONB,
    "state" CHAR(2),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CosignRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaFactor" (
    "id" UUID NOT NULL,
    "practiceId" UUID,
    "userId" UUID,
    "portalUserId" UUID,
    "type" "MfaFactorType" NOT NULL,
    "label" TEXT,
    "secret" BYTEA,
    "webauthnCredentialId" TEXT,
    "webauthnPublicKey" BYTEA,
    "phone" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "practiceId" UUID,
    "subject" "SessionSubject" NOT NULL,
    "userId" UUID,
    "portalUserId" UUID,
    "smartClientId" UUID,
    "refreshTokenHash" TEXT NOT NULL,
    "mfaVerifiedAt" TIMESTAMP(3),
    "stepUpAt" TIMESTAMP(3),
    "activeRole" "Role",
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "portalUserId" UUID,
    "factorId" UUID,
    "type" "MfaFactorType" NOT NULL,
    "codeHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" UUID NOT NULL,
    "practiceId" UUID,
    "email" TEXT NOT NULL,
    "subject" "SessionSubject" NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" UUID,
    "portalUserId" UUID,
    "patientId" UUID,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyAccessGrant" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "scope" TEXT[],
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reviewOutcome" "BreakGlassOutcome" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "EmergencyAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "practiceId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" UUID,
    "actorRole" "Role",
    "onBehalfOfPatientId" UUID,
    "action" "AuditAction" NOT NULL,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "patientId" UUID,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "operationId" TEXT,
    "purposeOfUse" TEXT,
    "emergencyAccessId" UUID,
    "ip" TEXT,
    "userAgent" TEXT,
    "sessionId" UUID,
    "detail" JSONB,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisclosureLog" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "disclosedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient" TEXT NOT NULL,
    "purpose" "DisclosurePurpose" NOT NULL,
    "description" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "authorizationConsentId" UUID,
    "recordedById" UUID NOT NULL,

    CONSTRAINT "DisclosureLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceVersion" (
    "id" BIGSERIAL NOT NULL,
    "practiceId" UUID,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedById" UUID,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeReason" TEXT,

    CONSTRAINT "ResourceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvenanceRecord" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "source" "ProvenanceSource" NOT NULL,
    "activity" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "agentId" TEXT,
    "agentDisplay" TEXT,
    "sourceDocumentId" UUID,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileObject" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "pageCount" INTEGER,
    "uploadedById" UUID,
    "uploadedByPortalUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "mrn" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "suffix" TEXT,
    "preferredName" TEXT,
    "previousNames" JSONB,
    "birthDate" DATE NOT NULL,
    "administrativeGender" "AdministrativeGender" NOT NULL,
    "sexForClinicalUse" "SexForClinicalUse",
    "genderIdentity" TEXT,
    "pronouns" TEXT,
    "sexualOrientation" TEXT,
    "raceCodes" TEXT[],
    "ethnicityCodes" TEXT[],
    "preferredLanguage" TEXT,
    "interpreterNeeded" BOOLEAN NOT NULL DEFAULT false,
    "ssnCiphertext" BYTEA,
    "ssnLast4" TEXT,
    "maritalStatus" TEXT,
    "deceasedAt" TIMESTAMP(3),
    "photoFileId" UUID,
    "pcpPractitionerId" UUID,
    "preferredPharmacyId" UUID,
    "guarantorRelatedPersonId" UUID,
    "codeStatus" TEXT,
    "advanceDirectiveDocumentId" UUID,
    "securityLabels" TEXT[],
    "allergiesReviewedAt" TIMESTAMP(3),
    "noKnownAllergies" BOOLEAN NOT NULL DEFAULT false,
    "medsReconciledAt" TIMESTAMP(3),
    "medsReconciledById" UUID,
    "historyReviewedAt" TIMESTAMP(3),
    "mergedIntoId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientIdentifier" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PatientIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAddress" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "use" TEXT NOT NULL DEFAULT 'home',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "postalCode" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),

    CONSTRAINT "PatientAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientContactPoint" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "system" "ContactPointSystem" NOT NULL,
    "use" "ContactPointUse",
    "value" TEXT NOT NULL,
    "valueIndex" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMP(3),
    "smsOptOut" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PatientContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelatedPerson" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "isGuarantor" BOOLEAN NOT NULL DEFAULT false,
    "isEmergencyContact" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "birthDate" DATE,
    "phone" TEXT,
    "email" TEXT,
    "address" JSONB,
    "ssnCiphertext" BYTEA,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RelatedPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientAId" UUID NOT NULL,
    "patientBId" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "matchedOn" TEXT[],
    "reason" TEXT,
    "status" "DuplicateStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientMerge" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "survivorId" UUID NOT NULL,
    "mergedId" UUID NOT NULL,
    "fieldChoices" JSONB NOT NULL,
    "movedRecords" JSONB NOT NULL,
    "mergedById" UUID NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmergedById" UUID,
    "unmergedAt" TIMESTAMP(3),

    CONSTRAINT "PatientMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedChange" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID,
    "source" "ProvenanceSource" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID,
    "changes" JSONB NOT NULL,
    "status" "StagedChangeStatus" NOT NULL DEFAULT 'PENDING',
    "submittedByPortalUserId" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientList" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "criteria" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pharmacy" (
    "id" UUID NOT NULL,
    "practiceId" UUID,
    "ncpdpId" TEXT NOT NULL,
    "npi" TEXT,
    "name" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "phone" TEXT,
    "fax" TEXT,
    "specialties" TEXT[],
    "epcsEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Pharmacy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payer" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "clearinghousePayerId" TEXT NOT NULL,
    "eligibilitySupported" BOOLEAN NOT NULL DEFAULT true,
    "claimsSupported" BOOLEAN NOT NULL DEFAULT true,
    "eraSupported" BOOLEAN NOT NULL DEFAULT true,
    "timelyFilingDays" INTEGER NOT NULL DEFAULT 90,
    "appealDays" INTEGER NOT NULL DEFAULT 180,
    "claimRules" JSONB,
    "portalUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayerPlan" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "referralRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PayerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coverage" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "planId" UUID,
    "order" INTEGER NOT NULL DEFAULT 1,
    "memberId" TEXT NOT NULL,
    "groupNumber" TEXT,
    "subscriberRelatedPersonId" UUID,
    "relationshipToSubscriber" TEXT NOT NULL DEFAULT 'self',
    "periodStart" DATE,
    "periodEnd" DATE,
    "cardFrontFileId" UUID,
    "cardBackFileId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EligibilityCheck" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "coverageId" UUID NOT NULL,
    "appointmentId" UUID,
    "mode" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "status" "EligibilityStatus" NOT NULL DEFAULT 'PENDING',
    "copay" DECIMAL(10,2),
    "coinsurancePct" DECIMAL(5,2),
    "deductible" DECIMAL(10,2),
    "deductibleRemaining" DECIMAL(10,2),
    "outOfPocketRemaining" DECIMAL(10,2),
    "pcpOnFile" TEXT,
    "authRequired" BOOLEAN,
    "benefits" JSONB,
    "errorMessage" TEXT,
    "interfaceMessageId" UUID,

    CONSTRAINT "EligibilityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitType" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "modalities" "Modality"[],
    "newPatientOnly" BOOLEAN NOT NULL DEFAULT false,
    "onlineBookable" BOOLEAN NOT NULL DEFAULT false,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 2,
    "bookingWindowDays" INTEGER NOT NULL DEFAULT 90,
    "color" TEXT,
    "defaultCptHints" TEXT[],
    "previsitQuestionnaireIds" UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VisitType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleTemplate" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "slots" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ScheduleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleBlock" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "practitionerId" UUID,
    "roomId" UUID,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,

    CONSTRAINT "ScheduleBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "roomId" UUID,
    "visitTypeId" UUID NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "modality" "Modality" NOT NULL DEFAULT 'IN_PERSON',
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "comment" TEXT,
    "bookingChannel" "BookingChannel" NOT NULL DEFAULT 'STAFF',
    "assignedMaId" UUID,
    "cancellationReason" TEXT,
    "rescheduledFromId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentStatusEvent" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "fromStatus" "AppointmentStatus",
    "toStatus" "AppointmentStatus" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" UUID,
    "byPortalUserId" UUID,
    "note" TEXT,

    CONSTRAINT "AppointmentStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "visitTypeId" UUID NOT NULL,
    "practitionerId" UUID,
    "earliest" TIMESTAMP(3),
    "latest" TIMESTAMP(3),
    "status" "WaitlistStatus" NOT NULL DEFAULT 'ACTIVE',
    "offeredSlotStart" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recall" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "careGapId" UUID,
    "dueDate" DATE NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DUE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckinSession" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "status" "CheckinStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "steps" JSONB NOT NULL,
    "resumeTokenHash" TEXT,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckinSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Encounter" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID,
    "practitionerId" UUID NOT NULL,
    "locationId" UUID,
    "status" "EncounterStatus" NOT NULL DEFAULT 'PLANNED',
    "class" "EncounterClass" NOT NULL DEFAULT 'AMB',
    "typeCode" TEXT,
    "placeOfService" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "chiefComplaint" TEXT,
    "patientWords" TEXT,
    "prechartNote" TEXT,
    "prechartedAt" TIMESTAMP(3),
    "readyForProviderAt" TIMESTAMP(3),
    "followUpInstruction" TEXT,
    "noChargeVisit" BOOLEAN NOT NULL DEFAULT false,
    "emMethod" TEXT,
    "emTotalMinutes" INTEGER,
    "emSuggestedCode" TEXT,
    "mdmProblems" TEXT,
    "mdmData" TEXT,
    "mdmRisk" TEXT,
    "securityLabels" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalNote" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "noteType" TEXT NOT NULL DEFAULT '11506-3',
    "status" "NoteStatus" NOT NULL DEFAULT 'DRAFT',
    "templateId" UUID,
    "lockedByUserId" UUID,
    "lockedAt" TIMESTAMP(3),
    "signedById" UUID,
    "signedAt" TIMESTAMP(3),
    "cosignRequired" BOOLEAN NOT NULL DEFAULT false,
    "cosignerId" UUID,
    "cosignedAt" TIMESTAMP(3),
    "releasedToPortalAt" TIMESTAMP(3),
    "securityLabels" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteSection" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraftSegment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRefs" JSONB,
    "model" TEXT NOT NULL,
    "status" "AiSegmentStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDraftSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addendum" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Addendum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteTemplate" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "ownerId" UUID,
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "sections" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NoteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartPhrase" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ownerId" UUID,
    "shared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SmartPhrase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AfterVisitSummary" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "instructions" TEXT,
    "content" JSONB NOT NULL,
    "educationIds" TEXT[],
    "fileId" UUID,
    "releasedAt" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "AfterVisitSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "category" "ConditionCategory" NOT NULL,
    "icd10Code" TEXT,
    "snomedCode" TEXT,
    "display" TEXT NOT NULL,
    "clinicalStatus" "ConditionClinicalStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "onsetDate" DATE,
    "abatementDate" DATE,
    "rank" INTEGER,
    "note" TEXT,
    "lastAddressedAt" TIMESTAMP(3),
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "mergedIntoId" UUID,
    "securityLabels" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" UUID,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllergyIntolerance" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "substanceSystem" "CodeSystem" NOT NULL,
    "substanceCode" TEXT NOT NULL,
    "substanceDisplay" TEXT NOT NULL,
    "category" "AllergyCategory" NOT NULL,
    "criticality" "AllergyCriticality",
    "clinicalStatus" "AllergyClinicalStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "reactions" JSONB,
    "onsetDate" DATE,
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" UUID,

    CONSTRAINT "AllergyIntolerance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationStatement" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "rxnormCode" TEXT,
    "display" TEXT NOT NULL,
    "dosageText" TEXT,
    "status" "MedicationStatementStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "effectiveStart" DATE,
    "effectiveEnd" DATE,
    "reasonConditionId" UUID,
    "prescriptionId" UUID,
    "lastFillDate" DATE,
    "daysSupply" INTEGER,
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "mergedIntoId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" UUID,

    CONSTRAINT "MedicationStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationRequest" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "prescriberId" UUID NOT NULL,
    "rxnormCode" TEXT NOT NULL,
    "ndc" TEXT,
    "display" TEXT NOT NULL,
    "isControlled" BOOLEAN NOT NULL DEFAULT false,
    "deaSchedule" TEXT,
    "doseQuantity" TEXT,
    "doseUnit" TEXT,
    "route" TEXT,
    "frequency" TEXT,
    "durationDays" INTEGER,
    "sigText" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "quantityUnit" TEXT NOT NULL,
    "refills" INTEGER NOT NULL DEFAULT 0,
    "daysSupply" INTEGER,
    "substitutionAllowed" BOOLEAN NOT NULL DEFAULT true,
    "noteToPharmacist" TEXT,
    "reasonConditionId" UUID,
    "pharmacyId" UUID,
    "status" "MedicationRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "intent" TEXT NOT NULL DEFAULT 'order',
    "priorPrescriptionId" UUID,
    "pendedById" UUID,
    "signedById" UUID,
    "signedAt" TIMESTAMP(3),
    "epcsTwoFactorAt" TIMESTAMP(3),
    "pdmpQueryId" UUID,
    "pdmpExceptionReason" TEXT,
    "formularyStatus" JSONB,
    "erxStatus" "ErxStatus" NOT NULL DEFAULT 'NOT_SENT',
    "erxMessageId" TEXT,
    "erxError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DurAlert" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "medicationRequestId" UUID NOT NULL,
    "type" "DurAlertType" NOT NULL,
    "severity" "CdsSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" JSONB,
    "outcome" TEXT NOT NULL,
    "overrideReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DurAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PdmpQuery" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "state" CHAR(2) NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportFileId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "interfaceMessageId" UUID,

    CONSTRAINT "PdmpQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RxRequest" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" "RxRequestType" NOT NULL,
    "originalPrescriptionId" UUID,
    "requestedChange" JSONB,
    "pharmacyId" UUID,
    "protocolResult" JSONB,
    "responseStatus" TEXT,
    "responseReason" TEXT,
    "responsePrescriptionId" UUID,
    "taskId" UUID,
    "interfaceMessageId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RxRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "diagnosticReportId" UUID,
    "category" "ObservationCategory" NOT NULL,
    "loincCode" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "status" "ObservationStatus" NOT NULL DEFAULT 'FINAL',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "valueQuantity" DECIMAL(14,4),
    "valueUnit" TEXT,
    "valueString" TEXT,
    "valueCode" TEXT,
    "valueBoolean" BOOLEAN,
    "components" JSONB,
    "referenceRangeLow" DECIMAL(14,4),
    "referenceRangeHigh" DECIMAL(14,4),
    "referenceRangeText" TEXT,
    "interpretation" TEXT,
    "flag" "ResultFlag",
    "previousValueId" UUID,
    "deviceId" UUID,
    "performerId" UUID,
    "note" TEXT,
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticReport" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceRequestId" UUID,
    "category" TEXT NOT NULL,
    "loincCode" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "status" "DiagnosticReportStatus" NOT NULL,
    "effectiveAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "performerLab" TEXT,
    "accessionNumber" TEXT,
    "conclusion" TEXT,
    "pdfFileId" UUID,
    "flag" "ResultFlag",
    "isCritical" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "correctionAcknowledgedAt" TIMESTAMP(3),
    "releasedToPortalAt" TIMESTAMP(3),
    "releaseDelayReason" TEXT,
    "securityLabels" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriticalResultContact" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "diagnosticReportId" UUID NOT NULL,
    "reached" BOOLEAN NOT NULL,
    "spokeWith" TEXT,
    "method" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL,
    "instructions" TEXT,
    "readBack" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalResultContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundResult" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "interfaceMessageId" UUID NOT NULL,
    "lab" TEXT NOT NULL,
    "accessionNumber" TEXT,
    "placerOrderNumber" TEXT,
    "demographics" JSONB NOT NULL,
    "candidates" JSONB,
    "matchStatus" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedPatientId" UUID,
    "matchedServiceRequestId" UUID,
    "diagnosticReportId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Immunization" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "cvxCode" TEXT NOT NULL,
    "mvxCode" TEXT,
    "display" TEXT NOT NULL,
    "status" "ImmunizationStatus" NOT NULL DEFAULT 'COMPLETED',
    "statusReason" TEXT,
    "occurrenceAt" TIMESTAMP(3) NOT NULL,
    "primarySource" BOOLEAN NOT NULL DEFAULT true,
    "lotId" UUID,
    "lotNumber" TEXT,
    "expirationDate" DATE,
    "site" TEXT,
    "route" TEXT,
    "doseQuantity" DECIMAL(6,2),
    "performerId" UUID,
    "visEditionDate" DATE,
    "visPresentedAt" TIMESTAMP(3),
    "standingOrder" BOOLEAN NOT NULL DEFAULT false,
    "registryStatus" TEXT,
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Immunization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaccineLot" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "cvxCode" TEXT NOT NULL,
    "mvxCode" TEXT,
    "lotNumber" TEXT NOT NULL,
    "expirationDate" DATE NOT NULL,
    "quantityOnHand" INTEGER NOT NULL,
    "fundingSource" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VaccineLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Procedure" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "codeSystem" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "performedOn" DATE,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyMemberHistory" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "deceased" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyMemberHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Questionnaire" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "loincCode" TEXT,
    "purpose" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "languages" TEXT[],
    "channels" TEXT[],
    "scoring" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Questionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionnaireResponse" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "questionnaireId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "answers" JSONB NOT NULL,
    "score" DECIMAL(8,2),
    "authoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ENTERED',
    "stagingStatus" "StagingStatus" NOT NULL DEFAULT 'ACTIVE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "vendorDeviceId" TEXT NOT NULL,
    "udi" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarePlan" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "title" TEXT NOT NULL,
    "activities" JSONB NOT NULL,
    "ccmConsentId" UUID,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "target" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeLog" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "program" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "activity" TEXT NOT NULL,
    "performedById" UUID NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billedChargeItemId" UUID,

    CONSTRAINT "TimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Measure" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "cmsId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lowerIsBetter" BOOLEAN NOT NULL DEFAULT false,
    "goalPct" DECIMAL(5,2),
    "logicVersion" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareGap" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "measureId" UUID NOT NULL,
    "status" "CareGapStatus" NOT NULL DEFAULT 'OPEN',
    "dueDate" DATE,
    "lastDoneDate" DATE,
    "closedReason" TEXT,
    "evidenceDocumentId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasureResult" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "measureId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "practitionerId" UUID,
    "numerator" INTEGER NOT NULL,
    "denominator" INTEGER NOT NULL,
    "exclusions" INTEGER NOT NULL,
    "missingData" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeasureResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdsRule" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vendorManaged" BOOLEAN NOT NULL DEFAULT false,
    "severity" "CdsSeverity" NOT NULL,
    "audienceRoles" "Role"[],
    "logic" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CdsRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdsFiring" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "userId" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CdsFiring_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "category" "OrderCategory" NOT NULL,
    "codeSystem" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "labCompendiumItemId" UUID,
    "performerLab" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDED',
    "intent" TEXT NOT NULL DEFAULT 'order',
    "priority" "OrderPriority" NOT NULL DEFAULT 'ROUTINE',
    "collectionMode" "CollectionMode" NOT NULL DEFAULT 'IN_OFFICE',
    "aoeAnswers" JSONB,
    "expectedBy" DATE,
    "abnRequired" BOOLEAN NOT NULL DEFAULT false,
    "abnSignedFileId" UUID,
    "orderSetId" UUID,
    "placerOrderNumber" TEXT,
    "accessionNumber" TEXT,
    "requisitionFileId" UUID,
    "collectedAt" TIMESTAMP(3),
    "pendedById" UUID,
    "signedById" UUID,
    "signedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "interfaceMessageId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequestReason" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "conditionId" UUID NOT NULL,

    CONSTRAINT "ServiceRequestReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Specimen" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "containerType" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "collectedById" UUID NOT NULL,
    "labelPrinted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Specimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSet" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID,
    "items" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OrderSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabCompendiumItem" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "lab" TEXT NOT NULL,
    "testCode" TEXT NOT NULL,
    "loincCode" TEXT,
    "display" TEXT NOT NULL,
    "specimenType" TEXT,
    "aoeQuestions" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LabCompendiumItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceRequestId" UUID,
    "direction" TEXT NOT NULL DEFAULT 'outgoing',
    "specialty" TEXT NOT NULL,
    "toOrganization" TEXT,
    "toPractitionerNpi" TEXT,
    "directAddress" TEXT,
    "urgency" "OrderPriority" NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'ORDERED',
    "authorizationId" UUID,
    "sentVia" TEXT,
    "sentAt" TIMESTAMP(3),
    "specialistAppointmentAt" TIMESTAMP(3),
    "consultDocumentId" UUID,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Authorization" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "coverageId" UUID,
    "serviceRequestId" UUID,
    "medicationRequestId" UUID,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "validFrom" DATE,
    "validTo" DATE,
    "unitsApproved" INTEGER,
    "submittedVia" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decisionAt" TIMESTAMP(3),
    "denialReason" TEXT,
    "taskId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentReference" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "typeLoinc" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "author" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'CURRENT',
    "fileId" UUID NOT NULL,
    "sourceIncomingId" UUID,
    "securityLabels" TEXT[],
    "filedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingDocument" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "source" "IncomingDocumentSource" NOT NULL,
    "fromNumberOrAddress" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileId" UUID NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "ocrText" TEXT,
    "suggestedType" TEXT,
    "patientCandidates" JSONB,
    "foreignPages" INTEGER[],
    "status" "IncomingDocumentStatus" NOT NULL DEFAULT 'NEW',
    "parentId" UUID,
    "filedDocumentReferenceId" UUID,
    "handledById" UUID,
    "handledAt" TIMESTAMP(3),

    CONSTRAINT "IncomingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" "ConsentType" NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "scope" JSONB,
    "signedAt" TIMESTAMP(3),
    "signedBy" TEXT,
    "method" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "documentFileId" UUID,
    "recordedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmendmentRequest" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "requestText" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" UUID,
    "status" "AmendmentStatus" NOT NULL DEFAULT 'RECEIVED',
    "responseText" TEXT,
    "decidedById" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueBy" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AmendmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "poolId" UUID,
    "assignedUserId" UUID,
    "urgentKeywords" TEXT[],
    "slaDueAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "taskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentFileIds" UUID[],
    "sentByUserId" UUID,
    "sentByPortalUserId" UUID,
    "onBehalfOfProxy" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationLog" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID,
    "channel" "CommChannel" NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "purpose" TEXT NOT NULL,
    "templateKey" TEXT,
    "to" TEXT NOT NULL,
    "status" "CommStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "relatedType" TEXT,
    "relatedId" UUID,
    "summary" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "patientId" UUID,
    "focusType" TEXT,
    "focusId" UUID,
    "poolId" UUID,
    "ownerUserId" UUID,
    "dueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "linkRoute" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelehealthSession" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "vendorRoomId" TEXT NOT NULL,
    "status" "TelehealthStatus" NOT NULL DEFAULT 'WAITING',
    "patientJoinedAt" TIMESTAMP(3),
    "providerJoinedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "deviceCheck" JSONB,
    "participants" JSONB,
    "audioOnlyFrom" TIMESTAMP(3),

    CONSTRAINT "TelehealthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EVisit" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "questionnaireResponseId" UUID NOT NULL,
    "threadId" UUID,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "cumulativeMinutes" INTEGER NOT NULL DEFAULT 0,
    "encounterId" UUID,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeSchedule" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payerId" UUID,
    "isContract" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeScheduleItem" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "feeScheduleId" UUID NOT NULL,
    "codeSystem" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "modifier" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "FeeScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeItem" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "codeSystem" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "modifiers" TEXT[],
    "units" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "dxConditionIds" UUID[],
    "fee" DECIMAL(10,2) NOT NULL,
    "serviceDate" DATE NOT NULL,
    "renderingPractitionerId" UUID NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "holdReasons" JSONB,
    "holdNote" TEXT,
    "claimLineId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "ChargeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "patientId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "coverageId" UUID NOT NULL,
    "encounterId" UUID,
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "frequencyCode" TEXT NOT NULL DEFAULT '1',
    "originalClaimId" UUID,
    "billingProviderNpi" TEXT NOT NULL,
    "billingTin" TEXT NOT NULL,
    "renderingProviderNpi" TEXT NOT NULL,
    "placeOfService" TEXT NOT NULL,
    "serviceDateFrom" DATE NOT NULL,
    "serviceDateTo" DATE NOT NULL,
    "totalBilled" DECIMAL(10,2) NOT NULL,
    "totalPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "patientResponsibility" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "priorAuthNumber" TEXT,
    "batchId" UUID,
    "payerClaimControlNumber" TEXT,
    "submittedAt" TIMESTAMP(3),
    "filingDeadline" DATE NOT NULL,
    "rejectionReason" TEXT,
    "rejectionField" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimLine" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "chargeItemId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "modifiers" TEXT[],
    "units" DECIMAL(8,2) NOT NULL,
    "charge" DECIMAL(10,2) NOT NULL,
    "dxPointers" TEXT[],
    "icd10Codes" TEXT[],

    CONSTRAINT "ClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimEvent" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "type" "ClaimEventType" NOT NULL,
    "statusCode" TEXT,
    "description" TEXT,
    "raw" JSONB,
    "interfaceMessageId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimBatch" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimCount" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "interchangeControlNumber" TEXT,
    "interfaceMessageId" UUID,
    "status" TEXT NOT NULL,

    CONSTRAINT "ClaimBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Remittance" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "eftTraceNumber" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentAmount" DECIMAL(12,2) NOT NULL,
    "paymentDate" DATE NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "RemittanceStatus" NOT NULL DEFAULT 'RECEIVED',
    "depositMatched" BOOLEAN NOT NULL DEFAULT false,
    "rawFileId" UUID,
    "postedById" UUID,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "Remittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemittanceClaimPayment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "remittanceId" UUID NOT NULL,
    "claimId" UUID,
    "payerClaimControlNumber" TEXT,
    "patientControlNumber" TEXT NOT NULL,
    "billed" DECIMAL(10,2) NOT NULL,
    "allowed" DECIMAL(10,2),
    "paid" DECIMAL(10,2) NOT NULL,
    "patientResponsibility" DECIMAL(10,2) NOT NULL,
    "claimStatusCode" TEXT NOT NULL,
    "underpaidBy" DECIMAL(10,2),
    "posted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RemittanceClaimPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemittanceAdjustment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimPaymentId" UUID NOT NULL,
    "lineNumber" INTEGER,
    "group" "AdjustmentGroup" NOT NULL,
    "carc" TEXT NOT NULL,
    "rarc" TEXT[],
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "RemittanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderLevelAdjustment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "remittanceId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "postedToClaimId" UUID,

    CONSTRAINT "ProviderLevelAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Denial" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "carc" TEXT NOT NULL,
    "rarc" TEXT[],
    "rootCause" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "appealDeadline" DATE NOT NULL,
    "status" "DenialStatus" NOT NULL DEFAULT 'OPEN',
    "action" "DenialAction",
    "snoozedUntil" TIMESTAMP(3),
    "taskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Denial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "denialId" UUID NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "letterFileId" UUID NOT NULL,
    "attachmentFileIds" UUID[],
    "submittedVia" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT,
    "submittedById" UUID NOT NULL,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "guarantorId" UUID,
    "encounterId" UUID,
    "chargeItemId" UUID,
    "claimId" UUID,
    "paymentId" UUID,
    "remittanceId" UUID,
    "type" "LedgerEntryType" NOT NULL,
    "responsibility" "Responsibility" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "carc" TEXT,
    "reversalOfId" UUID,
    "depositBatchId" UUID,
    "memo" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" UUID,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "processorToken" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "consentId" UUID,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "method" "PaymentMethodType" NOT NULL,
    "paymentMethodId" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "processorRef" TEXT,
    "checkNumber" TEXT,
    "appliedTo" JSONB,
    "channel" TEXT NOT NULL,
    "locationId" UUID,
    "receiptChannel" TEXT,
    "depositBatchId" UUID,
    "takenById" UUID,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundOfId" UUID,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "months" INTEGER NOT NULL,
    "monthlyAmount" DECIMAL(10,2) NOT NULL,
    "firstPaymentOn" DATE NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "amountDue" DECIMAL(10,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "channels" TEXT[],
    "fileId" UUID NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "holdReason" TEXT,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "items" JSONB NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "fileId" UUID,
    "sentAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositBatch" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "locationId" UUID NOT NULL,
    "expected" JSONB NOT NULL,
    "counted" JSONB,
    "depositTotal" DECIMAL(12,2),
    "bankMatched" BOOLEAN NOT NULL DEFAULT false,
    "variance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "varianceReason" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'OPEN',
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "DepositBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'INVITED',
    "emailVerifiedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalAccess" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "portalUserId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "relationship" "PortalRelationship" NOT NULL,
    "scope" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "grantedById" UUID,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PortalAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartClient" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "scopes" TEXT[],
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "clientSecretHash" TEXT,
    "jwksUri" TEXT,
    "backendService" BOOLEAN NOT NULL DEFAULT false,
    "practiceId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmartClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartGrant" (
    "id" UUID NOT NULL,
    "smartClientId" UUID NOT NULL,
    "portalUserId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "scopes" TEXT[],
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SmartGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "gateway" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretRef" TEXT NOT NULL,
    "health" "IntegrationHealth" NOT NULL DEFAULT 'HEALTHY',
    "healthSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "certificateExpiresAt" TIMESTAMP(3),
    "baaOnFile" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterfaceMessage" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "direction" "InterfaceDirection" NOT NULL,
    "messageType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "InterfaceMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "payloadFileId" UUID,
    "vendorRef" TEXT,
    "correlationType" TEXT,
    "correlationId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "InterfaceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "practiceId" UUID,
    "provider" "IntegrationKind" NOT NULL,
    "vendorEventId" TEXT NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL,
    "payloadFileId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "practiceId" UUID,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "practiceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "exportType" "ExportType",
    "params" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "resultFileIds" UUID[],
    "error" TEXT,
    "requestedById" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeConcept" (
    "id" UUID NOT NULL,
    "system" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "shortDisplay" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "billable" BOOLEAN,
    "attributes" JSONB,
    "sourceVersion" TEXT NOT NULL,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,

    CONSTRAINT "CodeConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RxNormConcept" (
    "rxcui" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tty" TEXT NOT NULL,
    "deaSchedule" TEXT,
    "ndcs" TEXT[],
    "ingredients" TEXT[],
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RxNormConcept_pkey" PRIMARY KEY ("rxcui")
);

-- CreateTable
CREATE TABLE "NpiRegistryEntry" (
    "npi" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxonomies" JSONB NOT NULL,
    "addresses" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NpiRegistryEntry_pkey" PRIMARY KEY ("npi")
);

-- CreateIndex
CREATE UNIQUE INDEX "PracticeSetting_practiceId_key_key" ON "PracticeSetting"("practiceId", "key");

-- CreateIndex
CREATE INDEX "Location_practiceId_idx" ON "Location"("practiceId");

-- CreateIndex
CREATE INDEX "Room_practiceId_locationId_idx" ON "Room"("practiceId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_userId_key" ON "Practitioner"("userId");

-- CreateIndex
CREATE INDEX "Practitioner_practiceId_idx" ON "Practitioner"("practiceId");

-- CreateIndex
CREATE INDEX "Practitioner_npi_idx" ON "Practitioner"("npi");

-- CreateIndex
CREATE INDEX "WorkPool_practiceId_idx" ON "WorkPool"("practiceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPoolMember_poolId_userId_key" ON "WorkPoolMember"("poolId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_practiceId_email_key" ON "User"("practiceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_role_key" ON "UserRole"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "UserLocation_userId_locationId_key" ON "UserLocation"("userId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_portalUserId_idx" ON "Session"("portalUserId");

-- CreateIndex
CREATE INDEX "LoginAttempt_email_at_idx" ON "LoginAttempt"("email", "at");

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmergencyAccessGrant_practiceId_reviewOutcome_idx" ON "EmergencyAccessGrant"("practiceId", "reviewOutcome");

-- CreateIndex
CREATE INDEX "AuditEvent_practiceId_at_idx" ON "AuditEvent"("practiceId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_patientId_at_idx" ON "AuditEvent"("patientId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_at_idx" ON "AuditEvent"("actorId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceVersion_resourceType_resourceId_version_key" ON "ResourceVersion"("resourceType", "resourceId", "version");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_targetType_targetId_idx" ON "ProvenanceRecord"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_storageKey_key" ON "FileObject"("storageKey");

-- CreateIndex
CREATE INDEX "Patient_practiceId_lastName_firstName_birthDate_idx" ON "Patient"("practiceId", "lastName", "firstName", "birthDate");

-- CreateIndex
CREATE INDEX "Patient_practiceId_birthDate_idx" ON "Patient"("practiceId", "birthDate");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_practiceId_mrn_key" ON "Patient"("practiceId", "mrn");

-- CreateIndex
CREATE UNIQUE INDEX "PatientIdentifier_system_value_key" ON "PatientIdentifier"("system", "value");

-- CreateIndex
CREATE INDEX "PatientContactPoint_practiceId_valueIndex_idx" ON "PatientContactPoint"("practiceId", "valueIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateCandidate_patientAId_patientBId_key" ON "DuplicateCandidate"("patientAId", "patientBId");

-- CreateIndex
CREATE INDEX "StagedChange_practiceId_status_idx" ON "StagedChange"("practiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Pharmacy_ncpdpId_key" ON "Pharmacy"("ncpdpId");

-- CreateIndex
CREATE INDEX "Payer_practiceId_idx" ON "Payer"("practiceId");

-- CreateIndex
CREATE INDEX "Coverage_patientId_idx" ON "Coverage"("patientId");

-- CreateIndex
CREATE INDEX "EligibilityCheck_coverageId_requestedAt_idx" ON "EligibilityCheck"("coverageId", "requestedAt");

-- CreateIndex
CREATE INDEX "Appointment_practiceId_start_idx" ON "Appointment"("practiceId", "start");

-- CreateIndex
CREATE INDEX "Appointment_practitionerId_start_idx" ON "Appointment"("practitionerId", "start");

-- CreateIndex
CREATE INDEX "Appointment_patientId_start_idx" ON "Appointment"("patientId", "start");

-- CreateIndex
CREATE INDEX "AppointmentStatusEvent_appointmentId_at_idx" ON "AppointmentStatusEvent"("appointmentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "CheckinSession_appointmentId_key" ON "CheckinSession"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_appointmentId_key" ON "Encounter"("appointmentId");

-- CreateIndex
CREATE INDEX "Encounter_patientId_periodStart_idx" ON "Encounter"("patientId", "periodStart");

-- CreateIndex
CREATE INDEX "Encounter_practitionerId_periodStart_idx" ON "Encounter"("practitionerId", "periodStart");

-- CreateIndex
CREATE INDEX "ClinicalNote_patientId_idx" ON "ClinicalNote"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "NoteSection_noteId_key_key" ON "NoteSection"("noteId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SmartPhrase_practiceId_ownerId_trigger_key" ON "SmartPhrase"("practiceId", "ownerId", "trigger");

-- CreateIndex
CREATE INDEX "Condition_patientId_category_stagingStatus_idx" ON "Condition"("patientId", "category", "stagingStatus");

-- CreateIndex
CREATE INDEX "AllergyIntolerance_patientId_stagingStatus_idx" ON "AllergyIntolerance"("patientId", "stagingStatus");

-- CreateIndex
CREATE INDEX "MedicationStatement_patientId_stagingStatus_status_idx" ON "MedicationStatement"("patientId", "stagingStatus", "status");

-- CreateIndex
CREATE INDEX "MedicationRequest_patientId_status_idx" ON "MedicationRequest"("patientId", "status");

-- CreateIndex
CREATE INDEX "Observation_patientId_loincCode_effectiveAt_idx" ON "Observation"("patientId", "loincCode", "effectiveAt");

-- CreateIndex
CREATE INDEX "Observation_patientId_category_effectiveAt_idx" ON "Observation"("patientId", "category", "effectiveAt");

-- CreateIndex
CREATE INDEX "DiagnosticReport_patientId_issuedAt_idx" ON "DiagnosticReport"("patientId", "issuedAt");

-- CreateIndex
CREATE INDEX "DiagnosticReport_practiceId_reviewedAt_idx" ON "DiagnosticReport"("practiceId", "reviewedAt");

-- CreateIndex
CREATE INDEX "Immunization_patientId_occurrenceAt_idx" ON "Immunization"("patientId", "occurrenceAt");

-- CreateIndex
CREATE UNIQUE INDEX "VaccineLot_practiceId_lotNumber_cvxCode_key" ON "VaccineLot"("practiceId", "lotNumber", "cvxCode");

-- CreateIndex
CREATE INDEX "CareGap_patientId_status_idx" ON "CareGap"("patientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_placerOrderNumber_key" ON "ServiceRequest"("placerOrderNumber");

-- CreateIndex
CREATE INDEX "ServiceRequest_patientId_status_idx" ON "ServiceRequest"("patientId", "status");

-- CreateIndex
CREATE INDEX "ServiceRequest_practiceId_status_expectedBy_idx" ON "ServiceRequest"("practiceId", "status", "expectedBy");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestReason_serviceRequestId_conditionId_key" ON "ServiceRequestReason"("serviceRequestId", "conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "LabCompendiumItem_practiceId_lab_testCode_key" ON "LabCompendiumItem"("practiceId", "lab", "testCode");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_serviceRequestId_key" ON "Referral"("serviceRequestId");

-- CreateIndex
CREATE INDEX "DocumentReference_patientId_documentDate_idx" ON "DocumentReference"("patientId", "documentDate");

-- CreateIndex
CREATE INDEX "Consent_patientId_type_status_idx" ON "Consent"("patientId", "type", "status");

-- CreateIndex
CREATE INDEX "MessageThread_practiceId_poolId_closedAt_idx" ON "MessageThread"("practiceId", "poolId", "closedAt");

-- CreateIndex
CREATE INDEX "CommunicationLog_patientId_createdAt_idx" ON "CommunicationLog"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_practiceId_status_poolId_idx" ON "Task"("practiceId", "status", "poolId");

-- CreateIndex
CREATE INDEX "Task_ownerUserId_status_idx" ON "Task"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "Task_focusType_focusId_idx" ON "Task"("focusType", "focusId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelehealthSession_appointmentId_key" ON "TelehealthSession"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeScheduleItem_feeScheduleId_codeSystem_code_modifier_key" ON "FeeScheduleItem"("feeScheduleId", "codeSystem", "code", "modifier");

-- CreateIndex
CREATE INDEX "ChargeItem_practiceId_status_idx" ON "ChargeItem"("practiceId", "status");

-- CreateIndex
CREATE INDEX "Claim_practiceId_status_idx" ON "Claim"("practiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_practiceId_claimNumber_key" ON "Claim"("practiceId", "claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Remittance_practiceId_payerId_eftTraceNumber_key" ON "Remittance"("practiceId", "payerId", "eftTraceNumber");

-- CreateIndex
CREATE INDEX "LedgerEntry_patientId_postedAt_idx" ON "LedgerEntry"("patientId", "postedAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_encounterId_idx" ON "LedgerEntry"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositBatch_practiceId_locationId_businessDate_key" ON "DepositBatch"("practiceId", "locationId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_email_key" ON "PortalUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PortalAccess_portalUserId_patientId_key" ON "PortalAccess"("portalUserId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "SmartClient_clientId_key" ON "SmartClient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_practiceId_kind_key" ON "IntegrationConnection"("practiceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "InterfaceMessage_idempotencyKey_key" ON "InterfaceMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InterfaceMessage_connectionId_status_nextAttemptAt_idx" ON "InterfaceMessage"("connectionId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InterfaceMessage_correlationType_correlationId_idx" ON "InterfaceMessage"("correlationType", "correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_vendorEventId_key" ON "WebhookEvent"("provider", "vendorEventId");

-- CreateIndex
CREATE INDEX "OutboxEvent_dispatchedAt_createdAt_idx" ON "OutboxEvent"("dispatchedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CodeConcept_system_display_idx" ON "CodeConcept"("system", "display");

-- CreateIndex
CREATE UNIQUE INDEX "CodeConcept_system_code_sourceVersion_key" ON "CodeConcept"("system", "code", "sourceVersion");

-- CreateIndex
CREATE INDEX "RxNormConcept_name_idx" ON "RxNormConcept"("name");

-- AddForeignKey
ALTER TABLE "PracticeSetting" ADD CONSTRAINT "PracticeSetting_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_supervisingId_fkey" FOREIGN KEY ("supervisingId") REFERENCES "Practitioner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerLicense" ADD CONSTRAINT "PractitionerLicense_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeaRegistration" ADD CONSTRAINT "DeaRegistration_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerEnrollment" ADD CONSTRAINT "PayerEnrollment_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerEnrollment" ADD CONSTRAINT "PayerEnrollment_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPoolMember" ADD CONSTRAINT "WorkPoolMember_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "WorkPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPoolMember" ADD CONSTRAINT "WorkPoolMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisclosureLog" ADD CONSTRAINT "DisclosureLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_preferredPharmacyId_fkey" FOREIGN KEY ("preferredPharmacyId") REFERENCES "Pharmacy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientIdentifier" ADD CONSTRAINT "PatientIdentifier_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAddress" ADD CONSTRAINT "PatientAddress_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientContactPoint" ADD CONSTRAINT "PatientContactPoint_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedPerson" ADD CONSTRAINT "RelatedPerson_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedChange" ADD CONSTRAINT "StagedChange_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerPlan" ADD CONSTRAINT "PayerPlan_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityCheck" ADD CONSTRAINT "EligibilityCheck_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "Coverage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTemplate" ADD CONSTRAINT "ScheduleTemplate_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_visitTypeId_fkey" FOREIGN KEY ("visitTypeId") REFERENCES "VisitType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentStatusEvent" ADD CONSTRAINT "AppointmentStatusEvent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recall" ADD CONSTRAINT "Recall_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinSession" ADD CONSTRAINT "CheckinSession_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinSession" ADD CONSTRAINT "CheckinSession_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSection" ADD CONSTRAINT "NoteSection_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraftSegment" ADD CONSTRAINT "AiDraftSegment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "NoteSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addendum" ADD CONSTRAINT "Addendum_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AfterVisitSummary" ADD CONSTRAINT "AfterVisitSummary_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AfterVisitSummary" ADD CONSTRAINT "AfterVisitSummary_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllergyIntolerance" ADD CONSTRAINT "AllergyIntolerance_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationStatement" ADD CONSTRAINT "MedicationStatement_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationRequest" ADD CONSTRAINT "MedicationRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationRequest" ADD CONSTRAINT "MedicationRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationRequest" ADD CONSTRAINT "MedicationRequest_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DurAlert" ADD CONSTRAINT "DurAlert_medicationRequestId_fkey" FOREIGN KEY ("medicationRequestId") REFERENCES "MedicationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RxRequest" ADD CONSTRAINT "RxRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_diagnosticReportId_fkey" FOREIGN KEY ("diagnosticReportId") REFERENCES "DiagnosticReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriticalResultContact" ADD CONSTRAINT "CriticalResultContact_diagnosticReportId_fkey" FOREIGN KEY ("diagnosticReportId") REFERENCES "DiagnosticReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Immunization" ADD CONSTRAINT "Immunization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Immunization" ADD CONSTRAINT "Immunization_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMemberHistory" ADD CONSTRAINT "FamilyMemberHistory_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireResponse" ADD CONSTRAINT "QuestionnaireResponse_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireResponse" ADD CONSTRAINT "QuestionnaireResponse_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireResponse" ADD CONSTRAINT "QuestionnaireResponse_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarePlan" ADD CONSTRAINT "CarePlan_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeLog" ADD CONSTRAINT "TimeLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareGap" ADD CONSTRAINT "CareGap_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareGap" ADD CONSTRAINT "CareGap_measureId_fkey" FOREIGN KEY ("measureId") REFERENCES "Measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeasureResult" ADD CONSTRAINT "MeasureResult_measureId_fkey" FOREIGN KEY ("measureId") REFERENCES "Measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CdsFiring" ADD CONSTRAINT "CdsFiring_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CdsRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestReason" ADD CONSTRAINT "ServiceRequestReason_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestReason" ADD CONSTRAINT "ServiceRequestReason_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Condition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Specimen" ADD CONSTRAINT "Specimen_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Authorization" ADD CONSTRAINT "Authorization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReference" ADD CONSTRAINT "DocumentReference_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReference" ADD CONSTRAINT "DocumentReference_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmendmentRequest" ADD CONSTRAINT "AmendmentRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "WorkPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationLog" ADD CONSTRAINT "CommunicationLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "WorkPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelehealthSession" ADD CONSTRAINT "TelehealthSession_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EVisit" ADD CONSTRAINT "EVisit_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeSchedule" ADD CONSTRAINT "FeeSchedule_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeScheduleItem" ADD CONSTRAINT "FeeScheduleItem_feeScheduleId_fkey" FOREIGN KEY ("feeScheduleId") REFERENCES "FeeSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "Coverage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimLine" ADD CONSTRAINT "ClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Remittance" ADD CONSTRAINT "Remittance_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemittanceClaimPayment" ADD CONSTRAINT "RemittanceClaimPayment_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "Remittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemittanceClaimPayment" ADD CONSTRAINT "RemittanceClaimPayment_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemittanceAdjustment" ADD CONSTRAINT "RemittanceAdjustment_claimPaymentId_fkey" FOREIGN KEY ("claimPaymentId") REFERENCES "RemittanceClaimPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLevelAdjustment" ADD CONSTRAINT "ProviderLevelAdjustment_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "Remittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Denial" ADD CONSTRAINT "Denial_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_denialId_fkey" FOREIGN KEY ("denialId") REFERENCES "Denial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalAccess" ADD CONSTRAINT "PortalAccess_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalAccess" ADD CONSTRAINT "PortalAccess_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartGrant" ADD CONSTRAINT "SmartGrant_smartClientId_fkey" FOREIGN KEY ("smartClientId") REFERENCES "SmartClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterfaceMessage" ADD CONSTRAINT "InterfaceMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

