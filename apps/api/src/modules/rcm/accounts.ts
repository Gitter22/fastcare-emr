import { formatMoney } from "@agile-emr/shared";
import type { Patient, PaymentPlan, Tx } from "../../db.js";
import { getEnv } from "../../env.js";
import { payments } from "../../gateways/payment/index.js";
import { putFile, readFileContent } from "../../gateways/fileStore.js";
import { queuePatientMessage } from "../../platform/communications.js";
import { toDto } from "../../platform/dto.js";
import { binary, type Ctx, type HandlerMap } from "../../platform/http/context.js";
import { recordCall } from "../../platform/integrations.js";
import {
  centsToMoney,
  patientBalanceCents,
  postLedger,
  toCentsDec,
} from "../../platform/ledger.js";
import { notifyRole } from "../../platform/notify.js";
import { renderPdf } from "../../platform/pdf.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable, validationFailed } from "../../platform/problem.js";
import { settingValue } from "../../platform/settings.js";
import { summaries } from "../patients/service.js";
import { takePayment } from "../billing/payments.js";

/**
 * Patient account (billing.patient-account, billing.payment-capture, billing.statements; flow:rcm/08).
 * Balances are always derived from the ledger (INV-FIN-02); refunds are new REFUND rows (INV-FIN-01).
 * Statements and plan confirmations go out through MessagingGateway with no clinical detail (INV-SEC-06).
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function balanceOf(tx: Tx, patientId: string) {
  const [patient, insurance, plan] = await Promise.all([
    patientBalanceCents(tx, patientId, "PATIENT"),
    patientBalanceCents(tx, patientId, "INSURANCE"),
    tx.paymentPlan.findFirst({ where: { patientId, status: "ACTIVE" } }),
  ]);
  let oldestDays: number | undefined;
  if (patient > 0) {
    const oldest = await tx.ledgerEntry.findFirst({
      where: { patientId, responsibility: "PATIENT", amount: { gt: 0 } },
      orderBy: { postedAt: "asc" },
    });
    if (oldest) oldestDays = Math.floor((Date.now() - oldest.postedAt.getTime()) / 86_400_000);
  }
  void plan;
  return {
    patientId,
    insurancePending: centsToMoney(Math.max(0, insurance)),
    patientDue: centsToMoney(Math.max(0, patient)),
    credit: centsToMoney(Math.max(0, -patient)),
    inCollections: false,
    ...(oldestDays !== undefined ? { oldestDays } : {}),
  };
}

async function practiceName(tx: Tx, practiceId: string) {
  return (await tx.practice.findUniqueOrThrow({ where: { id: practiceId } })).legalName;
}

// ------------------------------------------------------------------ statements

/** One statement: PDF of the open patient balance, stored encrypted, announced by text/email with a portal link. */
export async function createStatement(
  tx: Tx,
  patient: Patient,
  opts: { prefer?: "SMS" | "EMAIL"; createdById: string | null },
  afterCommit: (fn: () => Promise<void>) => void,
) {
  const dueCents = await patientBalanceCents(tx, patient.id, "PATIENT");
  if (dueCents <= 0) return null;
  const [name, prior, ledger] = await Promise.all([
    practiceName(tx, patient.practiceId),
    tx.statement.count({ where: { patientId: patient.id } }),
    tx.ledgerEntry.findMany({
      where: { patientId: patient.id, responsibility: "PATIENT" },
      orderBy: { postedAt: "asc" },
      take: 200,
    }),
  ]);
  const due = new Date(Date.now() + 30 * 86_400_000);
  const pdf = await renderPdf(
    {
      title: "Patient statement",
      patientLine: `${patient.lastName}, ${patient.firstName} · MRN ${patient.mrn}`,
      practiceName: name,
    },
    (w) => {
      w.keyValue([
        ["Statement date", day(new Date())],
        ["Amount due", formatMoney(centsToMoney(dueCents))],
        ["Due by", day(due)],
      ]);
      w.subheading("Activity");
      w.list(
        ledger.map(
          (l) =>
            `${day(l.postedAt)}  ${l.type.replace(/_/g, " ").toLowerCase()}  ${formatMoney(l.amount.toFixed(2))}${l.memo ? `  ${l.memo}` : ""}`,
        ),
      );
      w.muted("Pay online in the patient portal, by phone, or at your next visit.");
    },
  );
  const file = await putFile(tx, {
    practiceId: patient.practiceId,
    kind: "generated",
    fileName: `statement-${patient.mrn}-${prior + 1}.pdf`,
    contentType: "application/pdf",
    data: pdf,
    uploadedById: opts.createdById,
  });
  const st = await tx.statement.create({
    data: {
      practiceId: patient.practiceId,
      patientId: patient.id,
      cycleNumber: prior + 1,
      amountDue: centsToMoney(dueCents),
      dueDate: due,
      channels: ["portal"],
      fileId: file.id,
    },
  });
  const logId = await queuePatientMessage(
    tx,
    patient.practiceId,
    {
      patientId: patient.id,
      template: "statement-ready",
      params: { practiceName: name, link: `${getEnv().WEB_BASE_URL}/portal/billing` },
      purpose: "statement",
      relatedType: "Statement",
      relatedId: st.id,
      createdById: opts.createdById,
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
    },
    afterCommit,
  );
  if (logId) {
    const log = await tx.communicationLog.findUnique({ where: { id: logId } });
    if (log?.channel)
      return tx.statement.update({
        where: { id: st.id },
        data: { channels: ["portal", log.channel.toLowerCase()] },
      });
  }
  return st;
}

/** Patients a statement run includes: patient balance due, no active payment plan, none sent in the last 25 days. */
async function statementCandidates(tx: Tx) {
  const rows = await tx.$queryRaw<{ id: string; due: bigint }[]>`
    SELECT l."patientId"::text AS id, round(sum(l.amount) * 100)::bigint AS due
    FROM "LedgerEntry" l
    WHERE l.responsibility = 'PATIENT'::"Responsibility"
    GROUP BY l."patientId" HAVING sum(l.amount) > 0`;
  const ids = rows.map((r) => r.id);
  const [plans, recent] = await Promise.all([
    tx.paymentPlan.findMany({
      where: { patientId: { in: ids }, status: "ACTIVE" },
      select: { patientId: true },
    }),
    tx.statement.findMany({
      where: { patientId: { in: ids }, sentAt: { gt: new Date(Date.now() - 25 * 86_400_000) } },
      select: { patientId: true },
    }),
  ]);
  const skip = new Set([...plans, ...recent].map((x) => x.patientId));
  return rows.filter((r) => !skip.has(r.id));
}

function nextCycleDate(dayOfMonth: number, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth, 14));
  if (d <= now) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// ------------------------------------------------------------------ payment plans

const MONTHS_MIN = 2;

/** flow:rcm/08 autopay: charge each due installment once (idempotent per plan + installment). */
export async function runPaymentPlanAutopay(tx: Tx, practiceId: string, now = new Date()) {
  const plans = await tx.paymentPlan.findMany({
    where: { status: "ACTIVE", firstPaymentOn: { lte: now } },
  });
  let charged = 0;
  for (const plan of plans) {
    const months =
      (now.getUTCFullYear() - plan.firstPaymentOn.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      plan.firstPaymentOn.getUTCMonth() +
      (now.getUTCDate() >= plan.firstPaymentOn.getUTCDate() ? 1 : 0);
    const dueCount = Math.min(plan.months, Math.max(0, months));
    const made = await tx.payment.findMany({
      where: {
        patientId: plan.patientId,
        channel: "autopay",
        status: "SUCCEEDED",
        appliedTo: { path: ["0", "paymentPlanId"], equals: plan.id },
      },
    });
    const paidCents = made.reduce((s, p) => s + toCentsDec(p.amount), 0);
    const owed = Math.max(0, await patientBalanceCents(tx, plan.patientId, "PATIENT"));
    const remaining = Math.min(toCentsDec(plan.totalAmount) - paidCents, owed);
    if (remaining <= 0) {
      await tx.paymentPlan.update({ where: { id: plan.id }, data: { status: "COMPLETED" } });
      continue;
    }
    if (made.length >= dueCount) continue;
    const n = made.length + 1;
    const amount =
      n >= plan.months ? remaining : Math.min(toCentsDec(plan.monthlyAmount), remaining);
    const pay = await takePayment(tx, {
      practiceId,
      patientId: plan.patientId,
      amount: centsToMoney(amount),
      method: "CARD",
      paymentMethodId: plan.paymentMethodId,
      channel: "autopay",
      idempotencyKey: `plan:${plan.id}:${n}`,
      appliedTo: [{ paymentPlanId: plan.id, installment: n, amount: centsToMoney(amount) }],
    });
    if (pay.status === "SUCCEEDED") charged++;
    else {
      const missed = plan.missedCount + 1;
      await tx.paymentPlan.update({
        where: { id: plan.id },
        data: { missedCount: missed, ...(missed >= 3 ? { status: "DEFAULTED" } : {}) },
      });
      await notifyRole(tx, practiceId, "BILLER", {
        type: "GENERAL",
        title: `A payment plan autopay was declined (${missed} missed)`,
        linkRoute: `/billing/accounts/${plan.patientId}`,
      });
    }
  }
  return charged;
}

// ------------------------------------------------------------------ handlers

async function loadPatient(ctx: Ctx, patientId: string) {
  return requirePatient(ctx, patientId, { identityOnly: true });
}

export const accountHandlers: HandlerMap = {
  async getPatientBalance(ctx) {
    await loadPatient(ctx, ctx.params.patientId);
    return balanceOf(ctx.db, ctx.params.patientId);
  },

  async getPatientAccount(ctx) {
    const p = await loadPatient(ctx, ctx.params.patientId);
    const [summary] = await summaries(ctx.db, [p.id]);
    const [balance, ledger, pays, plans, statements, methods, guarantor] = await Promise.all([
      balanceOf(ctx.db, p.id),
      ctx.db.ledgerEntry.findMany({
        where: { patientId: p.id },
        orderBy: { postedAt: "desc" },
        take: 300,
      }),
      ctx.db.payment.findMany({
        where: { patientId: p.id },
        orderBy: { takenAt: "desc" },
        take: 100,
      }),
      ctx.db.paymentPlan.findMany({ where: { patientId: p.id }, orderBy: { createdAt: "desc" } }),
      ctx.db.statement.findMany({
        where: { patientId: p.id },
        orderBy: { sentAt: "desc" },
        take: 24,
      }),
      ctx.db.paymentMethod.findMany({ where: { patientId: p.id, active: true } }),
      p.guarantorRelatedPersonId
        ? ctx.db.relatedPerson.findUnique({ where: { id: p.guarantorRelatedPersonId } })
        : null,
    ]);
    return {
      patient: summary!,
      ...(guarantor
        ? { guarantor: `${guarantor.firstName} ${guarantor.lastName}` }
        : { guarantor: "Self" }),
      balance,
      ledger: ledger.map((l) => toDto("LedgerEntry", l)),
      payments: pays.map((x) => toDto("Payment", x)),
      paymentPlans: plans.map((x) => toDto("PaymentPlan", x)),
      statements: statements.map((x) => toDto("Statement", x)),
      paymentMethods: methods.map((x) => toDto("PaymentMethod", x)),
    };
  },

  async listLedgerEntries(ctx) {
    await loadPatient(ctx, ctx.params.patientId);
    const q = ctx.query;
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const rows = await ctx.db.ledgerEntry.findMany({
      where: {
        patientId: ctx.params.patientId,
        ...(q.fromDate || q.toDate
          ? {
              postedAt: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(`${q.toDate}T23:59:59Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ postedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    return {
      data: slice.map((l) => toDto("LedgerEntry", l)),
      nextCursor: rows.length > limit ? slice[slice.length - 1]!.id : null,
      hasMore: rows.length > limit,
    };
  },

  async refundPayment(ctx) {
    ctx.requireStepUp();
    const pay = await ctx.db.payment.findUnique({ where: { id: ctx.params.paymentId } });
    if (!pay || pay.status !== "SUCCEEDED" || pay.refundOfId) throw notFound();
    await loadPatient(ctx, pay.patientId);
    const b = ctx.body;
    const amount = toCentsDec(b.amount);
    if (amount <= 0)
      throw validationFailed([
        { field: "amount", code: "min", message: "Enter an amount above zero." },
      ]);
    const refunded = (
      await ctx.db.payment.findMany({ where: { refundOfId: pay.id, status: "SUCCEEDED" } })
    ).reduce((s, r) => s + toCentsDec(r.amount), 0);
    if (amount > toCentsDec(pay.amount) - refunded)
      throw unprocessable(
        "exceeds_payment",
        `Only ${centsToMoney(toCentsDec(pay.amount) - refunded)} of this payment is left to refund.`,
      );
    // Refunds return a credit balance only (billing.payment-capture pc-refund "when credit balance").
    const credit = -(await patientBalanceCents(ctx.db, pay.patientId, "PATIENT"));
    if (amount > credit)
      throw unprocessable(
        "exceeds_credit",
        `The account credit is ${centsToMoney(Math.max(0, credit))}; refund no more than that.`,
      );
    const me = ctx.staff();
    const key = `refund:${pay.id}:${ctx.headers["idempotency-key"] ?? refunded}`;
    const electronic = pay.method === "CARD" || pay.method === "ACH";
    let processorRef: string | null = null;
    if (electronic && b.toOriginalMethod) {
      const out = await recordCall(
        ctx.db,
        {
          practiceId: pay.practiceId,
          kind: "PAYMENT",
          messageType: "PAYMENT_REFUND",
          idempotencyKey: key,
          correlationType: "Payment",
          correlationId: pay.id,
          failed: (r) => (r.ok ? null : (r.declineCode ?? "refund_failed")),
          vendorRef: (r) => r.processorRef,
        },
        () => payments.refund(pay.processorRef ?? "", amount, key),
      );
      if (!out.ok)
        throw unprocessable("refund_failed", "The card processor did not accept the refund.");
      processorRef = out.processorRef;
    }
    const row = await ctx.db.payment.create({
      data: {
        practiceId: pay.practiceId,
        patientId: pay.patientId,
        method: b.toOriginalMethod ? pay.method : "CHECK",
        paymentMethodId: b.toOriginalMethod ? pay.paymentMethodId : null,
        amount: centsToMoney(amount),
        status: "SUCCEEDED",
        processorRef,
        channel: "front-desk",
        refundOfId: pay.id,
        takenById: me.userId,
        locationId: pay.locationId,
      },
    });
    await postLedger(ctx.db, [
      {
        practiceId: pay.practiceId,
        patientId: pay.patientId,
        paymentId: row.id,
        type: "REFUND",
        responsibility: "PATIENT",
        cents: amount,
        memo: `Refund: ${b.reason}`.slice(0, 200),
        postedById: me.userId,
      },
    ]);
    if (amount + refunded >= toCentsDec(pay.amount))
      await ctx.db.payment.update({ where: { id: pay.id }, data: { status: "REFUNDED" } });
    ctx.audit.resource("Payment", pay.id);
    ctx.audit.detail({ refunded: centsToMoney(amount), toOriginalMethod: b.toOriginalMethod });
    return toDto("Payment", row);
  },

  async getPaymentReceipt(ctx) {
    const pay = await ctx.db.payment.findUnique({ where: { id: ctx.params.paymentId } });
    if (!pay || pay.status === "FAILED") throw notFound();
    const p = await loadPatient(ctx, pay.patientId);
    const pdf = await renderPdf(
      {
        title: pay.refundOfId ? "Refund receipt" : "Payment receipt",
        patientLine: `${p.lastName}, ${p.firstName} · MRN ${p.mrn}`,
        practiceName: await practiceName(ctx.db, pay.practiceId),
      },
      (w) =>
        w.keyValue([
          ["Date", day(pay.takenAt)],
          ["Amount", formatMoney(pay.amount.toFixed(2))],
          ["Method", pay.method.toLowerCase()],
          ...(pay.checkNumber ? ([["Check", pay.checkNumber]] as Array<[string, string]>) : []),
          ["Reference", pay.id.slice(0, 8)],
        ]),
    );
    return binary("application/pdf", pdf, `receipt-${pay.id.slice(0, 8)}.pdf`, true);
  },

  // -------------------------------------------------------------- statements
  async getStatementCycle(ctx) {
    const day = await settingValue(ctx.db, "billing.statementCycleDay", 1);
    const candidates = await statementCandidates(ctx.db);
    return {
      id: ctx.practiceId!,
      runAt: nextCycleDate(Math.min(Math.max(1, day), 28)).toISOString(),
      statements: candidates.length,
      total: centsToMoney(candidates.reduce((s, c) => s + Number(c.due), 0)),
      status: "QUEUED" as const,
    };
  },

  async runStatements(ctx) {
    const me = ctx.staff();
    const job = await ctx.db.job.create({
      data: {
        practiceId: ctx.practiceId!,
        type: "statement-run",
        params: {},
        status: "RUNNING",
        requestedById: me.userId,
      },
    });
    const candidates = await statementCandidates(ctx.db);
    let sent = 0;
    for (const c of candidates) {
      const p = await ctx.db.patient.findUniqueOrThrow({ where: { id: c.id } });
      if (await createStatement(ctx.db, p, { createdById: me.userId }, ctx.afterCommit)) {
        sent++;
        ctx.audit.add({
          action: "DISCLOSE",
          patientId: p.id,
          resourceType: "Statement",
          operationId: "runStatements",
          detail: { channel: "statement" },
        });
      }
    }
    const done = await ctx.db.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", progress: 100, finishedAt: new Date(), params: { sent } },
    });
    ctx.audit.detail({ sent });
    ctx.setStatus(202);
    return toDto("Job", done);
  },

  async listStatements(ctx) {
    const q = ctx.query;
    if (q.patientId) await loadPatient(ctx, q.patientId);
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const rows = await ctx.db.statement.findMany({
      where: {
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.fromDate || q.toDate
          ? {
              sentAt: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(`${q.toDate}T23:59:59Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ sentAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    return {
      data: slice.map((s) => toDto("Statement", s)),
      nextCursor: rows.length > limit ? slice[slice.length - 1]!.id : null,
      hasMore: rows.length > limit,
    };
  },

  async getStatementPdf(ctx) {
    const st = await ctx.db.statement.findUnique({ where: { id: ctx.params.statementId } });
    if (!st) throw notFound();
    await loadPatient(ctx, st.patientId);
    const file = await ctx.db.fileObject.findUniqueOrThrow({ where: { id: st.fileId } });
    return binary("application/pdf", await readFileContent(file), file.fileName, true);
  },

  async sendStatementNow(ctx) {
    const p = await loadPatient(ctx, ctx.params.patientId);
    const channel = ctx.body.channel;
    if (channel !== "SMS" && channel !== "EMAIL")
      throw validationFailed([
        { field: "channel", code: "unsupported", message: "Statements go by text or email." },
      ]);
    const st = await createStatement(
      ctx.db,
      p,
      { prefer: channel, createdById: ctx.staff().userId },
      ctx.afterCommit,
    );
    if (!st) throw unprocessable("nothing_due", "This patient has no balance due.");
    ctx.audit.resource("Statement", st.id);
    return toDto("Statement", st);
  },

  // -------------------------------------------------------------- payment plans
  async listPaymentPlans(ctx) {
    await loadPatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.paymentPlan.findMany({
      where: { patientId: ctx.params.patientId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => toDto("PaymentPlan", r));
  },

  async createPaymentPlan(ctx) {
    const p = await loadPatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    const total = toCentsDec(b.totalAmount);
    const due = await patientBalanceCents(ctx.db, p.id, "PATIENT");
    const maxMonths = await settingValue(ctx.db, "billing.paymentPlanMaxMonths", 12);
    if (total <= 0 || total > due)
      throw validationFailed([
        {
          field: "totalAmount",
          code: "range",
          message: `The plan can cover up to the ${centsToMoney(Math.max(0, due))} due.`,
        },
      ]);
    if (!Number.isInteger(b.months) || b.months < MONTHS_MIN || b.months > maxMonths)
      throw validationFailed([
        { field: "months", code: "range", message: `Choose ${MONTHS_MIN} to ${maxMonths} months.` },
      ]);
    if (new Date(b.firstPaymentOn) < new Date(day(new Date())))
      throw validationFailed([
        {
          field: "firstPaymentOn",
          code: "past",
          message: "The first payment can't be in the past.",
        },
      ]);
    const card = await ctx.db.paymentMethod.findFirst({
      where: { id: b.paymentMethodId, patientId: p.id, active: true },
    });
    if (!card)
      throw validationFailed([
        {
          field: "paymentMethodId",
          code: "not_on_file",
          message: "Choose a card on file for autopay.",
        },
      ]);
    if (await ctx.db.paymentPlan.findFirst({ where: { patientId: p.id, status: "ACTIVE" } }))
      throw conflict("plan_exists", "This patient already has an active payment plan.");
    const monthly = Math.ceil(total / b.months);
    const plan: PaymentPlan = await ctx.db.paymentPlan.create({
      data: {
        practiceId: p.practiceId,
        patientId: p.id,
        totalAmount: centsToMoney(total),
        months: b.months,
        monthlyAmount: centsToMoney(monthly),
        firstPaymentOn: new Date(b.firstPaymentOn),
        paymentMethodId: card.id,
        createdById: ctx.staff().userId,
      },
    });
    await queuePatientMessage(
      ctx.db,
      p.practiceId,
      {
        patientId: p.id,
        template: "payment-plan-created",
        params: {
          practiceName: await practiceName(ctx.db, p.practiceId),
          amount: formatMoney(centsToMoney(monthly)),
          months: b.months,
          link: `${getEnv().WEB_BASE_URL}/portal/billing`,
        },
        purpose: "payment-plan",
        relatedType: "PaymentPlan",
        relatedId: plan.id,
        createdById: ctx.staff().userId,
        prefer: "SMS",
      },
      ctx.afterCommit,
    );
    ctx.audit.resource("PaymentPlan", plan.id);
    ctx.setStatus(201);
    return toDto("PaymentPlan", plan);
  },

  async cancelPaymentPlan(ctx) {
    const plan = await ctx.db.paymentPlan.findUnique({ where: { id: ctx.params.paymentPlanId } });
    if (!plan) throw notFound();
    await loadPatient(ctx, plan.patientId);
    if (plan.status !== "ACTIVE") throw conflict("plan_not_active", "This plan is not active.");
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([{ field: "reason", code: "required", message: "Give a reason." }]);
    const row = await ctx.db.paymentPlan.update({
      where: { id: plan.id },
      data: { status: "CANCELLED" },
    });
    ctx.audit.detail({ reason });
    return toDto("PaymentPlan", row);
  },
};
