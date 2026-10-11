import type { DepositBatch, Payment, Prisma, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { centsToMoney, toCentsDec } from "../../platform/ledger.js";
import { conflict, invariantBlocked, notFound, validationFailed } from "../../platform/problem.js";
import { dayRange, practiceTimeZone, todayLocal } from "../../platform/time.js";

/**
 * Day close (billing.day-close, flow:rcm/09, INV-FIN-04): payments taken at a location on a business date, by user
 * and method, against the drawer count. A non-zero variance needs a reason before the batch closes; closing stamps
 * the payments with the batch and locks it.
 */

type Method = "cash" | "check" | "card";
const METHOD: Partial<Record<Payment["method"], Method>> = {
  CASH: "cash",
  CHECK: "check",
  CARD: "card",
};

interface Totals {
  cash: number;
  check: number;
  card: number;
}

async function paymentsFor(tx: Tx, batch: DepositBatch) {
  const tz = await practiceTimeZone(tx);
  const date = batch.businessDate.toISOString().slice(0, 10);
  const { start, end } = dayRange(date, tz);
  // Payments taken without a visit (balance payments) have no location; they count in the practice's main
  // (first active) location's drawer. OPEN-Q24: per-user drawer/location assignment.
  const main = await tx.location.findFirst({ where: { active: true }, orderBy: { name: "asc" } });
  return tx.payment.findMany({
    where: {
      AND: [
        main?.id === batch.locationId
          ? { OR: [{ locationId: batch.locationId }, { locationId: null }] }
          : { locationId: batch.locationId },
        batch.status === "CLOSED"
          ? { depositBatchId: batch.id }
          : {
              takenAt: { gte: start, lt: end },
              OR: [{ depositBatchId: null }, { depositBatchId: batch.id }],
            },
      ],
      status: { in: ["SUCCEEDED", "REFUNDED"] },
      method: { in: ["CASH", "CHECK", "CARD"] },
      channel: "front-desk",
    },
    orderBy: { takenAt: "asc" },
  });
}

async function expectedOf(tx: Tx, pays: Payment[]) {
  const users = await tx.user.findMany({
    where: {
      id: { in: [...new Set(pays.map((p) => p.takenById).filter((x): x is string => !!x))] },
    },
  });
  const byUser = new Map<string, Totals & { userId: string | null; name: string }>();
  const total: Totals = { cash: 0, check: 0, card: 0 };
  for (const p of pays) {
    const m = METHOD[p.method];
    if (!m) continue;
    // A refund paid back out of the drawer reduces what should be there.
    const c = toCentsDec(p.amount) * (p.refundOfId ? -1 : 1);
    const key = p.takenById ?? "unknown";
    const u = users.find((x) => x.id === p.takenById);
    const row = byUser.get(key) ?? {
      userId: p.takenById,
      name: u ? `${u.firstName} ${u.lastName}` : "Unknown",
      cash: 0,
      check: 0,
      card: 0,
    };
    row[m] += c;
    total[m] += c;
    byUser.set(key, row);
  }
  const money = (t: Totals) => ({
    cash: centsToMoney(t.cash),
    check: centsToMoney(t.check),
    card: centsToMoney(t.card),
  });
  return {
    totals: total,
    json: {
      byUser: [...byUser.values()].map((u) => ({ userId: u.userId, name: u.name, ...money(u) })),
      ...money(total),
    },
  };
}

function countedCents(c: { cash: string; checks: string; cardTerminal?: string | null }) {
  return {
    cash: toCentsDec(c.cash),
    check: toCentsDec(c.checks),
    card: c.cardTerminal != null ? toCentsDec(c.cardTerminal) : null,
  };
}

/** Counted minus expected; the card terminal is compared only when it was counted. */
function varianceOf(expected: Totals, counted: ReturnType<typeof countedCents>) {
  return (
    counted.cash -
    expected.cash +
    (counted.check - expected.check) +
    (counted.card === null ? 0 : counted.card - expected.card)
  );
}

async function view(tx: Tx, batch: DepositBatch) {
  const pays = await paymentsFor(tx, batch);
  const exp = await expectedOf(tx, pays);
  const counted = batch.counted as {
    cash: string;
    checks: string;
    cardTerminal?: string | null;
  } | null;
  const live = batch.status === "OPEN";
  return {
    ...toDto("DepositBatch", live ? { ...batch, expected: exp.json } : batch),
    payments: pays.map((p) => toDto("Payment", p)),
    expectedTotal: centsToMoney(exp.totals.cash + exp.totals.check + exp.totals.card),
    ...(counted
      ? (() => {
          const c = countedCents(counted);
          return { countedTotal: centsToMoney(c.cash + c.check + (c.card ?? 0)) };
        })()
      : {}),
  };
}

async function findOrCreate(tx: Tx, practiceId: string, locationId: string, date: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deposit:${locationId}:${date}`}))`;
  const businessDate = new Date(`${date}T00:00:00Z`);
  return (
    (await tx.depositBatch.findFirst({ where: { locationId, businessDate } })) ??
    tx.depositBatch.create({ data: { practiceId, locationId, businessDate, expected: {} } })
  );
}

export const dayCloseHandlers: HandlerMap = {
  async getDayClose(ctx) {
    const tz = await practiceTimeZone(ctx.db);
    const date = ctx.query.date ?? todayLocal(tz);
    const loc = ctx.query.locationId
      ? await ctx.db.location.findUnique({ where: { id: ctx.query.locationId } })
      : await ctx.db.location.findFirst({ where: { active: true }, orderBy: { name: "asc" } });
    if (!loc) throw notFound("Location not found.");
    const batch = await findOrCreate(ctx.db, loc.practiceId, loc.id, date);
    return view(ctx.db, batch);
  },

  async saveDrawerCounts(ctx) {
    const batch = await ctx.db.depositBatch.findUnique({
      where: { id: ctx.params.depositBatchId },
    });
    if (!batch) throw notFound();
    if (batch.status === "CLOSED") throw conflict("batch_closed", "This day is already closed.");
    const b = ctx.body;
    const counted = countedCents(b);
    if ([counted.cash, counted.check, counted.card ?? 0].some((v) => v < 0 || !Number.isFinite(v)))
      throw validationFailed([
        { field: "cash", code: "min", message: "Counts can't be negative." },
      ]);
    const exp = await expectedOf(ctx.db, await paymentsFor(ctx.db, batch));
    const row = await ctx.db.depositBatch.update({
      where: { id: batch.id },
      data: {
        counted: b as unknown as Prisma.InputJsonValue,
        expected: exp.json as unknown as Prisma.InputJsonValue,
        // Cash and checks go to the bank; card settles through the processor.
        depositTotal: centsToMoney(counted.cash + counted.check),
        variance: centsToMoney(varianceOf(exp.totals, counted)),
      },
    });
    return view(ctx.db, row);
  },

  async closeDepositBatch(ctx) {
    const batch = await ctx.db.depositBatch.findUnique({
      where: { id: ctx.params.depositBatchId },
    });
    if (!batch) throw notFound();
    const b = ctx.body;
    if (
      batch.locationId !== b.locationId ||
      batch.businessDate.toISOString().slice(0, 10) !== b.date
    )
      throw conflict(
        "batch_mismatch",
        "This batch is for a different location or date. Reload and try again.",
      );
    if (batch.status === "CLOSED") throw conflict("batch_closed", "This day is already closed.");
    const pays = await paymentsFor(ctx.db, batch);
    const exp = await expectedOf(ctx.db, pays);
    const counted = countedCents(b.counts);
    const variance = varianceOf(exp.totals, counted);
    const reason = b.varianceReason?.trim() || null;
    // INV-FIN-04: an unexplained variance between posted payments and the deposit blocks the close.
    if (variance !== 0 && !reason)
      throw invariantBlocked(
        [
          {
            code: "variance_unexplained",
            text: `The count is off by ${centsToMoney(variance)}. Explain the variance to close the day.`,
            invariant: "INV-FIN-04",
          },
        ],
        "Explain the variance before closing.",
      );
    const me = ctx.staff();
    await ctx.db.payment.updateMany({
      where: { id: { in: pays.map((p) => p.id) } },
      data: { depositBatchId: batch.id },
    });
    const row = await ctx.db.depositBatch.update({
      where: { id: batch.id },
      data: {
        counted: b.counts as unknown as Prisma.InputJsonValue,
        expected: exp.json as unknown as Prisma.InputJsonValue,
        depositTotal: centsToMoney(counted.cash + counted.check),
        variance: centsToMoney(variance),
        varianceReason: reason,
        status: "CLOSED",
        closedById: me.userId,
        closedAt: new Date(),
      },
    });
    ctx.audit.resource("DepositBatch", batch.id);
    ctx.audit.detail({ variance: centsToMoney(variance), payments: pays.length });
    return view(ctx.db, row);
  },

  async getCollectionsReport(ctx) {
    const q = ctx.query;
    const to = q.toDate ? new Date(`${q.toDate}T23:59:59Z`) : new Date();
    const from = q.fromDate ? new Date(q.fromDate) : new Date(to.getTime() - 90 * 86_400_000);
    const groupBy = q.groupBy === "payer" || q.groupBy === "provider" ? q.groupBy : "month";
    const rows = await ctx.db.$queryRaw<
      Array<{ key: string; charges: bigint; payments: bigint; adjustments: bigint }>
    >`
      SELECT
        CASE ${groupBy}
          WHEN 'payer' THEN coalesce(py.name, 'Self-pay')
          WHEN 'provider' THEN coalesce(pr."lastName" || ', ' || pr."firstName", 'Unassigned')
          ELSE to_char(l."postedAt", 'YYYY-MM') END AS key,
        round(coalesce(sum(l.amount) FILTER (WHERE l.type = 'CHARGE' AND l.responsibility = 'INSURANCE'
              OR l.type = 'CHARGE' AND l.responsibility = 'PATIENT'), 0) * 100)::bigint AS charges,
        round(coalesce(-sum(l.amount) FILTER (WHERE l.type IN ('INSURANCE_PAYMENT', 'PATIENT_PAYMENT')), 0) * 100)::bigint
          - round(coalesce(sum(l.amount) FILTER (WHERE l.type IN ('REFUND', 'RECOUPMENT')), 0) * 100)::bigint AS payments,
        round(coalesce(-sum(l.amount) FILTER (WHERE l.type IN ('CONTRACTUAL_ADJUSTMENT', 'WRITE_OFF')), 0) * 100)::bigint AS adjustments
      FROM "LedgerEntry" l
      LEFT JOIN "Claim" c ON c.id = l."claimId"
      LEFT JOIN "Payer" py ON py.id = c."payerId"
      LEFT JOIN "Encounter" e ON e.id = l."encounterId"
      LEFT JOIN "Practitioner" pr ON pr.id = e."practitionerId"
      WHERE l."postedAt" >= ${from} AND l."postedAt" <= ${to}
      GROUP BY 1 ORDER BY 1`;
    return {
      period: `${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`,
      rows: rows.map((r) => {
        const charges = Number(r.charges);
        const pay = Number(r.payments);
        const adj = Number(r.adjustments);
        const net = charges - adj;
        return {
          key: r.key,
          charges: centsToMoney(charges),
          payments: centsToMoney(pay),
          adjustments: centsToMoney(adj),
          netCollectionRate: net > 0 ? Math.round((pay / net) * 1000) / 10 : 0,
        };
      }),
    };
  },
};
