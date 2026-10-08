import type { Prisma, Tx } from "../../db.js";
import { encryptField } from "../../platform/crypto.js";
import { limitOf, page, toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import {
  connectedGateways,
  GATEWAY_FOR,
  integrationDisplayName,
} from "../../platform/integrations.js";
import { canResend, resendMessage } from "../../platform/interfaceRetry.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";

/** admin.interfaces: connection health, message queue and retries (INV-OPS-01). Manager only. */
const NO_PHI_KINDS = new Set(["NPPES", "RXNAV"]);
const FAILED = ["FAILED", "DEAD"] as const;
const OPEN = ["QUEUED", "SENDING", "RETRYING"] as const;

const isConnected = (gateway: string) =>
  connectedGateways().some((g) => g === gateway || g.startsWith(`${gateway}:`));

/** IntegrationConnection has no version column: the last-update time is the optimistic-lock token. */
const versionOf = (c: { updatedAt: Date }) => c.updatedAt.getTime();

async function counts(tx: Tx, connectionIds: string[]) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [failed, queued] = await Promise.all([
    tx.interfaceMessage.groupBy({
      by: ["connectionId"],
      where: {
        connectionId: { in: connectionIds },
        status: { in: [...FAILED] },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
    tx.interfaceMessage.groupBy({
      by: ["connectionId"],
      where: { connectionId: { in: connectionIds }, status: { in: [...OPEN] } },
      _count: { _all: true },
    }),
  ]);
  return {
    failures: new Map(failed.map((r) => [r.connectionId, r._count._all])),
    queue: new Map(queued.map((r) => [r.connectionId, r._count._all])),
  };
}

type Conn = Prisma.IntegrationConnectionGetPayload<object>;

function secretsSet(c: Conn): string[] {
  return c.secretRef.startsWith("enc:") ? ["credentials"] : [];
}

function effectiveHealth(c: Conn) {
  return c.enabled ? c.health : ("DISABLED" as const);
}

async function detail(tx: Tx, c: Conn) {
  const recent = await tx.interfaceMessage.findMany({
    where: { connectionId: c.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
  });
  return {
    ...toDto("IntegrationConnection", c),
    health: effectiveHealth(c),
    recentMessages: recent.map((m) => toDto("InterfaceMessage", m)),
    secretsSet: secretsSet(c),
    version: versionOf(c),
  };
}

async function load(ctx: Ctx, id: string): Promise<Conn> {
  const c = await ctx.db.integrationConnection.findUnique({ where: { id } });
  if (!c) throw notFound();
  ctx.audit.resource("IntegrationConnection", c.id);
  return c;
}

async function retryFailed(ctx: Ctx, c: Conn) {
  const failed = await ctx.db.interfaceMessage.findMany({
    where: { connectionId: c.id, direction: "OUTBOUND", status: { in: [...FAILED] } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const resendable = failed.filter((m) => canResend(m.messageType));
  if (failed.length && !resendable.length)
    throw conflict(
      "cannot_resend",
      "None of the failed messages can be retried from here yet. Resend them from the records they came from.",
    );
  for (const m of resendable) await resendMessage(ctx.db, m);
  return resendable.length;
}

export const integrationHandlers: HandlerMap = {
  async listIntegrations(ctx) {
    const practiceId = ctx.practiceId!;
    // One row per vendor kind so the monitor lists every interface, connected or not.
    const existing = await ctx.db.integrationConnection.findMany({ select: { kind: true } });
    const have = new Set(existing.map((e) => e.kind));
    const missing = (Object.keys(GATEWAY_FOR) as (keyof typeof GATEWAY_FOR)[]).filter(
      (k) => !have.has(k),
    );
    if (missing.length)
      await ctx.db.integrationConnection.createMany({
        data: missing.map((kind) => ({
          practiceId,
          kind,
          gateway: GATEWAY_FOR[kind],
          displayName: integrationDisplayName(kind),
          config: {},
          secretRef: `env:${kind}`,
        })),
        skipDuplicates: true,
      });
    const rows = await ctx.db.integrationConnection.findMany({
      orderBy: [{ displayName: "asc" }],
    });
    const { failures, queue } = await counts(
      ctx.db,
      rows.map((r) => r.id),
    );
    return rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.displayName,
      health: effectiveHealth(c),
      enabled: c.enabled,
      baaOnFile: c.baaOnFile,
      ...(c.lastSuccessAt ? { lastSuccessAt: c.lastSuccessAt.toISOString() } : {}),
      failures24h: failures.get(c.id) ?? 0,
      queueDepth: queue.get(c.id) ?? 0,
      gateway: c.gateway,
      ...(c.lastError ? { lastError: c.lastError } : {}),
      ...(c.certificateExpiresAt
        ? { certificateExpiresAt: c.certificateExpiresAt.toISOString() }
        : {}),
    }));
  },

  async getIntegration(ctx) {
    return detail(ctx.db, await load(ctx, ctx.params.integrationConnectionId));
  },

  async updateIntegration(ctx) {
    ctx.requireStepUp();
    const c = await load(ctx, ctx.params.integrationConnectionId);
    const b = ctx.body;
    ctx.checkVersion(versionOf(c), b.version);
    const baa = b.baaOnFile ?? c.baaOnFile;
    const enabled = b.enabled ?? c.enabled;
    if (enabled && !baa && !NO_PHI_KINDS.has(c.kind) && b.enabled === true)
      throw unprocessable(
        "baa_required",
        "Record the signed business associate agreement before turning this interface on.",
      );
    const updated = await ctx.db.integrationConnection.update({
      where: { id: c.id },
      data: {
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.baaOnFile !== undefined ? { baaOnFile: b.baaOnFile } : {}),
        ...(b.config !== undefined ? { config: b.config as Prisma.InputJsonValue } : {}),
        // updatedAt is the version token: always move it, even if the same values are re-saved.
        updatedAt: new Date(),
      },
    });
    return detail(ctx.db, updated);
  },

  async rotateIntegrationSecret(ctx) {
    ctx.requireStepUp();
    const c = await load(ctx, ctx.params.integrationConnectionId);
    const value = ctx.body.value;
    if (!value.trim()) throw unprocessable("validation_failed", "Enter the new credential.");
    // Same AES-256-GCM field encryption as PHI; stored in the secret reference and never returned or logged.
    await ctx.db.integrationConnection.update({
      where: { id: c.id },
      data: { secretRef: `enc:${encryptField(value)}`, updatedAt: new Date() },
    });
  },

  async testIntegration(ctx) {
    const c = await load(ctx, ctx.params.integrationConnectionId);
    if (!isConnected(c.gateway)) {
      const updated = await ctx.db.integrationConnection.update({
        where: { id: c.id },
        data: { lastError: "Not connected: no vendor credentials configured" },
      });
      return detail(ctx.db, updated);
    }
    return detail(ctx.db, c);
  },

  async retryIntegration(ctx) {
    const c = await load(ctx, ctx.params.integrationConnectionId);
    if (!c.enabled) throw conflict("disabled", "Turn this interface on before retrying messages.");
    await retryFailed(ctx, c);
    return detail(ctx.db, await load(ctx, c.id));
  },

  async listInterfaceMessages(ctx) {
    const c = await load(ctx, ctx.params.integrationConnectionId);
    const q = ctx.query;
    const limit = limitOf(q, 200, 50);
    const rows = await ctx.db.interfaceMessage.findMany({
      where: {
        connectionId: c.id,
        ...(q.status?.length ? { status: { in: q.status as never } } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return page(
      rows,
      limit,
      (m) => toDto("InterfaceMessage", m),
      (m) => m.id,
    );
  },

  async resendInterfaceMessage(ctx) {
    const m = await ctx.db.interfaceMessage.findUnique({
      where: { id: ctx.params.interfaceMessageId },
    });
    if (!m) throw notFound();
    ctx.audit.resource("InterfaceMessage", m.id);
    if (m.direction !== "OUTBOUND" || !FAILED.includes(m.status as never))
      throw conflict("cannot_resend", "Only outbound messages that failed can be resent.");
    await resendMessage(ctx.db, m);
    return toDto(
      "InterfaceMessage",
      await ctx.db.interfaceMessage.findUniqueOrThrow({ where: { id: m.id } }),
    );
  },
};
