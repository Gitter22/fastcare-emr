import { createHash } from "node:crypto";
import type { Tx } from "../db.js";
import type { AuditAction, AuditOutcome, Role } from "../db.js";

/**
 * Append-only, hash-chained audit log (INV-SEC-01, docs/09-data-model.md): hash = sha256(prevHash || canonical(row)).
 * Entries are buffered during a request and flushed as the last statement of its transaction, so the per-practice
 * chain lock (pg_advisory_xact_lock) is held only from flush to commit.
 */
export interface AuditEntry {
  action: AuditAction;
  outcome?: AuditOutcome;
  patientId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  operationId?: string | null;
  purposeOfUse?: string | null;
  emergencyAccessId?: string | null;
  onBehalfOfPatientId?: string | null;
  /** Non-PHI detail only: field names changed, counts, codes. Never values. */
  detail?: Record<string, unknown> | null;
}

export interface AuditActor {
  practiceId: string | null;
  actorType: "staff" | "portal" | "smart-app" | "system" | "integration";
  actorId: string | null;
  actorRole: Role | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Deterministic JSON with keys sorted at every depth (jsonb does not preserve key order). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.keys(v as object)
      .sort()
      .map((k) => [k, stable((v as Record<string, unknown>)[k])]);
  }
  return v;
}

function canonical(row: Record<string, unknown>): string {
  return JSON.stringify(stable(row));
}

export async function writeAuditEntries(
  tx: Tx,
  actor: AuditActor,
  entries: AuditEntry[],
): Promise<void> {
  if (!entries.length) return;
  const lockKey = actor.practiceId ?? "00000000-0000-0000-0000-000000000000";
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + lockKey}))`;
  const head = await tx.$queryRaw<{ audit_chain_head: string | null }[]>`
    SELECT audit_chain_head(${actor.practiceId}::uuid)`;
  let prevHash = head[0]?.audit_chain_head ?? null;
  for (const e of entries) {
    const row = {
      practiceId: actor.practiceId,
      at: new Date().toISOString(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      onBehalfOfPatientId: e.onBehalfOfPatientId ?? null,
      action: e.action,
      outcome: e.outcome ?? "SUCCESS",
      patientId: e.patientId ?? null,
      resourceType: e.resourceType ?? null,
      resourceId: e.resourceId ?? null,
      operationId: e.operationId ?? null,
      purposeOfUse: e.purposeOfUse ?? null,
      emergencyAccessId: e.emergencyAccessId ?? null,
      ip: actor.ip,
      userAgent: actor.userAgent,
      sessionId: actor.sessionId,
      detail: e.detail ?? null,
    };
    const hash = createHash("sha256")
      .update(`${prevHash ?? ""}|${canonical(row)}`)
      .digest("hex");
    await tx.auditEvent.create({
      data: {
        ...row,
        at: new Date(row.at),
        detail: row.detail === null ? undefined : (row.detail as object),
        prevHash,
        hash,
      },
    });
    prevHash = hash;
  }
}

/** Recomputes a chain segment; used by the nightly verification job and its test. */
export function verifyChain(
  rows: Array<Record<string, unknown> & { prevHash: string | null; hash: string; at: Date }>,
): { ok: boolean; brokenAt?: number } {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (i > 0 && r.prevHash !== rows[i - 1]!.hash) return { ok: false, brokenAt: i };
    const { id: _id, prevHash, hash, ...rest } = r;
    const row = { ...rest, at: r.at.toISOString(), detail: rest.detail ?? null };
    const expected = createHash("sha256")
      .update(`${prevHash ?? ""}|${canonical(row)}`)
      .digest("hex");
    if (expected !== hash) return { ok: false, brokenAt: i };
  }
  return { ok: true };
}
