import type { Prisma } from "../../db.js";
import { putFile } from "../../gateways/fileStore.js";
import { limitOf, toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { auditPage } from "../../platform/auditView.js";

/**
 * Practice settings, audit search and export, break-the-glass review (admin.security, admin.audit-log).
 * Security settings are validated so they can never weaken mandatory MFA (INV-SEC-04).
 */
type Validator = (v: unknown) => string | null;
const intIn =
  (min: number, max: number): Validator =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
      ? null
      : `Enter a whole number from ${min} to ${max}.`;

const VALIDATORS: Record<string, Validator> = {
  "security.mfaRequired": (v) =>
    v === true ? null : "MFA is mandatory for all staff and cannot be turned off.",
  "security.sessionTimeoutMinutes": intIn(5, 60),
  "security.absoluteTimeoutHours": intIn(1, 24),
  "security.breakGlassMinutes": intIn(5, 240),
  "security.passwordMaxAgeDays": intIn(0, 730),
  "security.lockoutAttempts": intIn(3, 10),
  "chart.maxOpenCharts": intIn(1, 10),
  "schedule.waitTargetMinutes": intIn(1, 240),
  "schedule.slotMinutes": intIn(5, 60),
};

export const SETTING_PREFIXES = [
  "security.",
  "portal.",
  "schedule.",
  "billing.",
  "messaging.",
  "chart.",
  "inbox.",
  "clinical.",
  "reports.",
];

export const securityHandlers: HandlerMap = {
  async listSettings(ctx) {
    const prefix = ctx.query.prefix;
    const rows = await ctx.db.practiceSetting.findMany({
      where: prefix ? { key: { startsWith: prefix } } : {},
      orderBy: { key: "asc" },
    });
    return toDtos("PracticeSetting", rows);
  },

  async putSetting(ctx) {
    const key = ctx.params.key;
    if (!SETTING_PREFIXES.some((p) => key.startsWith(p)) || !/^[a-z]+\.[A-Za-z0-9.]+$/.test(key)) {
      throw unprocessable("validation_failed", "Unknown setting.", {
        errors: [{ field: "key", code: "unknown", message: "Unknown setting." }],
      });
    }
    const err = VALIDATORS[key]?.(ctx.body.value) ?? null;
    if (err)
      throw unprocessable("validation_failed", err, {
        errors: [{ field: "value", code: "invalid", message: err }],
      });
    const me = ctx.staff();
    const existing = await ctx.db.practiceSetting.findFirst({ where: { key } });
    const value = ctx.body.value as Prisma.InputJsonValue;
    const row = existing
      ? await ctx.db.practiceSetting.update({
          where: { id: existing.id },
          data: { value, version: { increment: 1 }, updatedById: me.userId },
        })
      : await ctx.db.practiceSetting.create({
          data: { practiceId: ctx.practiceId!, key, value, updatedById: me.userId },
        });
    await writeVersion(ctx.db, ctx.practiceId!, "PracticeSetting", row, me.userId, ctx.body.reason);
    ctx.audit.resource("PracticeSetting", row.id);
    ctx.audit.detail({ key });
    return toDto("PracticeSetting", row);
  },

  async listAuditEvents(ctx) {
    const q = ctx.query;
    const limit = limitOf(q);
    const rows = await ctx.db.auditEvent.findMany({
      where: {
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.userId ? { actorId: q.userId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.from || q.to
          ? {
              at: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
        ...(q.cursor ? { id: { lt: BigInt(q.cursor) } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    // The search itself is audited (x-audit QUERY) with its criteria names, not values.
    ctx.audit.detail({ criteria: Object.keys(q).filter((k) => k !== "cursor" && k !== "limit") });
    if (q.patientId) ctx.audit.patient(q.patientId);
    return auditPage(ctx.db, rows, limit);
  },

  async exportAuditEvents(ctx) {
    const b = ctx.body;
    if (!b.reason?.trim())
      throw unprocessable("validation_failed", "Record why you are exporting.", {
        errors: [{ field: "reason", code: "required", message: "Required." }],
      });
    const from = new Date(b.from);
    const to = new Date(b.to);
    if (!(from < to) || to.getTime() - from.getTime() > 366 * 86_400_000)
      throw unprocessable("validation_failed", "Choose a range of up to one year.");
    const me = ctx.staff();
    const rows = await ctx.db.auditEvent.findMany({
      where: {
        at: { gte: from, lte: to },
        ...(b.userId ? { actorId: b.userId } : {}),
        ...(b.patientId ? { patientId: b.patientId } : {}),
        ...(b.actions?.length ? { action: { in: b.actions } } : {}),
      },
      orderBy: { id: "asc" },
      take: 100_000,
    });
    const cols = [
      "id",
      "at",
      "actorType",
      "actorId",
      "actorRole",
      "action",
      "outcome",
      "patientId",
      "resourceType",
      "resourceId",
      "operationId",
      "purposeOfUse",
      "emergencyAccessId",
      "ip",
      "sessionId",
      "hash",
    ] as const;
    const esc = (v: unknown) => {
      const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body =
      b.format === "json"
        ? JSON.stringify(
            rows.map((r) =>
              Object.fromEntries(
                cols.map((c) => [
                  c,
                  r[c] instanceof Date
                    ? (r[c] as Date).toISOString()
                    : typeof r[c] === "bigint"
                      ? String(r[c])
                      : r[c],
                ]),
              ),
            ),
          )
        : [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    const file = await putFile(ctx.db, {
      practiceId: ctx.practiceId!,
      kind: "generated",
      fileName: `audit-${b.from.slice(0, 10)}-${b.to.slice(0, 10)}.${b.format}`,
      contentType: b.format === "json" ? "application/json" : "text/csv",
      data: Buffer.from(body, "utf8"),
      uploadedById: me.userId,
    });
    const job = await ctx.db.job.create({
      data: {
        practiceId: ctx.practiceId!,
        type: "export",
        exportType: "CSV",
        params: {
          report: "audit",
          from: b.from,
          to: b.to,
          userId: b.userId ?? null,
          patientId: b.patientId ?? null,
          actions: b.actions ?? [],
          format: b.format,
          reason: b.reason,
        },
        status: "SUCCEEDED",
        progress: 100,
        resultFileIds: [file.id],
        requestedById: me.userId,
        finishedAt: new Date(),
        // Exports expire (docs/10-hipaa-controls.md rule 6).
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    ctx.audit.resource("Job", job.id);
    ctx.audit.detail({ rows: rows.length, format: b.format });
    ctx.setHeader("Location", `/api/v1/jobs/${job.id}`);
    return toDto("Job", job);
  },

  async listEmergencyAccessGrants(ctx) {
    const q = ctx.query;
    const rows = await ctx.db.emergencyAccessGrant.findMany({
      where: {
        ...(q.reviewOutcome ? { reviewOutcome: q.reviewOutcome } : {}),
        ...(q.from || q.to
          ? {
              grantedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { grantedAt: "desc" },
      take: limitOf(q, 500, 100),
    });
    return { data: toDtos("EmergencyAccessGrant", rows), nextCursor: null, hasMore: false };
  },

  async reviewEmergencyAccess(ctx) {
    const g = await ctx.db.emergencyAccessGrant.findUnique({
      where: { id: ctx.params.emergencyAccessGrantId },
    });
    if (!g) throw notFound();
    ctx.audit.patient(g.patientId);
    ctx.audit.resource("EmergencyAccessGrant", g.id);
    const me = ctx.staff();
    if (g.userId === me.userId)
      throw conflict("forbidden_self", "Someone else must review your own access.");
    if (g.reviewOutcome !== "PENDING_REVIEW")
      throw conflict("already_reviewed", "This access was already reviewed.");
    if (ctx.body.outcome === "PENDING_REVIEW")
      throw unprocessable("validation_failed", "Choose an outcome.");
    if (!ctx.body.note?.trim())
      throw unprocessable("validation_failed", "Add a review note.", {
        errors: [{ field: "note", code: "required", message: "Required." }],
      });
    const row = await ctx.db.emergencyAccessGrant.update({
      where: { id: g.id },
      data: {
        reviewOutcome: ctx.body.outcome,
        reviewedById: me.userId,
        reviewedAt: new Date(),
        reviewNote: ctx.body.note,
      },
    });
    return toDto("EmergencyAccessGrant", row);
  },
};
