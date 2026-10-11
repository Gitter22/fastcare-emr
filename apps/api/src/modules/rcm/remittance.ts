import type {
  Claim,
  Prisma,
  Remittance,
  RemittanceAdjustment,
  RemittanceClaimPayment,
  Tx,
} from "../../db.js";
import type { ParsedRemittance } from "../../gateways/clearinghouse/claimParsers.js";
import { readFileContent } from "../../gateways/fileStore.js";
import { toDto } from "../../platform/dto.js";
import { binary, type HandlerMap } from "../../platform/http/context.js";
import {
  type LedgerLine,
  centsToMoney,
  claimInsuranceBalanceCents,
  postLedger,
  toCentsDec,
  transferToPatient,
} from "../../platform/ledger.js";
import { renderPdf } from "../../platform/pdf.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { createTask } from "../../platform/tasks.js";
import { claimEvent, claimSummaries, findByPcn, moveClaim } from "./claims.js";
import { rootCauseOf } from "./denials.js";

/**
 * ERA posting (flow:rcm/06). An 835 becomes a Remittance with one RemittanceClaimPayment per claim and its CARC
 * adjustments. Matched claims auto-post: insurance payment, contractual adjustment (CO-45 up to the contracted
 * rate), patient responsibility transferred to the patient (PR-1/2/3) — all as new ledger rows (INV-FIN-01).
 * Other CO/OA/PI adjustments stay open on the claim as Denials with an appeal deadline and a work item (INV-FIN-05).
 * Unmatched claims and unposted provider-level adjustments (PLB) leave the remittance unbalanced in the exception
 * queue until a biller matches/posts them and finishes it.
 */

/** Adjustments posted as contractual write-downs rather than worked as denials. */
const CONTRACTUAL_CARCS = new Set(["45", "253"]);
const POSTABLE: Claim["status"][] = ["SUBMITTED", "ACCEPTED", "APPEALED"];

const cents = (v: { toString(): string } | null | undefined) => (v == null ? 0 : toCentsDec(v));

async function contractAllowedCents(tx: Tx, claim: Claim): Promise<number | null> {
  const lines = await tx.claimLine.findMany({ where: { claimId: claim.id } });
  const items = await tx.feeScheduleItem.findMany({
    where: {
      code: { in: lines.map((l) => l.code) },
      modifier: null,
      feeSchedule: { payerId: claim.payerId, isContract: true },
    },
  });
  let total = 0;
  for (const l of lines) {
    const item = items.find((i) => i.code === l.code);
    if (!item) return null;
    total += Math.round(toCentsDec(item.amount) * Number(l.units));
  }
  return total;
}

interface DenialDraft {
  carc: string;
  rarc: string[];
  cents: number;
  rootCause: string;
}

/** Posts one matched claim payment. Returns false when the claim's state does not allow posting. */
export async function postClaimPayment(
  tx: Tx,
  remit: Remittance,
  rcp: RemittanceClaimPayment & { adjustments: RemittanceAdjustment[] },
  actorId: string | null,
): Promise<boolean> {
  if (rcp.posted || !rcp.claimId) return rcp.posted;
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: rcp.claimId } });
  if (!POSTABLE.includes(claim.status)) return false;
  // An 835 means the payer adjudicated the claim, so a missing 277CA acceptance is implied.
  if (claim.status === "SUBMITTED") await moveClaim(tx, claim, "accepted", "system");
  const base = {
    practiceId: claim.practiceId,
    patientId: claim.patientId,
    encounterId: claim.encounterId,
    claimId: claim.id,
    remittanceId: remit.id,
    postedById: actorId,
  };
  const paid = cents(rcp.paid);
  const rows: LedgerLine[] = [
    {
      ...base,
      type: "INSURANCE_PAYMENT",
      responsibility: "INSURANCE",
      cents: -paid,
      memo: `ERA ${remit.eftTraceNumber}`,
    },
  ];
  const denials: DenialDraft[] = [];
  let pr = 0;
  let co45 = 0;
  for (const a of rcp.adjustments) {
    const amt = cents(a.amount);
    if (a.group === "PR") {
      pr += amt;
      rows.push(...transferToPatient({ ...base, carc: a.carc, memo: `PR-${a.carc}` }, amt));
    } else if (CONTRACTUAL_CARCS.has(a.carc)) {
      if (a.carc === "45") co45 += amt;
      else
        rows.push({
          ...base,
          type: "CONTRACTUAL_ADJUSTMENT",
          responsibility: "INSURANCE",
          cents: -amt,
          carc: a.carc,
          memo: `${a.group}-${a.carc}`,
        });
    } else {
      denials.push({ carc: a.carc, rarc: a.rarc, cents: amt, rootCause: rootCauseOf(a.carc) });
    }
  }
  // Underpayment vs the contracted rate: CO-45 is posted only down to the contracted allowed amount; the rest stays
  // open and is worked as an "underpaid" denial (billing.era-posting rml-underpaid).
  let underpaid = 0;
  const contract = rcp.claimStatusCode === "4" ? null : await contractAllowedCents(tx, claim);
  if (contract !== null) {
    const allowed = rcp.allowed != null ? cents(rcp.allowed) : paid + pr;
    if (allowed < contract) underpaid = Math.min(contract - allowed, co45);
  }
  if (co45 - underpaid > 0)
    rows.push({
      ...base,
      type: "CONTRACTUAL_ADJUSTMENT",
      responsibility: "INSURANCE",
      cents: -(co45 - underpaid),
      carc: "45",
      memo: "CO-45",
    });
  if (underpaid > 0)
    denials.push({ carc: "45", rarc: [], cents: underpaid, rootCause: "underpaid" });
  await postLedger(tx, rows);

  const balance = await claimInsuranceBalanceCents(tx, claim.id);
  if (balance > 0 && !denials.length)
    denials.push({ carc: "16", rarc: [], cents: balance, rootCause: "unexplained" });
  await tx.claim.update({
    where: { id: claim.id },
    data: {
      totalPaid: centsToMoney(cents(claim.totalPaid) + paid),
      patientResponsibility: centsToMoney(cents(claim.patientResponsibility) + pr),
      payerClaimControlNumber: rcp.payerClaimControlNumber ?? claim.payerClaimControlNumber,
    },
  });
  const from = claim.status;
  const to =
    balance <= 0
      ? "paid"
      : paid === 0 || rcp.claimStatusCode === "4" || from === "APPEALED"
        ? "denied"
        : "partially-paid";
  await moveClaim(tx, claim, to, "system");
  await tx.remittanceClaimPayment.update({
    where: { id: rcp.id },
    data: { posted: true, underpaidBy: underpaid ? centsToMoney(underpaid) : null },
  });
  const payer = await tx.payer.findUniqueOrThrow({ where: { id: claim.payerId } });
  const deadline = new Date(remit.paymentDate.getTime() + payer.appealDays * 86_400_000);
  for (const d of denials) {
    const row = await tx.denial.create({
      data: {
        practiceId: claim.practiceId,
        claimId: claim.id,
        carc: d.carc,
        rarc: d.rarc,
        rootCause: d.rootCause,
        amount: centsToMoney(d.cents),
        appealDeadline: deadline,
      },
    });
    // INV-FIN-05: every denial is a work item due by the appeal deadline.
    const task = await createTask(tx, claim.practiceId, {
      type: "DENIAL",
      title: `Claim ${claim.claimNumber}: ${d.rootCause === "underpaid" ? "underpaid" : `denied (CARC ${d.carc})`}`,
      description: `${centsToMoney(d.cents)} open with ${payer.name}. Appeal by ${deadline.toISOString().slice(0, 10)}.`,
      patientId: claim.patientId,
      focusType: "Denial",
      focusId: row.id,
      poolKind: "billing",
      priority: "HIGH",
      dueAt: deadline,
    });
    await tx.denial.update({ where: { id: row.id }, data: { taskId: task.id } });
  }
  await claimEvent(
    tx,
    claim,
    "REMIT_835",
    `ERA ${remit.eftTraceNumber}: paid ${centsToMoney(paid)}, patient ${centsToMoney(pr)}${denials.length ? `, ${denials.length} denial(s)` : ""}`,
    { statusCode: rcp.claimStatusCode },
  );
  return true;
}

export async function remitBalance(tx: Tx, remittanceId: string) {
  const r = await tx.remittance.findUniqueOrThrow({
    where: { id: remittanceId },
    include: { claimPayments: true, providerAdjustments: true },
  });
  const posted =
    r.claimPayments.filter((p) => p.posted).reduce((s, p) => s + cents(p.paid), 0) -
    r.providerAdjustments.filter((p) => p.postedToClaimId).reduce((s, p) => s + cents(p.amount), 0);
  const unmatched = r.claimPayments.filter((p) => !p.claimId).length;
  const unposted = r.claimPayments.filter((p) => !p.posted).length;
  const difference = cents(r.paymentAmount) - posted;
  return {
    remit: r,
    posted,
    difference,
    unmatched,
    unposted,
    balanced: difference === 0 && unmatched === 0 && unposted === 0,
  };
}

async function refreshStatus(tx: Tx, remittanceId: string) {
  const b = await remitBalance(tx, remittanceId);
  if (b.remit.status === "POSTED") return b;
  await tx.remittance.update({
    where: { id: remittanceId },
    data: {
      status: b.balanced ? "POSTED" : "EXCEPTION",
      ...(b.balanced ? { postedAt: new Date() } : {}),
    },
  });
  return b;
}

/** Stores and auto-posts one parsed 835 payment. Returns null for a duplicate (same payer + trace number). */
export async function ingestRemittance(
  tx: Tx,
  practiceId: string,
  parsed: ParsedRemittance,
  rawFileId: string | null,
): Promise<Remittance | null> {
  const payer =
    (parsed.payerId
      ? await tx.payer.findFirst({ where: { clearinghousePayerId: parsed.payerId } })
      : null) ??
    (parsed.payerName ? await tx.payer.findFirst({ where: { name: parsed.payerName } }) : null);
  if (!payer) {
    await createTask(tx, practiceId, {
      type: "INTERFACE_FAILURE",
      title: `ERA ${parsed.traceNumber} is from a payer that isn't set up`,
      description: `Remittance of ${parsed.paymentAmount} from ${parsed.payerName ?? "an unknown payer"} could not be posted. Add the payer, then ask the clearinghouse to resend.`,
      poolKind: "billing",
      priority: "HIGH",
    });
    return null;
  }
  const dup = await tx.remittance.findFirst({
    where: { payerId: payer.id, eftTraceNumber: parsed.traceNumber },
  });
  if (dup) return null;
  const remit = await tx.remittance.create({
    data: {
      practiceId,
      payerId: payer.id,
      eftTraceNumber: parsed.traceNumber,
      paymentMethod: parsed.paymentMethod,
      paymentAmount: parsed.paymentAmount,
      paymentDate: new Date(parsed.paymentDate ?? new Date().toISOString().slice(0, 10)),
      rawFileId,
      status: "POSTING",
    },
  });
  for (const c of parsed.claims) {
    const claim = await findByPcn(tx, c.patientControlNumber);
    const ok = claim && claim.payerId === payer.id ? claim : null;
    await tx.remittanceClaimPayment.create({
      data: {
        practiceId,
        remittanceId: remit.id,
        claimId: ok?.id ?? null,
        payerClaimControlNumber: c.payerClaimControlNumber,
        patientControlNumber: c.patientControlNumber,
        billed: c.billedAmount ?? "0.00",
        allowed: c.allowedAmount,
        paid: c.paidAmount ?? "0.00",
        patientResponsibility: c.patientResponsibilityAmount ?? "0.00",
        claimStatusCode: c.claimStatusCode,
        adjustments: {
          create: c.adjustments.map((a) => ({
            practiceId,
            group: (["CO", "PR", "OA", "PI", "CR"].includes(a.groupCode)
              ? a.groupCode
              : "OA") as RemittanceAdjustment["group"],
            carc: a.reasonCode,
            rarc: [],
            amount: a.amount,
          })),
        },
      },
    });
  }
  for (const p of parsed.providerAdjustments)
    await tx.providerLevelAdjustment.create({
      data: {
        practiceId,
        remittanceId: remit.id,
        reasonCode: p.reasonCode,
        reference: p.reference,
        amount: p.amount,
      },
    });
  const rcps = await tx.remittanceClaimPayment.findMany({
    where: { remittanceId: remit.id, claimId: { not: null } },
    include: { adjustments: true },
  });
  for (const rcp of rcps) await postClaimPayment(tx, remit, rcp, null);
  const b = await refreshStatus(tx, remit.id);
  if (!b.balanced)
    await createTask(tx, practiceId, {
      type: "GENERAL",
      title: `ERA ${remit.eftTraceNumber} from ${payer.name} needs review`,
      description: `${b.unmatched} unmatched claim(s); ${centsToMoney(b.difference)} not yet posted.`,
      focusType: "Remittance",
      focusId: remit.id,
      poolKind: "billing",
      priority: "NORMAL",
    });
  return remit;
}

// ------------------------------------------------------------------ views

async function remitSummaries(tx: Tx, rows: Array<Remittance & { payer: { name: string } }>) {
  const counts = await tx.remittanceClaimPayment.findMany({
    where: { remittanceId: { in: rows.map((r) => r.id) } },
    select: { remittanceId: true, claimId: true, posted: true },
  });
  return rows.map((r) => {
    const mine = counts.filter((c) => c.remittanceId === r.id);
    return {
      id: r.id,
      payerName: r.payer.name,
      checkNumber: r.eftTraceNumber,
      paidAt: r.paymentDate.toISOString().slice(0, 10),
      amount: r.paymentAmount.toFixed(2),
      status: r.status,
      claims: mine.length,
      exceptions: mine.filter((c) => !c.claimId || !c.posted).length,
    };
  });
}

export async function remitDetail(tx: Tx, id: string) {
  const r = await tx.remittance.findUnique({
    where: { id },
    include: {
      claimPayments: { include: { adjustments: true }, orderBy: { patientControlNumber: "asc" } },
      providerAdjustments: true,
    },
  });
  if (!r) throw notFound();
  const claims = await tx.claim.findMany({
    where: { id: { in: r.claimPayments.map((p) => p.claimId).filter((x): x is string => !!x) } },
  });
  const sums = new Map((await claimSummaries(tx, claims)).map((s) => [s.id, s]));
  const { claimPayments, providerAdjustments, ...row } = r;
  return {
    ...toDto("Remittance", row),
    claimPayments: claimPayments.map(({ adjustments, ...p }) => ({
      payment: toDto("RemittanceClaimPayment", p),
      ...(p.claimId && sums.get(p.claimId) ? { claim: sums.get(p.claimId)! } : {}),
      adjustments: adjustments.map((a) => toDto("RemittanceAdjustment", a)),
    })),
    providerLevelAdjustments: providerAdjustments.map((p) => toDto("ProviderLevelAdjustment", p)),
  };
}

// ------------------------------------------------------------------ handlers

export const remittanceHandlers: HandlerMap = {
  async listRemittances(ctx) {
    const q = ctx.query;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const rows = await ctx.db.remittance.findMany({
      where: {
        ...(q.status
          ? { status: { in: ([] as string[]).concat(q.status) as Remittance["status"][] } }
          : {}),
        ...(q.payerId ? { payerId: q.payerId } : {}),
        ...(q.fromDate || q.toDate
          ? {
              paymentDate: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(q.toDate) } : {}),
              },
            }
          : {}),
      },
      include: { payer: true },
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const slice = rows.slice(0, limit);
    return {
      data: await remitSummaries(ctx.db, slice),
      nextCursor: rows.length > limit ? slice[slice.length - 1]!.id : null,
      hasMore: rows.length > limit,
    };
  },

  async getRemittance(ctx) {
    ctx.audit.resource("Remittance", ctx.params.remittanceId);
    return remitDetail(ctx.db, ctx.params.remittanceId);
  },

  async getRemittanceX12(ctx) {
    const r = await ctx.db.remittance.findUnique({
      where: { id: ctx.params.remittanceId },
      include: { payer: true },
    });
    if (!r) throw notFound();
    ctx.audit.resource("Remittance", r.id);
    const file = r.rawFileId
      ? await ctx.db.fileObject.findUnique({ where: { id: r.rawFileId } })
      : null;
    if (!file) throw notFound("The original 835 is not stored for this remittance.");
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: r.practiceId } });
    const text = JSON.stringify(
      JSON.parse((await readFileContent(file)).toString("utf8")),
      null,
      2,
    );
    const pdf = await renderPdf(
      {
        title: `835 ${r.payer.name} ${r.eftTraceNumber}`,
        patientLine: `Remittance · ${r.payer.name} · EFT ${r.eftTraceNumber}`,
        practiceName: practice.legalName,
      },
      (w) => {
        for (const line of text.split("\n")) w.paragraph(line);
      },
    );
    return binary("application/pdf", pdf, `835-${r.eftTraceNumber}.pdf`, true);
  },

  async matchRemittanceClaimPayment(ctx) {
    const rcp = await ctx.db.remittanceClaimPayment.findUnique({
      where: { id: ctx.params.remittanceClaimPaymentId },
      include: { adjustments: true, remittance: true },
    });
    if (!rcp) throw notFound();
    if (rcp.claimId) throw conflict("already_matched", "This line is already matched to a claim.");
    const claim = await ctx.db.claim.findUnique({ where: { id: ctx.body.claimId } });
    if (!claim) throw notFound("Claim not found.");
    if (claim.payerId !== rcp.remittance.payerId)
      throw unprocessable("payer_mismatch", "That claim is with a different payer.");
    if (!POSTABLE.includes(claim.status))
      throw unprocessable(
        "claim_not_open",
        `Claim ${claim.claimNumber} is ${claim.status.toLowerCase()} and can't take this payment.`,
      );
    await ctx.db.remittanceClaimPayment.update({
      where: { id: rcp.id },
      data: { claimId: claim.id },
    });
    await postClaimPayment(
      ctx.db,
      rcp.remittance,
      { ...rcp, claimId: claim.id },
      ctx.staff().userId,
    );
    await refreshStatus(ctx.db, rcp.remittanceId);
    ctx.audit.resource("RemittanceClaimPayment", rcp.id);
    ctx.audit.patient(claim.patientId);
    return remitDetail(ctx.db, rcp.remittanceId);
  },

  async postProviderAdjustment(ctx) {
    const plb = await ctx.db.providerLevelAdjustment.findUnique({
      where: { id: ctx.params.providerLevelAdjustmentId },
      include: { remittance: true },
    });
    if (!plb) throw notFound();
    if (plb.postedToClaimId) throw conflict("already_posted", "This adjustment is already posted.");
    const claim = await ctx.db.claim.findUnique({ where: { id: ctx.body.claimId } });
    if (!claim) throw notFound("Claim not found.");
    if (claim.payerId !== plb.remittance.payerId)
      throw unprocessable("payer_mismatch", "That claim is with a different payer.");
    // A recoupment takes back an earlier payment: the claim's insurance balance goes back up (new row, INV-FIN-01).
    await postLedger(ctx.db, [
      {
        practiceId: claim.practiceId,
        patientId: claim.patientId,
        encounterId: claim.encounterId,
        claimId: claim.id,
        remittanceId: plb.remittanceId,
        type: "RECOUPMENT",
        responsibility: "INSURANCE",
        cents: cents(plb.amount),
        memo: `PLB ${plb.reasonCode} ${plb.reference ?? ""}`.trim(),
        postedById: ctx.staff().userId,
      },
    ]);
    await ctx.db.providerLevelAdjustment.update({
      where: { id: plb.id },
      data: { postedToClaimId: claim.id },
    });
    await claimEvent(
      ctx.db,
      claim,
      "NOTE",
      `Provider-level adjustment ${plb.reasonCode} ${centsToMoney(cents(plb.amount))} posted from ERA ${plb.remittance.eftTraceNumber}`,
    );
    await refreshStatus(ctx.db, plb.remittanceId);
    ctx.audit.patient(claim.patientId);
    return remitDetail(ctx.db, plb.remittanceId);
  },

  async postRemittance(ctx) {
    const r = await ctx.db.remittance.findUnique({ where: { id: ctx.params.remittanceId } });
    if (!r) throw notFound();
    ctx.audit.resource("Remittance", r.id);
    const rcps = await ctx.db.remittanceClaimPayment.findMany({
      where: { remittanceId: r.id, claimId: { not: null }, posted: false },
      include: { adjustments: true },
    });
    for (const rcp of rcps) await postClaimPayment(ctx.db, r, rcp, ctx.staff().userId);
    const b = await remitBalance(ctx.db, r.id);
    if (!b.balanced)
      throw conflict(
        "unbalanced",
        `The remittance is not balanced: ${centsToMoney(b.difference)} difference, ${b.unmatched} unmatched line(s). Match claims and post provider-level adjustments first.`,
      );
    await ctx.db.remittance.update({
      where: { id: r.id },
      data: { status: "POSTED", postedAt: new Date(), postedById: ctx.staff().userId },
    });
    await ctx.db.task.updateMany({
      where: { focusType: "Remittance", focusId: r.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { status: "COMPLETED", completedAt: new Date(), completedById: ctx.staff().userId },
    });
    return remitDetail(ctx.db, r.id);
  },
};

export type { Prisma };
