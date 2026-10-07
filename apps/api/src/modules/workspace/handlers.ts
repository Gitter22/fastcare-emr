import { screens, type ScreenDef } from "@agile-emr/shared";
import { prisma, type Tx } from "../../db.js";
import { readFileContent } from "../../gateways/fileStore.js";
import { getRedis } from "../../redis.js";
import { limitOf, toDto, toDtos } from "../../platform/dto.js";
import { binary, type Ctx, type HandlerMap } from "../../platform/http/context.js";
import { implementedOperations } from "../../platform/http/capabilities.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { forbidden, notFound } from "../../platform/problem.js";
import { parseSearch } from "../patients/domain.js";
import { searchPatientIds, summaries } from "../patients/service.js";

/** Composite read models for the shell: command bar (global.command-bar), notifications, counts, health. */

/** Named command-bar actions (NAV-08) and the operation that must be available for each. */
const ACTIONS: Array<{ id: string; label: string; op: string; roles: string[] }> = [
  { id: "book", label: "Book appointment", op: "bookAppointment", roles: ["frontdesk", "manager"] },
  { id: "new-patient", label: "New patient", op: "createPatient", roles: ["frontdesk", "manager"] },
  {
    id: "new-message",
    label: "New message",
    op: "createStaffTask",
    roles: ["frontdesk", "ma", "provider", "biller", "manager"],
  },
  {
    id: "new-task",
    label: "New task",
    op: "createTask",
    roles: ["frontdesk", "ma", "provider", "biller", "manager"],
  },
  {
    id: "take-payment",
    label: "Take a payment",
    op: "createPayment",
    roles: ["frontdesk", "biller", "manager"],
  },
];

function screenVisible(s: ScreenDef, role: string): boolean {
  return (
    !!s.route &&
    !s.route.includes(":") &&
    s.nav !== "portal" &&
    s.nav !== "public" &&
    (s.roles as readonly string[]).includes(role)
  );
}

export const workspaceHandlers: HandlerMap = {
  async globalSearch(ctx) {
    const me = ctx.staff();
    const q = (ctx.query.q ?? "").trim();
    const types = ctx.query.types?.length ? ctx.query.types : ["patients", "screens", "actions"];
    let patients: Awaited<ReturnType<typeof summaries>> = [];
    if (types.includes("patients") && q.length >= 2) {
      const parsed = parseSearch(q);
      const ids = await searchPatientIds(ctx.db, { ...parsed, limit: 8, offset: 0 });
      patients = await summaries(ctx.db, ids);
    }
    const term = q.toLowerCase();
    const screenRows = types.includes("screens")
      ? (Object.values(screens) as ScreenDef[])
          .filter(
            (s) =>
              screenVisible(s, me.role) &&
              (!term || s.name.toLowerCase().includes(term) || s.id.includes(term)),
          )
          .slice(0, 8)
          .map((s) => ({ id: s.id, label: s.name, route: s.route! }))
      : [];
    const actions = types.includes("actions")
      ? ACTIONS.filter(
          (a) =>
            a.roles.includes(me.role) &&
            implementedOperations.has(a.op) &&
            (!term || a.label.toLowerCase().includes(term)),
        ).map(({ id, label }) => ({ id, label }))
      : [];
    ctx.audit.detail({ patients: patients.length });
    return { patients, screens: screenRows, actions };
  },

  async getHealth() {
    const checks: Array<{ name: string; status: "ok" | "degraded" | "down" }> = [];
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.push({ name: "database", status: "ok" });
    } catch {
      checks.push({ name: "database", status: "down" });
    }
    try {
      await getRedis().ping();
      checks.push({ name: "redis", status: "ok" });
    } catch {
      checks.push({ name: "redis", status: "down" });
    }
    const status = checks.some((c) => c.status === "down") ? "down" : "ok";
    return { status, version: process.env.npm_package_version ?? "0.0.1", checks };
  },

  async listNotifications(ctx) {
    const me = ctx.staff();
    const limit = limitOf(ctx.query);
    const rows = await ctx.db.notification.findMany({
      where: {
        userId: me.userId,
        ...(ctx.query.cursor ? { createdAt: { lt: new Date(ctx.query.cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      data: toDtos("Notification", page),
      nextCursor: rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null,
      hasMore: rows.length > limit,
    };
  },

  async markNotificationsRead(ctx) {
    const me = ctx.staff();
    await ctx.db.notification.updateMany({
      where: {
        userId: me.userId,
        readAt: null,
        ...(ctx.body.all ? {} : { id: { in: ctx.body.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
  },

  async getInboxCounts(ctx) {
    return inboxCounts(ctx.db, ctx.staff().userId);
  },

  async getJob(ctx) {
    const job = await ctx.db.job.findUnique({ where: { id: ctx.params.jobId } });
    if (!job) throw notFound();
    ctx.audit.resource("Job", job.id);
    return toDto("Job", job);
  },

  async downloadFile(ctx) {
    const file = await ctx.db.fileObject.findUnique({ where: { id: ctx.params.fileId } });
    if (!file || file.deletedAt) throw notFound();
    await assertFileAccess(ctx, file.id);
    ctx.audit.resource("FileObject", file.id);
    const data = await readFileContent(file);
    return binary(file.contentType, data, file.fileName);
  },
};

export async function inboxCounts(tx: Tx, userId: string) {
  const pools = await tx.workPoolMember.findMany({ where: { userId }, include: { pool: true } });
  const poolIds = pools.map((p) => p.poolId);
  const mine = {
    status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] as never },
    OR: [{ ownerUserId: userId }, { ownerUserId: null, poolId: { in: poolIds } }],
  };
  const grouped = await tx.task.groupBy({ by: ["type"], where: mine, _count: { _all: true } });
  const n = (types: string[]) =>
    grouped.filter((g) => types.includes(g.type)).reduce((s, g) => s + g._count._all, 0);
  const byPool = await Promise.all(
    pools.map(async (m) => {
      const open = {
        poolId: m.poolId,
        status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] as never },
      };
      const [count, overdue] = await Promise.all([
        tx.task.count({ where: open }),
        tx.task.count({ where: { ...open, dueAt: { lt: new Date() } } }),
      ]);
      return { workPoolId: m.poolId, name: m.pool.name, count, overdue };
    }),
  );
  return {
    tasks: grouped.reduce((s, g) => s + g._count._all, 0),
    results: n(["RESULT_REVIEW", "CRITICAL_RESULT"]),
    criticalResults: n(["CRITICAL_RESULT"]),
    messages: n(["PATIENT_MESSAGE"]),
    rxRequests: n(["RX_REQUEST"]),
    cosign: n(["COSIGN"]),
    documents: n(["DOCUMENT_FILING"]),
    byPool,
  };
}

/**
 * A file is served only when the caller can see something that references it (docs/10-hipaa-controls.md rule 5):
 * an export job they requested, or a patient document / record they may open (INV-SEC-03 applies through
 * requirePatient). Modules register more owners as they add files.
 */
type FileOwnerResolver = (
  tx: Tx,
  fileId: string,
) => Promise<{ patientId?: string | null; jobRequestedBy?: string | null } | null>;
const fileOwnerResolvers: FileOwnerResolver[] = [
  async (tx, fileId) => {
    const job = await tx.job.findFirst({ where: { resultFileIds: { has: fileId } } });
    return job ? { jobRequestedBy: job.requestedById } : null;
  },
  async (tx, fileId) => {
    const doc = await tx.documentReference.findFirst({ where: { fileId } });
    return doc ? { patientId: doc.patientId } : null;
  },
  async (tx, fileId) => {
    const p = await tx.patient.findFirst({ where: { photoFileId: fileId } });
    return p ? { patientId: p.id } : null;
  },
  async (tx, fileId) => {
    const c = await tx.coverage.findFirst({
      where: { OR: [{ cardFrontFileId: fileId }, { cardBackFileId: fileId }] },
    });
    return c ? { patientId: c.patientId } : null;
  },
];

export function registerFileOwner(r: FileOwnerResolver): void {
  fileOwnerResolvers.push(r);
}

async function assertFileAccess(ctx: Ctx, fileId: string): Promise<void> {
  const me = ctx.staff();
  for (const resolve of fileOwnerResolvers) {
    const owner = await resolve(ctx.db, fileId);
    if (!owner) continue;
    if (owner.jobRequestedBy !== undefined) {
      if (owner.jobRequestedBy === me.userId || me.role === "manager") return;
      continue;
    }
    if (owner.patientId) {
      await requirePatient(ctx, owner.patientId);
      return;
    }
    return;
  }
  throw forbidden("forbidden", "You can't open this file.");
}
