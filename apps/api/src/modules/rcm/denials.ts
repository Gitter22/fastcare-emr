import type { Denial, Tx } from "../../db.js";
import { putFile } from "../../gateways/fileStore.js";
import { toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import {
  centsToMoney,
  claimInsuranceBalanceCents,
  postLedger,
  toCentsDec,
} from "../../platform/ledger.js";
import { renderPdf } from "../../platform/pdf.js";
import { requirePatient } from "../../platform/patientAccess.js";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
  validationFailed,
} from "../../platform/problem.js";
import { settingValue } from "../../platform/settings.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { completeTasksFor } from "../../platform/tasks.js";
import { claimDetail, claimEvent, claimSummaries, moveClaim } from "./claims.js";

/**
 * Denials and appeals (flow:rcm/07). Denials are grouped by CARC root cause; each carries an appeal deadline shown
 * on every row (INV-FIN-05). Appeal letters are built from claim facts only — never note text, which billing roles
 * cannot read (INV-SEC-05); the visit note goes with an appeal only after a provider releases it.
 */

const ROOT: Record<string, string> = {
  "197": "no-auth",
  "50": "medical-necessity",
  "22": "cob",
  "23": "cob",
  "29": "timely-filing",
  "4": "coding",
  "11": "coding",
  "16": "coding",
  "18": "duplicate",
  "27": "eligibility",
  "31": "eligibility",
  "109": "eligibility",
  "96": "non-covered",
  "204": "non-covered",
  "97": "bundling",
  "151": "bundling",
};
export const rootCauseOf = (carc: string) => ROOT[carc] ?? "other";

export const ROOT_LABEL: Record<string, string> = {
  "no-auth": "No prior authorization",
  "medical-necessity": "Medical necessity",
  cob: "Coordination of benefits",
  "timely-filing": "Timely filing",
  coding: "Coding / billing error",
  duplicate: "Duplicate claim",
  eligibility: "Eligibility / coverage",
  "non-covered": "Non-covered service",
  bundling: "Bundled / frequency",
  underpaid: "Underpaid vs contract",
  unexplained: "Unexplained balance",
  other: "Other",
};

/** What a biller should usually do next for each root cause (shown, never applied automatically). */
const SUGGESTED: Record<string, "APPEAL" | "CORRECTED_CLAIM" | "WRITE_OFF"> = {
  "no-auth": "APPEAL",
  "medical-necessity": "APPEAL",
  underpaid: "APPEAL",
  coding: "CORRECTED_CLAIM",
  bundling: "CORRECTED_CLAIM",
  cob: "CORRECTED_CLAIM",
  eligibility: "CORRECTED_CLAIM",
  duplicate: "WRITE_OFF",
  "timely-filing": "WRITE_OFF",
};

const isOpen = (d: Pick<Denial, "status" | "snoozedUntil">, now = new Date()) =>
  d.status === "OPEN" && (!d.snoozedUntil || d.snoozedUntil <= now);

async function loadDenial(ctx: Ctx, id: string) {
  const d = await ctx.db.denial.findUnique({ where: { id }, include: { claim: true } });
  if (!d) throw notFound();
  await requirePatient(ctx, d.claim.patientId, { identityOnly: true });
  ctx.audit.resource("Denial", d.id);
  return d;
}

async function denialDetail(tx: Tx, id: string) {
  const d = await tx.denial.findUniqueOrThrow({
    where: { id },
    include: { appeals: { orderBy: { submittedAt: "asc" } } },
  });
  const adjustments = await tx.remittanceAdjustment.findMany({
    where: { claimPayment: { claimId: d.claimId } },
  });
  const { appeals, ...row } = d;
  return {
    ...toDto("Denial", row),
    claim: await claimDetail(tx, d.claimId),
    adjustments: adjustments.map((a) => toDto("RemittanceAdjustment", a)),
    appeals: appeals.map((a) => toDto("Appeal", a)),
    ...(SUGGESTED[d.rootCause] ? { suggestedAction: SUGGESTED[d.rootCause]! } : {}),
  };
}

async function carcText(tx: Tx, carc: string) {
  const c = await tx.codeConcept.findFirst({ where: { system: "CARC", code: carc, active: true } });
  return c?.display ?? `Adjustment reason ${carc}`;
}

export const denialHandlers: HandlerMap = {
  async getDenialGroups(ctx) {
    const rows = await ctx.db.denial.findMany({ where: { status: "OPEN" } });
    const now = new Date();
    const groups = new Map<string, { count: number; cents: number }>();
    for (const d of rows.filter((x) => isOpen(x, now))) {
      const g = groups.get(d.rootCause) ?? { count: 0, cents: 0 };
      g.count += 1;
      g.cents += toCentsDec(d.amount);
      groups.set(d.rootCause, g);
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].cents - a[1].cents)
      .map(([key, g]) => ({
        key,
        label: ROOT_LABEL[key] ?? key,
        count: g.count,
        amount: centsToMoney(g.cents),
      }));
  },

  async listDenials(ctx) {
    const q = ctx.query;
    const now = new Date();
    const status = (q.status ?? "OPEN") as Denial["status"];
    let rows = await ctx.db.denial.findMany({
      where: {
        status,
        ...(q.rootCause ? { rootCause: q.rootCause } : {}),
        ...(q.payerId ? { claim: { payerId: q.payerId } } : {}),
      },
      include: { claim: true },
    });
    if (status === "OPEN") rows = rows.filter((d) => isOpen(d, now));
    const sort = q.sort ?? "deadline";
    rows.sort((a, b) =>
      sort === "amount"
        ? toCentsDec(b.amount) - toCentsDec(a.amount)
        : sort === "age"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.appealDeadline.getTime() - b.appealDeadline.getTime(),
    );
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const start = q.cursor ? rows.findIndex((r) => r.id === q.cursor) + 1 : 0;
    const slice = rows.slice(start, start + limit);
    const sums = new Map(
      (
        await claimSummaries(
          ctx.db,
          slice.map((d) => d.claim),
        )
      ).map((s) => [s.id, s]),
    );
    return {
      data: slice.map(({ claim, ...d }) => ({
        denial: toDto("Denial", d),
        claim: sums.get(claim.id)!,
        carc: d.carc,
        rarc: d.rarc,
        amount: d.amount.toFixed(2),
        appealDeadline: d.appealDeadline.toISOString().slice(0, 10),
      })),
      nextCursor: start + limit < rows.length ? slice[slice.length - 1]!.id : null,
      hasMore: start + limit < rows.length,
    };
  },

  async getDenial(ctx) {
    const d = await loadDenial(ctx, ctx.params.denialId);
    return denialDetail(ctx.db, d.id);
  },

  async draftAppealLetter(ctx) {
    const d = await loadDenial(ctx, ctx.params.denialId);
    const c = d.claim;
    const [payer, practice, lines, patient] = await Promise.all([
      ctx.db.payer.findUniqueOrThrow({ where: { id: c.payerId } }),
      ctx.db.practice.findUniqueOrThrow({ where: { id: c.practiceId } }),
      ctx.db.claimLine.findMany({ where: { claimId: c.id }, orderBy: { lineNumber: "asc" } }),
      ctx.db.patient.findUniqueOrThrow({ where: { id: c.patientId } }),
    ]);
    const reason = await carcText(ctx.db, d.carc);
    const level = ctx.body.level ?? 1;
    const points = ctx.body.points ?? [];
    const dos = c.serviceDateFrom.toISOString().slice(0, 10);
    // Built from claim facts only (INV-SEC-05): no clinical note text.
    const text = [
      `To: ${payer.name} — Appeals (level ${level})`,
      `Re: Claim ${c.payerClaimControlNumber ?? c.claimNumber} · Patient ${patient.lastName}, ${patient.firstName} · DOB ${patient.birthDate.toISOString().slice(0, 10)} · DOS ${dos}`,
      "",
      `We request reconsideration of the ${d.rootCause === "underpaid" ? "payment" : "denial"} of ${centsToMoney(toCentsDec(d.amount))} for the services below (CARC ${d.carc}: ${reason}).`,
      "",
      ...lines.map(
        (l) =>
          `• ${l.code}${l.modifiers.length ? `-${l.modifiers.join("-")}` : ""} × ${l.units.toString()} — diagnoses ${l.icd10Codes.join(", ")} — ${l.charge.toFixed(2)}`,
      ),
      "",
      ...(d.rootCause === "underpaid"
        ? [
            "The payment is below the rate in our participation agreement for these services. Please reprocess at the contracted rate.",
          ]
        : d.rootCause === "no-auth"
          ? ["Please review the enclosed authorization information and reprocess the claim."]
          : ["Please review the enclosed documentation and reprocess the claim."]),
      ...points.map((p) => `• ${p}`),
      "",
      `Sincerely,`,
      `${practice.legalName} billing office`,
    ].join("\n");
    return {
      text,
      attachmentsSuggested: [
        "Claim summary",
        "Eligibility response",
        ...(d.rootCause === "medical-necessity" || d.rootCause === "no-auth"
          ? ["Visit note (needs provider release)"]
          : []),
      ],
    };
  },

  async submitAppeal(ctx) {
    const d = await loadDenial(ctx, ctx.params.denialId);
    const me = ctx.staff();
    const b = ctx.body;
    if (d.status !== "OPEN") throw conflict("denial_not_open", "This denial is no longer open.");
    if (!b.letter?.trim())
      throw validationFailed([
        { field: "letter", code: "required", message: "Write the appeal letter." },
      ]);
    const claim = d.claim;
    assertTransition("claim", claim.status, "appealed", me.role);
    // Attachments must be files of this practice; clinical documents need a provider release (INV-SEC-05), which
    // billing roles cannot give, so only non-clinical files are accepted here.
    const files = b.attachmentFileIds.length
      ? await ctx.db.fileObject.findMany({ where: { id: { in: b.attachmentFileIds } } })
      : [];
    if (files.length !== b.attachmentFileIds.length)
      throw validationFailed([
        { field: "attachmentFileIds", code: "not_found", message: "An attachment was not found." },
      ]);
    const clinical = await ctx.db.documentReference.count({
      where: { fileId: { in: b.attachmentFileIds }, category: "clinical-note" },
    });
    if (clinical)
      throw forbidden(
        "note_release_required",
        "A visit note can be attached only after the provider releases it.",
      );
    const practice = await ctx.db.practice.findUniqueOrThrow({ where: { id: claim.practiceId } });
    const pdf = await renderPdf(
      {
        title: `Appeal — claim ${claim.claimNumber}`,
        patientLine: `Claim ${claim.claimNumber}`,
        practiceName: practice.legalName,
      },
      (w) => {
        for (const line of b.letter.split("\n")) w.paragraph(line);
      },
    );
    const letter = await putFile(ctx.db, {
      practiceId: claim.practiceId,
      kind: "generated",
      fileName: `appeal-${claim.claimNumber}-L${b.level}.pdf`,
      contentType: "application/pdf",
      data: pdf,
      uploadedById: me.userId,
    });
    await ctx.db.appeal.create({
      data: {
        practiceId: claim.practiceId,
        denialId: d.id,
        level: b.level,
        letterFileId: letter.id,
        attachmentFileIds: b.attachmentFileIds,
        submittedVia: b.submittedVia,
        submittedAt: new Date(),
        submittedById: me.userId,
      },
    });
    await ctx.db.denial.update({
      where: { id: d.id },
      data: { status: "APPEALED", action: "APPEAL" },
    });
    await moveClaim(ctx.db, claim, "appealed", me.role);
    await claimEvent(ctx.db, claim, "NOTE", `Appeal level ${b.level} sent via ${b.submittedVia}`);
    await completeTasksFor(ctx.db, "Denial", d.id, ["DENIAL"], me.userId);
    ctx.audit.patient(claim.patientId);
    ctx.audit.detail({
      level: b.level,
      via: b.submittedVia,
      attachments: b.attachmentFileIds.length,
    });
    return denialDetail(ctx.db, d.id);
  },

  async writeOffDenial(ctx) {
    const d = await loadDenial(ctx, ctx.params.denialId);
    const me = ctx.staff();
    const b = ctx.body;
    if (d.status !== "OPEN") throw conflict("denial_not_open", "This denial is no longer open.");
    const amount = toCentsDec(b.amount);
    if (amount <= 0)
      throw validationFailed([
        { field: "amount", code: "min", message: "Enter an amount above zero." },
      ]);
    const open = await claimInsuranceBalanceCents(ctx.db, d.claimId);
    if (amount > open)
      throw unprocessable("exceeds_balance", `Only ${centsToMoney(open)} is open on this claim.`);
    // Write-offs above the practice threshold need a manager (billing.denials wk-writeoff-approval).
    const threshold = toCentsDec(
      await settingValue(ctx.db, "billing.writeOffApprovalThreshold", "100.00"),
    );
    if (amount > threshold && !me.roles.includes("manager"))
      throw forbidden(
        "write_off_needs_approval",
        `Write-offs over ${centsToMoney(threshold)} need a practice manager.`,
      );
    const claim = d.claim;
    await postLedger(ctx.db, [
      {
        practiceId: claim.practiceId,
        patientId: claim.patientId,
        encounterId: claim.encounterId,
        claimId: claim.id,
        type: "WRITE_OFF",
        responsibility: "INSURANCE",
        cents: -amount,
        carc: b.reasonCode,
        memo: (b.note ?? `Denial write-off (${d.carc})`).slice(0, 200),
        postedById: me.userId,
      },
    ]);
    await ctx.db.denial.update({
      where: { id: d.id },
      data: { status: "WRITTEN_OFF", action: "WRITE_OFF" },
    });
    await claimEvent(ctx.db, claim, "NOTE", `Wrote off ${centsToMoney(amount)} (${b.reasonCode})`);
    await completeTasksFor(ctx.db, "Denial", d.id, ["DENIAL"], me.userId);
    ctx.audit.patient(claim.patientId);
    ctx.audit.detail({ amount: centsToMoney(amount), reasonCode: b.reasonCode });
    return denialDetail(ctx.db, d.id);
  },

  async snoozeDenial(ctx) {
    const d = await loadDenial(ctx, ctx.params.denialId);
    const until = new Date(ctx.body.until);
    if (!(until > new Date()))
      throw validationFailed([
        { field: "until", code: "future", message: "Pick a time in the future." },
      ]);
    if (until > d.appealDeadline)
      throw unprocessable("past_deadline", "A denial can't be snoozed past its appeal deadline.");
    await ctx.db.denial.update({ where: { id: d.id }, data: { snoozedUntil: until } });
    ctx.audit.detail({ until: until.toISOString() });
    return denialDetail(ctx.db, d.id);
  },
};
