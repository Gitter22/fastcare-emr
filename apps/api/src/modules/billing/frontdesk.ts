import type { Prisma } from "../../db.js";
import { getEnv } from "../../env.js";
import { readFileContent } from "../../gateways/fileStore.js";
import { queuePatientMessage } from "../../platform/communications.js";
import { decryptField, encryptField } from "../../platform/crypto.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { addDays, dayRange, practiceTimeZone, todayLocal } from "../../platform/time.js";
import { writeVersion } from "../../platform/versioning.js";
import { appointmentViews } from "../scheduling/views.js";
import { runEligibility } from "./eligibility.js";
import { takePayment } from "./payments.js";
import { payments } from "../../gateways/payment/index.js";
import { formatMoney } from "@agile-emr/shared";

/**
 * Front-end revenue cycle and coverage (flow:access/03, flow:checkin/01): coverages, real-time and batch
 * eligibility, payments and cards on file, consents.
 */
const date = (s: string | null | undefined) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : s === null ? null : undefined;

export async function coverageView(ctx: Pick<Ctx, "db">, id: string) {
  const c = await ctx.db.coverage.findUniqueOrThrow({
    where: { id },
    include: { payer: true, eligibilityChecks: { orderBy: { requestedAt: "desc" }, take: 1 } },
  });
  const plan = c.planId ? await ctx.db.payerPlan.findUnique({ where: { id: c.planId } }) : null;
  const files = await ctx.db.fileObject.findMany({
    where: { id: { in: [c.cardFrontFileId, c.cardBackFileId].filter((x): x is string => !!x) } },
  });
  const { payer, eligibilityChecks, ...row } = c;
  return {
    ...toDto("Coverage", { ...row, memberId: decryptField(row.memberId) }),
    payer: toDto("Payer", payer),
    ...(plan ? { plan: toDto("PayerPlan", plan) } : {}),
    ...(eligibilityChecks[0]
      ? { lastEligibility: toDto("EligibilityCheck", eligibilityChecks[0]) }
      : {}),
    ...(files.find((f) => f.id === c.cardFrontFileId)
      ? {
          cardFront: toDto(
            "FileObject",
            files.find((f) => f.id === c.cardFrontFileId),
          ),
        }
      : {}),
    ...(files.find((f) => f.id === c.cardBackFileId)
      ? {
          cardBack: toDto(
            "FileObject",
            files.find((f) => f.id === c.cardBackFileId),
          ),
        }
      : {}),
  };
}

export const frontDeskBillingHandlers: HandlerMap = {
  // ------------------------------------------------------------------ coverage
  async listCoverages(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.coverage.findMany({
      where: { patientId: p.id, status: { not: "entered-in-error" } },
      orderBy: [{ status: "asc" }, { order: "asc" }],
    });
    return Promise.all(rows.map((r) => coverageView(ctx, r.id)));
  },

  async createCoverage(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    const payer = await ctx.db.payer.findUnique({ where: { id: b.payerId } });
    if (!payer?.active)
      throw unprocessable("validation_failed", "Choose an active payer.", {
        errors: [{ field: "payerId", code: "invalid", message: "Choose an active payer." }],
      });
    const order = b.order ?? 1;
    // One active coverage per order: the new one takes the slot, the old one moves down.
    await ctx.db.coverage.updateMany({
      where: { patientId: p.id, order, status: "active" },
      data: { order: { increment: 1 } },
    });
    const c = await ctx.db.coverage.create({
      data: {
        ...b,
        practiceId: ctx.practiceId!,
        patientId: p.id,
        order,
        memberId: encryptField(b.memberId.trim()),
        periodStart: date(b.periodStart),
        periodEnd: date(b.periodEnd),
      } as Prisma.CoverageUncheckedCreateInput,
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Coverage", c, ctx.staff().userId, "create");
    ctx.audit.resource("Coverage", c.id);
    return toDto("Coverage", { ...c, memberId: b.memberId.trim() });
  },

  async updateCoverage(ctx) {
    const c = await ctx.db.coverage.findUnique({ where: { id: ctx.params.coverageId } });
    if (!c) throw notFound();
    await requirePatient(ctx, c.patientId);
    ctx.checkVersion(c.version);
    const b = ctx.body;
    const updated = await ctx.db.coverage.update({
      where: { id: c.id },
      data: {
        ...(b as Prisma.CoverageUncheckedUpdateInput),
        ...(b.memberId ? { memberId: encryptField(b.memberId.trim()) } : {}),
        ...(b.periodStart !== undefined ? { periodStart: date(b.periodStart) } : {}),
        ...(b.periodEnd !== undefined ? { periodEnd: date(b.periodEnd) } : {}),
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Coverage", updated, ctx.staff().userId, "update");
    ctx.audit.resource("Coverage", c.id);
    ctx.audit.detail({ fields: Object.keys(b) });
    return toDto("Coverage", { ...updated, memberId: decryptField(updated.memberId) });
  },

  // ------------------------------------------------------------------ eligibility
  async checkEligibility(ctx) {
    const c = await ctx.db.coverage.findUnique({ where: { id: ctx.params.coverageId } });
    if (!c) throw notFound();
    await requirePatient(ctx, c.patientId);
    const check = await runEligibility(ctx.db, {
      practiceId: ctx.practiceId!,
      coverageId: c.id,
      mode: "realtime",
      dateOfService: ctx.body.dateOfService,
      serviceTypeCodes: ctx.body.serviceTypeCodes,
      practitionerId: ctx.body.practitionerId,
      userId: ctx.staff().userId,
    });
    ctx.audit.resource("EligibilityCheck", check.id);
    return toDto("EligibilityCheck", check);
  },

  async listEligibilityChecks(ctx) {
    const c = await ctx.db.coverage.findUnique({ where: { id: ctx.params.coverageId } });
    if (!c) throw notFound();
    await requirePatient(ctx, c.patientId);
    const rows = await ctx.db.eligibilityCheck.findMany({
      where: { coverageId: c.id },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    return { data: toDtos("EligibilityCheck", rows), nextCursor: null, hasMore: false };
  },

  async getEligibilityCheck(ctx) {
    const e = await ctx.db.eligibilityCheck.findUnique({
      where: { id: ctx.params.eligibilityCheckId },
      include: { coverage: true },
    });
    if (!e) throw notFound();
    await requirePatient(ctx, e.coverage.patientId);
    const { coverage: _c, ...row } = e;
    const benefits = [];
    const rawId = (e.benefits as { rawFileId?: string } | null)?.rawFileId;
    if (rawId) {
      const file = await ctx.db.fileObject.findUnique({ where: { id: rawId } });
      if (file) {
        const raw = JSON.parse((await readFileContent(file)).toString("utf8")) as {
          benefitsInformation?: Array<Record<string, unknown>>;
        };
        for (const bi of raw.benefitsInformation ?? []) {
          const types = Array.isArray(bi.serviceTypes) ? (bi.serviceTypes as string[]) : [];
          benefits.push({
            serviceType:
              types[0] ?? String((bi.serviceTypeCodes as string[] | undefined)?.[0] ?? ""),
            ...(bi.inPlanNetworkIndicatorCode
              ? { inNetwork: bi.inPlanNetworkIndicatorCode === "Y" }
              : {}),
            ...(bi.code === "B" && bi.benefitAmount
              ? { copay: Number(bi.benefitAmount).toFixed(2) }
              : {}),
            ...(bi.code === "A" && bi.benefitPercent
              ? {
                  coinsurancePercent:
                    Number(bi.benefitPercent) * (Number(bi.benefitPercent) <= 1 ? 100 : 1),
                }
              : {}),
            ...(bi.code === "C" && bi.benefitAmount
              ? {
                  [bi.timeQualifierCode === "29" ? "deductibleRemaining" : "deductible"]: Number(
                    bi.benefitAmount,
                  ).toFixed(2),
                }
              : {}),
            ...(bi.code === "G" && bi.timeQualifierCode === "29" && bi.benefitAmount
              ? { oopRemaining: Number(bi.benefitAmount).toFixed(2) }
              : {}),
            ...(bi.authOrCertIndicator === "Y" ? { authRequired: true } : {}),
          });
        }
      }
    }
    return {
      ...toDto("EligibilityCheck", row),
      benefitLines: benefits,
      messages: e.errorMessage ? [e.errorMessage] : [],
    };
  },

  async listEligibilityWorklist(ctx) {
    const q = ctx.query;
    const tz = await practiceTimeZone(ctx.db);
    const from = q.fromDate ?? todayLocal(tz);
    const to = q.toDate ?? addDays(from, 2);
    const appts = await ctx.db.appointment.findMany({
      where: {
        start: { gte: dayRange(from, tz).start, lt: dayRange(to, tz).end },
        status: { in: ["BOOKED", "CONFIRMED", "ARRIVED", "REQUESTED"] },
        ...(q.locationId ? { locationId: q.locationId } : {}),
      },
      orderBy: { start: "asc" },
    });
    const views = await appointmentViews(ctx.db, appts);
    const rows = [];
    for (const v of views) {
      const cov = await ctx.db.coverage.findFirst({
        where: { patientId: v.patient.id, status: "active" },
        orderBy: { order: "asc" },
      });
      const status = cov ? (v.eligibility ?? "UNKNOWN") : "UNKNOWN";
      if (q.status?.length && !q.status.includes(status as never)) continue;
      const last = cov
        ? await ctx.db.eligibilityCheck.findFirst({
            where: { coverageId: cov.id },
            orderBy: { requestedAt: "desc" },
          })
        : null;
      rows.push({
        appointment: v,
        ...(cov ? { coverage: await coverageView(ctx, cov.id) } : {}),
        status: status as "ACTIVE",
        ...(last ? { checkedAt: last.requestedAt.toISOString() } : {}),
        ...(!cov
          ? { issue: "No insurance on file (self-pay)" }
          : status === "INACTIVE"
            ? { issue: "Coverage inactive" }
            : status === "ERROR"
              ? { issue: "Could not verify" }
              : !last
                ? { issue: "Not checked yet" }
                : {}),
      });
    }
    return { data: rows, nextCursor: null, hasMore: false };
  },

  async runEligibilityBatch(ctx) {
    const { from, to } = ctx.body;
    const tz = await practiceTimeZone(ctx.db);
    const job = await ctx.db.job.create({
      data: {
        practiceId: ctx.practiceId!,
        type: "eligibility-batch",
        params: { from, to },
        status: "RUNNING",
        requestedById: ctx.staff().userId,
      },
    });
    const appts = await ctx.db.appointment.findMany({
      where: {
        start: { gte: dayRange(from, tz).start, lt: dayRange(to, tz).end },
        status: { in: ["BOOKED", "CONFIRMED"] },
      },
      select: { id: true, patientId: true, practitionerId: true, start: true },
    });
    let checked = 0;
    for (const a of appts) {
      const cov = await ctx.db.coverage.findFirst({
        where: { patientId: a.patientId, status: "active" },
        orderBy: { order: "asc" },
      });
      if (!cov) continue;
      await runEligibility(ctx.db, {
        practiceId: ctx.practiceId!,
        coverageId: cov.id,
        appointmentId: a.id,
        mode: "batch",
        practitionerId: a.practitionerId,
        dateOfService: a.start.toISOString().slice(0, 10),
        userId: ctx.staff().userId,
      });
      checked++;
    }
    const done = await ctx.db.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        progress: 100,
        finishedAt: new Date(),
        params: { from, to, checked },
      },
    });
    ctx.audit.detail({ checked });
    ctx.setStatus(202);
    return toDto("Job", done);
  },

  // ------------------------------------------------------------------ payments
  async createPayment(ctx) {
    const b = ctx.body;
    const patientId =
      b.patientId ??
      (b.appointmentId
        ? (await ctx.db.appointment.findUnique({ where: { id: b.appointmentId } }))?.patientId
        : undefined);
    if (!patientId)
      throw unprocessable(
        "validation_failed",
        "Choose the patient or appointment the payment is for.",
      );
    await requirePatient(ctx, patientId);
    const enc = b.appointmentId
      ? await ctx.db.encounter.findUnique({ where: { appointmentId: b.appointmentId } })
      : null;
    // The drawer the money went into (billing.day-close); balance payments without a visit have none.
    const appt = b.appointmentId
      ? await ctx.db.appointment.findUnique({ where: { id: b.appointmentId } })
      : null;
    const payment = await takePayment(ctx.db, {
      practiceId: ctx.practiceId!,
      patientId,
      amount: b.amount,
      method: b.method,
      paymentMethodId: b.paymentMethodId,
      hostedFieldsToken: b.hostedFieldsToken,
      checkNumber: b.checkNumber,
      appointmentId: b.appointmentId,
      encounterId: enc?.id ?? null,
      channel: "front-desk",
      locationId: appt?.locationId ?? null,
      takenById: ctx.staff().userId,
      idempotencyKey: b.idempotencyKey,
    });
    if (b.savePaymentMethod && b.hostedFieldsToken && payment.status === "SUCCEEDED") {
      const card = await payments.describeToken(b.hostedFieldsToken);
      if (card)
        await ctx.db.paymentMethod.create({
          data: {
            practiceId: ctx.practiceId!,
            patientId,
            processorToken: b.hostedFieldsToken,
            ...card,
          },
        });
    }
    ctx.audit.resource("Payment", payment.id);
    if (payment.status !== "SUCCEEDED") {
      throw unprocessable(
        "payment_declined",
        "The card was declined. Try another method or collect later.",
        { paymentId: payment.id },
      );
    }
    ctx.setHeader("Location", `/api/v1/payments/${payment.id}`);
    return toDto("Payment", payment);
  },

  async listPaymentMethods(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    return toDtos(
      "PaymentMethod",
      await ctx.db.paymentMethod.findMany({
        where: { patientId: p.id, active: true },
        orderBy: { createdAt: "desc" },
      }),
    );
  },

  async createPaymentMethod(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    if (!b.consentToCardOnFile)
      throw unprocessable("validation_failed", "The patient must agree to keep a card on file.", {
        errors: [
          { field: "consentToCardOnFile", code: "required", message: "Consent is required." },
        ],
      });
    const consent = await ctx.db.consent.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: p.id,
        type: "CARD_ON_FILE",
        status: "ACTIVE",
        signedAt: new Date(),
        method: "verbal",
        recordedById: ctx.staff().userId,
      },
    });
    const card = await payments.describeToken(b.hostedFieldsToken);
    if (!card)
      throw unprocessable("validation_failed", "The card could not be read. Enter it again.");
    const pm = await ctx.db.paymentMethod.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: p.id,
        processorToken: b.hostedFieldsToken,
        ...card,
        consentId: consent.id,
      },
    });
    ctx.audit.resource("PaymentMethod", pm.id);
    return toDto("PaymentMethod", pm);
  },

  async deletePaymentMethod(ctx) {
    const pm = await ctx.db.paymentMethod.findUnique({ where: { id: ctx.params.paymentMethodId } });
    if (!pm) throw notFound();
    await requirePatient(ctx, pm.patientId);
    await ctx.db.paymentMethod.update({ where: { id: pm.id }, data: { active: false } });
  },

  async sendPaymentReceipt(ctx) {
    const pay = await ctx.db.payment.findUnique({ where: { id: ctx.params.paymentId } });
    if (!pay || pay.status !== "SUCCEEDED") throw notFound();
    await requirePatient(ctx, pay.patientId);
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: pay.practiceId } });
    await queuePatientMessage(
      ctx.db,
      pay.practiceId,
      {
        patientId: pay.patientId,
        template: "payment-receipt",
        params: { practiceName: practice.legalName, amount: formatMoney(pay.amount.toFixed(2)) },
        purpose: "receipt",
        relatedType: "Payment",
        relatedId: pay.id,
        prefer: ctx.body.channel === "EMAIL" ? "EMAIL" : "SMS",
        createdById: ctx.staff().userId,
      },
      ctx.afterCommit,
    );
    await ctx.db.payment.update({
      where: { id: pay.id },
      data: { receiptChannel: ctx.body.channel },
    });
    ctx.setStatus(202);
    return { requestId: ctx.requestId, status: "accepted" as const };
  },

  // ------------------------------------------------------------------ consents
  async listConsents(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    return toDtos(
      "Consent",
      await ctx.db.consent.findMany({
        where: { patientId: p.id },
        orderBy: [{ status: "asc" }, { signedAt: "desc" }],
      }),
    );
  },

  async createConsent(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const b = ctx.body;
    if (
      b.type === "PART2_SUD" &&
      !(
        b.scope &&
        (b.scope as { recipient?: unknown }).recipient &&
        (b.scope as { purpose?: unknown }).purpose
      )
    ) {
      // 42 CFR Part 2 consent must name the recipient and purpose (docs/10-hipaa-controls.md).
      throw unprocessable(
        "validation_failed",
        "A Part 2 consent must name the recipient and the purpose.",
        {
          errors: [
            { field: "scope", code: "required", message: "Name the recipient and purpose." },
          ],
        },
      );
    }
    const c = await ctx.db.consent.create({
      data: {
        practiceId: ctx.practiceId!,
        patientId: p.id,
        type: b.type,
        status: b.status ?? "ACTIVE",
        scope: (b.scope ?? undefined) as Prisma.InputJsonValue | undefined,
        signedAt: b.signedAt ? new Date(b.signedAt) : new Date(),
        signedBy: b.signedBy ?? null,
        method: b.method ?? "tablet",
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        documentFileId: b.documentFileId ?? null,
        recordedById: ctx.staff().userId,
      },
    });
    ctx.audit.resource("Consent", c.id);
    return toDto("Consent", c);
  },

  async revokeConsent(ctx) {
    const c = await ctx.db.consent.findUnique({ where: { id: ctx.params.consentId } });
    if (!c) throw notFound();
    await requirePatient(ctx, c.patientId, { identityOnly: true });
    if (c.revokedAt) throw conflict("already_revoked", "This consent was already revoked.");
    const updated = await ctx.db.consent.update({
      where: { id: c.id },
      data: {
        status: "INACTIVE",
        revokedAt: new Date(),
        version: { increment: 1 },
        scope: { ...((c.scope as object) ?? {}), revokedReason: ctx.body.reason },
      },
    });
    ctx.audit.resource("Consent", c.id);
    return toDto("Consent", updated);
  },

  async requestConsentSignature(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: p.practiceId } });
    await queuePatientMessage(
      ctx.db,
      p.practiceId,
      {
        patientId: p.id,
        template: "consent-request",
        params: { practiceName: practice.legalName, link: `${getEnv().WEB_BASE_URL}/portal/todos` },
        purpose: "consent-request",
        createdById: ctx.staff().userId,
      },
      ctx.afterCommit,
    );
    ctx.setStatus(202);
    return { requestId: ctx.requestId, status: "accepted" as const };
  },
};
