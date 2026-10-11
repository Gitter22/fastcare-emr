import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import {
  ClearinghouseUnavailableError,
  clearinghouseGateway,
  fakeClearinghouse,
  isClearinghouseConnected,
  type ReportSet,
} from "../../gateways/clearinghouse/index.js";
import { parseClaimAck277, parseRemittances } from "../../gateways/clearinghouse/claimParsers.js";
import { simulated277, simulated835 } from "../../gateways/clearinghouse/simulated.js";
import { putFile } from "../../gateways/fileStore.js";
import { decryptField } from "../../platform/crypto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { connectionFor } from "../../platform/integrations.js";
import { toCentsDec } from "../../platform/ledger.js";
import { integrationUnavailable, unauthenticated, unprocessable } from "../../platform/problem.js";
import { createTask } from "../../platform/tasks.js";
import { applyClaimAcks, submitBatch } from "./claims.js";
import { ingestRemittance } from "./remittance.js";
import { pcnOf } from "./scrubber.js";

/**
 * Inbound clearinghouse traffic (flow:rcm/04, rcm/06). Stedi calls `stediWebhook` when a 277CA or 835 is ready; we
 * fetch the report through ClearinghouseGateway and run it through the ported parsers. Each report is one INBOUND
 * InterfaceMessage keyed by Stedi's transaction id, so redelivery never posts twice (INV-OPS-01).
 * Outside production the simulated clearinghouse produces the same reports from claim state (dev sweep).
 * OPEN-Q25: report and event shapes follow Stedi docs (not yet observed); the webhook destination is configured
 * per practice with `x-practice-id` and `authorization: Key <stediWebhookKey(connection)>` headers.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Webhook credential: the destination is configured in Stedi with headers x-practice-id and authorization. */
export function stediWebhookKey(connectionId: string) {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(`stedi-webhook:${connectionId}`)
    .digest("hex");
}

function verify(connectionId: string, header: string | undefined) {
  if (!header) return false;
  const want = Buffer.from(`Key ${stediWebhookKey(connectionId)}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

async function inboundMessage(
  tx: Tx,
  practiceId: string,
  set: ReportSet,
  transactionId: string,
  report: unknown,
) {
  const conn = await connectionFor(tx, practiceId, "STEDI");
  const key = `stedi:${set}:${transactionId}`;
  const prior = await tx.interfaceMessage.findUnique({ where: { idempotencyKey: key } });
  if (prior?.status === "ACKNOWLEDGED") return null;
  const file = await putFile(tx, {
    practiceId,
    kind: "generated",
    fileName: `${set}-${transactionId}.json`.replace(/[^\w.-]/g, "_"),
    contentType: "application/json",
    data: Buffer.from(JSON.stringify(report), "utf8"),
  });
  const msg = prior
    ? await tx.interfaceMessage.update({
        where: { id: prior.id },
        data: { attempts: { increment: 1 }, payloadFileId: file.id },
      })
    : await tx.interfaceMessage.create({
        data: {
          practiceId,
          connectionId: conn.id,
          direction: "INBOUND",
          messageType: set === "835" ? "X12_835" : "X12_277CA",
          idempotencyKey: key,
          status: "SENDING",
          attempts: 1,
          payloadFileId: file.id,
          vendorRef: transactionId,
        },
      });
  return { msg, fileId: file.id };
}

async function done(tx: Tx, id: string) {
  await tx.interfaceMessage.update({
    where: { id },
    data: { status: "ACKNOWLEDGED", completedAt: new Date(), error: null },
  });
}

export async function ingestReport(
  tx: Tx,
  practiceId: string,
  set: ReportSet,
  transactionId: string,
  report: unknown,
) {
  const m = await inboundMessage(tx, practiceId, set, transactionId, report);
  if (!m) return { duplicate: true, applied: 0 };
  let applied = 0;
  if (set === "277") {
    const acks = parseClaimAck277(report);
    applied = await applyClaimAcks(tx, practiceId, acks, m.msg.id);
    if (!acks.length) await unreadable(tx, practiceId, m.msg.id, "277CA");
  } else {
    const remits = parseRemittances(report);
    for (const r of remits) if (await ingestRemittance(tx, practiceId, r, m.fileId)) applied++;
    if (!remits.length) await unreadable(tx, practiceId, m.msg.id, "835");
  }
  await done(tx, m.msg.id);
  return { duplicate: false, applied };
}

async function unreadable(tx: Tx, practiceId: string, messageId: string, what: string) {
  await createTask(tx, practiceId, {
    type: "INTERFACE_FAILURE",
    title: `A ${what} from the clearinghouse could not be read`,
    description: "Nothing was posted. The report is kept on the interface monitor for review.",
    focusType: "InterfaceMessage",
    focusId: messageId,
    poolKind: "billing",
    priority: "HIGH",
  });
}

/** Finds the transaction id and set (835 / 277) in a Stedi event, wherever the event nests them. */
function eventFields(body: unknown): { transactionId: string | null; set: ReportSet | null } {
  let transactionId: string | null = null;
  let set: ReportSet | null = null;
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as Record<string, unknown>;
    if (!transactionId && typeof o.transactionId === "string") transactionId = o.transactionId;
    const ts = o.transactionSetIdentifier ?? o.transactionSet;
    if (!set && typeof ts === "string")
      set = ts.startsWith("835") ? "835" : ts.startsWith("277") ? "277" : null;
    Object.values(o).forEach(walk);
  };
  walk(body);
  return { transactionId, set };
}

export const inboundHandlers: HandlerMap = {
  async stediWebhook(ctx) {
    const practiceId = ctx.headers["x-practice-id"] ?? "";
    if (!UUID.test(practiceId)) throw unauthenticated("invalid_signature", "Unknown practice.");
    await ctx.bindTenant(practiceId);
    const practice = await ctx.db.practice.findUnique({ where: { id: practiceId } });
    if (!practice) throw unauthenticated("invalid_signature", "Unknown practice.");
    const conn = await connectionFor(ctx.db, practiceId, "STEDI");
    if (!verify(conn.id, ctx.headers.authorization))
      throw unauthenticated("invalid_signature", "Credential check failed.");
    let body: unknown;
    try {
      body = JSON.parse(ctx.rawBody?.toString("utf8") ?? "");
    } catch {
      throw unprocessable("invalid_body", "The event is not JSON.");
    }
    const { transactionId, set } = eventFields(body);
    if (!transactionId || !set) {
      // Eligibility batch results and other events are acknowledged without action.
      ctx.audit.detail({ ignored: true });
      return { requestId: ctx.requestId, status: "accepted" as const };
    }
    const gw = clearinghouseGateway();
    if (!gw) throw integrationUnavailable("No clearinghouse is connected.");
    let report: unknown;
    try {
      report = await gw.fetchReport(transactionId, set);
    } catch (e) {
      if (e instanceof ClearinghouseUnavailableError) throw integrationUnavailable(e.message);
      throw e;
    }
    const out = await ingestReport(ctx.db, practiceId, set, transactionId, report);
    ctx.audit.resource("IntegrationConnection", conn.id);
    ctx.audit.detail({ set, duplicate: out.duplicate, applied: out.applied });
    return { requestId: ctx.requestId, status: "accepted" as const };
  },
};

// ------------------------------------------------------------------ simulated clearinghouse (dev only)

/**
 * Turns submitted claims into 277CA acknowledgements, and accepted claims into an 835 per payer, `delayMs` after
 * the previous step, through the same ingestion as the webhook. Never runs in production.
 */
export async function runSimulatedClearinghouse(
  tx: Tx,
  practiceId: string,
  now = new Date(),
  delayMs = 2 * 60_000,
) {
  if (getEnv().NODE_ENV === "production" || !isClearinghouseConnected())
    return { acks: 0, remits: 0 };
  if (clearinghouseGateway() !== fakeClearinghouse()) return { acks: 0, remits: 0 };
  const cutoff = new Date(now.getTime() - delayMs);
  // Claims already accepted before this run get their 835; claims acknowledged in this run wait for the next one.
  const accepted = await tx.claim.findMany({
    where: { status: "ACCEPTED", events: { some: { type: "ACK_277CA", at: { lt: cutoff } } } },
    include: { coverage: true, payer: true, lines: true },
    take: 100,
  });
  const submitted = await tx.claim.findMany({
    where: { status: "SUBMITTED", submittedAt: { lt: cutoff } },
    include: { coverage: true },
    take: 100,
  });
  let acks = 0;
  if (submitted.length) {
    const txid = `SIM277-${now.getTime()}-${randomInt(1000, 9999)}`;
    const report = simulated277(
      submitted.map((c) => ({
        patientControlNumber: pcnOf(c.claimNumber),
        memberId: decryptField(c.coverage.memberId),
      })),
    );
    fakeClearinghouse().reports.set(txid, report);
    acks = (await ingestReport(tx, practiceId, "277", txid, report)).applied;
  }
  const byPayer = new Map<string, typeof accepted>();
  for (const c of accepted) byPayer.set(c.payerId, [...(byPayer.get(c.payerId) ?? []), c]);
  let remits = 0;
  for (const claims of byPayer.values()) {
    const payer = claims[0]!.payer;
    const contract = await tx.feeScheduleItem.findMany({
      where: { feeSchedule: { payerId: payer.id, isContract: true }, modifier: null },
    });
    const txid = `SIM835-${now.getTime()}-${randomInt(1000, 9999)}`;
    const report = simulated835({
      traceNumber: String(randomInt(1_000_000, 9_999_999)),
      paymentDate: now.toISOString().slice(0, 10),
      payerName: payer.name,
      payerId: payer.clearinghousePayerId,
      claims: claims.map((c) => {
        const items = c.lines.map((l) => contract.find((i) => i.code === l.code));
        const allowed = items.every(Boolean)
          ? c.lines.reduce(
              (s, l, i) => s + (toCentsDec(items[i]!.amount) * Number(l.units)) / 100,
              0,
            )
          : null;
        return {
          patientControlNumber: pcnOf(c.claimNumber),
          payerClaimControlNumber: `P${pcnOf(c.claimNumber)}`,
          memberId: decryptField(c.coverage.memberId),
          billed: toCentsDec(c.totalBilled) / 100,
          contractAllowed: allowed,
        };
      }),
    });
    fakeClearinghouse().reports.set(txid, report);
    remits += (await ingestReport(tx, practiceId, "835", txid, report)).applied;
  }
  return { acks, remits };
}

/** flow:rcm/03 "batch to clearinghouse": ready claims go out on a schedule (and on demand from billing.claims). */
export async function runClaimBatch(tx: Tx, practiceId: string) {
  if (!clearinghouseGateway()) return 0;
  const results = await submitBatch(tx, practiceId, null, { userId: null, role: "system" });
  return results.filter((r) => r.outcome === "submitted").length;
}
