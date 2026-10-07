import type { OperationId, OperationMeta, OperationTypes, StaffRoleId } from "@agile-emr/shared";
import type { Tx } from "../../db.js";
import type { AuditEntry } from "../audit.js";

/** Who is calling. Resolved from the operation's security scheme before the handler runs. */
export interface StaffPrincipal {
  kind: "staff";
  userId: string;
  practiceId: string;
  sessionId: string;
  /** Role the user is acting as (switchActiveRole). Authorisation uses this role (least privilege). */
  role: StaffRoleId;
  roles: StaffRoleId[];
  practitionerId: string | null;
  stepUpAt: Date | null;
}

export interface PortalPrincipal {
  kind: "portal";
  portalUserId: string;
  sessionId: string;
}

export interface EnrollmentPrincipal {
  kind: "enrollment";
  userId: string;
  practiceId: string;
}

export type Principal = StaffPrincipal | PortalPrincipal | EnrollmentPrincipal;

export interface BinaryResult {
  __binary: true;
  contentType: string;
  body: Buffer;
  fileName?: string;
  inline?: boolean;
}

export const binary = (
  contentType: string,
  body: Buffer,
  fileName?: string,
  inline = true,
): BinaryResult => ({
  __binary: true,
  contentType,
  body,
  fileName,
  inline,
});

export interface Ctx<Id extends OperationId = OperationId> {
  op: OperationMeta;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  principal: Principal | null;
  /** Tenant of this request (set before the handler for authenticated staff; via bindTenant for public ops). */
  practiceId: string | null;
  /** The request's transaction. RLS context is set once a tenant is bound. */
  db: Tx;
  params: OperationTypes[Id]["params"];
  query: OperationTypes[Id]["query"];
  body: OperationTypes[Id]["body"];
  headers: Record<string, string | undefined>;
  /** Raw request body (webhook signature verification). */
  rawBody: Buffer | null;
  /** Multipart upload, when the operation takes one. */
  file: {
    fileName: string;
    contentType: string;
    data: Buffer;
    fields: Record<string, string>;
  } | null;

  /** Bind the transaction to a tenant once it is known (login, invitations, webhooks). */
  bindTenant(practiceId: string): Promise<void>;
  /** Details for the operation's x-audit event (INV-SEC-01). */
  audit: {
    patient(patientId: string | null | undefined): void;
    resource(type: string, id: string | null | undefined): void;
    detail(detail: Record<string, unknown>): void;
    purpose(purposeOfUse: string, emergencyAccessId?: string | null): void;
    /** Extra audit events in the same transaction (e.g. one READ per patient in a bulk action). */
    add(entry: AuditEntry): void;
    /** Skip the default event (the handler wrote its own, e.g. LOGIN vs LOGIN_FAILED). */
    suppressDefault(): void;
  };
  /** Work that must persist even when the request fails and its transaction rolls back (lockout counters, failure audit). */
  onFailure(fn: (tx: Tx) => Promise<void>): void;
  /** Work to run after commit (enqueue jobs, publish events). */
  afterCommit(fn: () => Promise<void>): void;
  /** If-Match version (ETag) for PATCH; 428 if missing. */
  ifMatch(): number;
  /** Throws 412 version_mismatch when `current` differs from If-Match / body version. */
  checkVersion(current: number, given?: number): void;
  /** 403 step_up_required unless the session re-authenticated recently. */
  requireStepUp(): void;
  setHeader(name: string, value: string): void;
  setStatus(status: number): void;
  staff(): StaffPrincipal;
  portal(): PortalPrincipal;
}

export type Handler<Id extends OperationId> = (
  ctx: Ctx<Id>,
) => Promise<OperationTypes[Id]["response"] | BinaryResult>;

export type HandlerMap = { [Id in OperationId]?: Handler<Id> };
