import type { ChargeItem, Encounter, Prisma, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { centsToMoney, postLedger, toCentsDec } from "../../platform/ledger.js";
import {
  conflict,
  invariantBlocked,
  notFound,
  unprocessable,
  validationFailed,
} from "../../platform/problem.js";
import { assertTransition } from "../../platform/stateMachine.js";
import { writeVersion } from "../../platform/versioning.js";
import { loadEncounter } from "../encounters/access.js";
import { encounterDetail, registerEncounterSections } from "../encounters/views.js";
import {
  type CodingEdit,
  type LineFacts,
  activeEdits,
  lineEdits,
  mergeDismissals,
  suggestEm,
} from "./coding.js";
import {
  claimEdits,
  loadClaimContext,
  billingNpiOf,
  priorAuthNumber,
  scrubStoredClaim,
} from "./scrubber.js";

/**
 * Charge capture (flow:encounter/06) and release to a claim (flow:rcm/01-02).
 *   - Lines are DRAFT until the note is signed; on signing, clean charges go straight to a claim (claim
 *     new -> draft -> ready) and anything with an open edit is HELD for charge review.
 *   - Edits (coding.ts + scrubber.ts) are stored on ChargeItem.holdReasons; warnings can be dismissed with a reason,
 *     errors cannot. INV-FIN-03 errors always block.
 *   - The CHARGE ledger rows are written when charges are released (to INSURANCE on a claim, to the PATIENT for
 *     self-pay); before that a charge is not owed by anyone. Ledger rows are never updated (INV-FIN-01).
 */

const OPEN_STATUSES = ["DRAFT", "HELD"] as const;

export async function encounterDiagnoses(tx: Tx, encounterId: string) {
  return tx.condition.findMany({
    where: {
      encounterId,
      category: "ENCOUNTER_DIAGNOSIS",
      verificationStatus: { not: "ENTERED_IN_ERROR" },
    },
    orderBy: { rank: "asc" },
  });
}

interface CatalogEntry {
  system: "CPT" | "HCPCS";
  display: string;
  category: string | null;
  mue: number | null;
}

export async function procedureCatalog(
  tx: Tx,
  codes: string[],
): Promise<Map<string, CatalogEntry>> {
  const rows = await tx.codeConcept.findMany({
    where: { system: { in: ["CPT", "HCPCS"] }, code: { in: [...new Set(codes)] }, active: true },
  });
  return new Map(
    rows.map((r) => {
      const a = (r.attributes ?? {}) as { category?: string; mue?: number };
      return [
        r.code,
        {
          system: r.system as "CPT" | "HCPCS",
          display: r.display,
          category: a.category ?? null,
          mue: a.mue ?? null,
        },
      ];
    }),
  );
}

/** Practice fee (the standard schedule: no payer, not a contract). */
export async function standardFee(tx: Tx, code: string): Promise<string | null> {
  const item = await tx.feeScheduleItem.findFirst({
    where: { code, modifier: null, feeSchedule: { payerId: null, isContract: false } },
    orderBy: { feeSchedule: { effectiveFrom: "desc" } },
  });
  return item ? item.amount.toFixed(2) : null;
}

/** ChargeItem.holdReasons is a JSON object {edits: CodingEdit[]} (the generated schema types it as an object). */
export const editsOf = (c: Pick<ChargeItem, "holdReasons">) =>
  ((c.holdReasons as { edits?: CodingEdit[] } | null)?.edits ?? []) as CodingEdit[];
const editsJson = (edits: CodingEdit[]) => ({ edits }) as unknown as Prisma.InputJsonValue;

/** Recomputes and stores every edit for the encounter's open lines; returns the full list. */
export async function recomputeEdits(tx: Tx, enc: Encounter): Promise<CodingEdit[]> {
  const lines = await tx.chargeItem.findMany({
    where: { encounterId: enc.id, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "asc" },
  });
  if (!lines.length) return [];
  const [dx, cat, ctx] = await Promise.all([
    encounterDiagnoses(tx, enc.id),
    procedureCatalog(
      tx,
      lines.map((l) => l.code),
    ),
    loadClaimContext(tx, enc),
  ]);
  const facts: LineFacts[] = lines.map((l) => ({
    id: l.id,
    code: l.code,
    modifiers: l.modifiers,
    units: Number(l.units),
    dxConditionIds: l.dxConditionIds,
    category: cat.get(l.code)?.category ?? null,
    mue: cat.get(l.code)?.mue ?? null,
  }));
  const computed = [
    ...lineEdits(facts, new Set(dx.map((d) => d.id))),
    ...(await claimEdits(
      tx,
      ctx,
      lines.map((l) => l.code),
      lines[0]!.serviceDate,
    )),
  ];
  const all = mergeDismissals(computed, lines.flatMap(editsOf));
  const first = lines[0]!.id;
  for (const l of lines) {
    const mine = all.filter((e) => (e.lineId ?? first) === l.id);
    await tx.chargeItem.update({
      where: { id: l.id },
      data: { holdReasons: editsJson(mine) },
    });
  }
  return all;
}

async function isNewPatient(tx: Tx, enc: Encounter): Promise<boolean> {
  const since = new Date((enc.periodStart ?? enc.createdAt).getTime() - 3 * 365 * 86_400_000);
  const prior = await tx.encounter.findFirst({
    where: {
      patientId: enc.patientId,
      id: { not: enc.id },
      status: "FINISHED",
      periodStart: { gte: since, lt: enc.periodStart ?? enc.createdAt },
    },
  });
  return !prior;
}

export async function encounterChargesView(tx: Tx, enc: Encounter) {
  const [dx, lines] = await Promise.all([
    encounterDiagnoses(tx, enc.id),
    tx.chargeItem.findMany({
      where: { encounterId: enc.id, status: { not: "VOID" } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const open = lines.filter((l) => l.status === "DRAFT" || l.status === "HELD");
  const holds = activeEdits(open.flatMap(editsOf)).map((e) => ({ code: e.key, text: e.text }));
  const em =
    enc.emMethod === "mdm" || enc.emMethod === "time"
      ? suggestEm({
          basis: enc.emMethod,
          totalMinutes: enc.emTotalMinutes,
          problems: enc.mdmProblems as never,
          data: enc.mdmData as never,
          risk: enc.mdmRisk as never,
          // The level the coder last computed decides new vs established (99202-99205 are new-patient codes).
          newPatient: enc.emSuggestedCode
            ? enc.emSuggestedCode.startsWith("9920")
            : await isNewPatient(tx, enc),
        })
      : null;
  return {
    encounterId: enc.id,
    diagnoses: dx.map((d) => toDto("Condition", d)),
    lines: lines.map((l) => toDto("ChargeItem", l)),
    ...(em ? { emSuggestion: em } : {}),
    holds,
    readyForClaim: !enc.noChargeVisit && open.length > 0 && holds.length === 0,
  };
}

registerEncounterSections(async (tx, encounterId) => ({
  charges: (
    await tx.chargeItem.findMany({
      where: { encounterId, status: { not: "VOID" } },
      orderBy: { createdAt: "asc" },
    })
  ).map((c) => toDto("ChargeItem", c)),
}));

async function noteIsSigned(tx: Tx, encounterId: string) {
  const note = await tx.clinicalNote.findFirst({ where: { encounterId } });
  return !!note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(note.status);
}

async function assertEditable(tx: Tx, enc: Encounter) {
  if (enc.noChargeVisit)
    throw conflict("no_charge_visit", "This visit is marked no-charge. Charges can't be added.");
  const released = await tx.chargeItem.count({
    where: { encounterId: enc.id, status: { in: ["READY", "BILLED"] } },
  });
  if (released)
    throw conflict(
      "charges_released",
      "Charges for this visit are already on a claim. Correct the claim from billing instead.",
    );
}

async function validatePointers(tx: Tx, encounterId: string, ids: string[]) {
  // INV-FIN-03: every line points to at least one diagnosis on this visit.
  if (!ids.length)
    throw validationFailed([
      {
        field: "dxConditionIds",
        code: "required",
        message: "Point the charge to at least one diagnosis.",
      },
    ]);
  const dx = new Set((await encounterDiagnoses(tx, encounterId)).map((d) => d.id));
  if (ids.some((id) => !dx.has(id)))
    throw validationFailed([
      {
        field: "dxConditionIds",
        code: "not_on_visit",
        message: "Pointers must be diagnoses on this visit.",
      },
    ]);
}

async function loadCharge(ctx: Ctx, id: string) {
  const c = await ctx.db.chargeItem.findUnique({ where: { id } });
  if (!c || !c.encounterId) throw notFound();
  const enc = await loadEncounter(ctx, c.encounterId);
  ctx.audit.resource("ChargeItem", c.id);
  return { charge: c, enc };
}

// ------------------------------------------------------------------ release

export interface ReleaseResult {
  released: number;
  claimId: string | null;
  edits: CodingEdit[];
}

/**
 * Moves an encounter's open charges to a claim (or to the patient for self-pay). Blocking edits stop the release:
 * `onBlocked: "hold"` marks the lines HELD (note signing), `"throw"` answers 422 with the blockers (charge review).
 */
export async function releaseEncounter(
  tx: Tx,
  enc: Encounter,
  actor: { userId: string | null; role: string },
  onBlocked: "hold" | "throw",
): Promise<ReleaseResult> {
  if (enc.noChargeVisit) return { released: 0, claimId: null, edits: [] };
  const edits = await recomputeEdits(tx, enc);
  const lines = await tx.chargeItem.findMany({
    where: { encounterId: enc.id, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "asc" },
  });
  if (!lines.length) return { released: 0, claimId: null, edits };
  const open = activeEdits(edits);
  const manualHold = lines.find((l) => l.status === "HELD" && l.holdNote && onBlocked === "hold");
  if (open.length || manualHold) {
    if (onBlocked === "throw")
      throw invariantBlocked(
        open.map((e) => ({
          code: e.key,
          text: e.text,
          ...(e.invariant ? { invariant: e.invariant } : {}),
        })),
        `Fix ${open.length} item${open.length === 1 ? "" : "s"} before releasing to a claim.`,
      );
    await tx.chargeItem.updateMany({
      where: { id: { in: lines.map((l) => l.id) }, status: "DRAFT" },
      data: { status: "HELD" },
    });
    return { released: 0, claimId: null, edits };
  }
  const ctx = await loadClaimContext(tx, enc);
  const base = {
    practiceId: enc.practiceId,
    patientId: enc.patientId,
    encounterId: enc.id,
    postedById: actor.userId,
  };
  const lineCents = (l: ChargeItem) => Math.round(toCentsDec(l.fee) * Number(l.units));
  if (!ctx.coverage) {
    // Self-pay: the patient owes the charges directly; no claim.
    await tx.chargeItem.updateMany({
      where: { id: { in: lines.map((l) => l.id) } },
      data: { status: "BILLED", holdNote: null },
    });
    await postLedger(
      tx,
      lines.map((l) => ({
        ...base,
        chargeItemId: l.id,
        type: "CHARGE" as const,
        responsibility: "PATIENT" as const,
        cents: lineCents(l),
        memo: `${l.code} self-pay`,
      })),
    );
    return { released: lines.length, claimId: null, edits: [] };
  }

  // Claim diagnosis list: encounter diagnoses (rank order) that a line points to; letters A–L.
  const dx = await encounterDiagnoses(tx, enc.id);
  const used = dx.filter((d) => lines.some((l) => l.dxConditionIds.includes(d.id))).slice(0, 12);
  const letter = new Map(used.map((d, i) => [d.id, String.fromCharCode(65 + i)]));
  const icd = new Map(used.map((d) => [d.id, d.icd10Code ?? ""]));

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`claim-number:${enc.practiceId}`}))`;
  const yy = String(new Date().getUTCFullYear()).slice(2);
  const last = await tx.claim.findFirst({
    where: { claimNumber: { startsWith: `CLM-${yy}-` } },
    orderBy: { claimNumber: "desc" },
  });
  const claimNumber = `CLM-${yy}-${String((last ? Number(last.claimNumber.slice(7)) : 0) + 1).padStart(5, "0")}`;
  const serviceDate = lines[0]!.serviceDate;
  const totalCents = lines.reduce((s, l) => s + lineCents(l), 0);
  assertTransition("claim", null, "draft", "system");
  const claim = await tx.claim.create({
    data: {
      practiceId: enc.practiceId,
      claimNumber,
      patientId: enc.patientId,
      payerId: ctx.coverage.payerId,
      coverageId: ctx.coverage.id,
      encounterId: enc.id,
      status: "DRAFT",
      billingProviderNpi: billingNpiOf(ctx) ?? "",
      billingTin: ctx.practice.tin.replace(/\D/g, ""),
      renderingProviderNpi: ctx.rendering.npi ?? "",
      placeOfService: ctx.pos ?? "",
      serviceDateFrom: serviceDate,
      serviceDateTo: serviceDate,
      totalBilled: centsToMoney(totalCents),
      priorAuthNumber: await priorAuthNumber(tx, enc.patientId, ctx.coverage.id, serviceDate),
      filingDeadline: new Date(
        serviceDate.getTime() + ctx.coverage.payer.timelyFilingDays * 86_400_000,
      ),
    },
  });
  let n = 0;
  for (const l of lines) {
    n += 1;
    const ptrs = l.dxConditionIds.filter((id) => letter.has(id)).slice(0, 4);
    const cl = await tx.claimLine.create({
      data: {
        practiceId: enc.practiceId,
        claimId: claim.id,
        lineNumber: n,
        chargeItemId: l.id,
        code: l.code,
        modifiers: l.modifiers,
        units: l.units,
        charge: centsToMoney(lineCents(l)),
        dxPointers: ptrs.map((id) => letter.get(id)!),
        icd10Codes: ptrs.map((id) => icd.get(id)!),
      },
    });
    await tx.chargeItem.update({
      where: { id: l.id },
      data: { status: "READY", claimLineId: cl.id, holdNote: null },
    });
  }
  await tx.claimEvent.create({
    data: {
      practiceId: enc.practiceId,
      claimId: claim.id,
      type: "CREATED",
      description: `${lines.length} line(s) released`,
    },
  });
  // draft -> ready only when the scrubber passes on the stored claim (INV-FIN-03).
  const stored = await tx.claim.findUniqueOrThrow({
    where: { id: claim.id },
    include: { lines: true },
  });
  const scrub = scrubStoredClaim(stored);
  if (scrub.length)
    throw invariantBlocked(
      scrub.map((e) => ({ code: e.key, text: e.text, invariant: e.invariant })),
      "The claim did not pass the scrubber.",
    );
  assertTransition("claim", "DRAFT", "ready", "system");
  await tx.claim.update({
    where: { id: claim.id },
    data: { status: "READY", version: { increment: 1 } },
  });
  await postLedger(
    tx,
    lines.map((l) => ({
      ...base,
      claimId: claim.id,
      chargeItemId: l.id,
      type: "CHARGE" as const,
      responsibility: "INSURANCE" as const,
      cents: lineCents(l),
      memo: `${l.code}${l.modifiers.length ? `-${l.modifiers.join("-")}` : ""}`,
    })),
  );
  return { released: lines.length, claimId: claim.id, edits: [] };
}

/** flow:rcm/01 — on note sign, clean charges go to a claim; anything else waits in charge review. */
export async function releaseOnSign(tx: Tx, encounterId: string, userId: string): Promise<number> {
  const enc = await tx.encounter.findUniqueOrThrow({ where: { id: encounterId } });
  // Billing must never block a clinical signature: a release failure rolls back to the savepoint and the charges
  // wait in charge review instead.
  await tx.$executeRaw`SAVEPOINT rcm_release`;
  try {
    const r = await releaseEncounter(tx, enc, { userId, role: "system" }, "hold");
    await tx.$executeRaw`RELEASE SAVEPOINT rcm_release`;
    return r.released;
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT rcm_release`;
    await tx.chargeItem.updateMany({
      where: { encounterId, status: "DRAFT" },
      data: { status: "HELD", holdNote: "Release failed at signing; review and release" },
    });
    return 0;
  }
}

// ------------------------------------------------------------------ handlers

export const chargeHandlers: HandlerMap = {
  async getEncounterCharges(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    return encounterChargesView(ctx.db, enc);
  },

  async addChargeItem(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEditable(ctx.db, enc);
    const b = ctx.body;
    const cat = await procedureCatalog(ctx.db, [b.code]);
    const entry = cat.get(b.code);
    if (!entry || (b.codeSystem && entry.system !== b.codeSystem))
      throw validationFailed([
        { field: "code", code: "unknown", message: `${b.code} is not a known procedure code.` },
      ]);
    await validatePointers(ctx.db, enc.id, b.dxConditionIds);
    const fee = b.fee ?? (await standardFee(ctx.db, b.code));
    if (!fee)
      throw unprocessable(
        "no_fee",
        `${b.code} has no fee in the practice fee schedule. Enter the fee.`,
      );
    const units = b.units ?? 1;
    if (!(units > 0))
      throw validationFailed([
        { field: "units", code: "min", message: "Units must be at least 1." },
      ]);
    const signed = await noteIsSigned(ctx.db, enc.id);
    const row = await ctx.db.chargeItem.create({
      data: {
        practiceId: enc.practiceId,
        patientId: enc.patientId,
        encounterId: enc.id,
        codeSystem: entry.system,
        code: b.code,
        description: entry.display,
        modifiers: (b.modifiers ?? []).map((m) => m.toUpperCase()),
        units,
        dxConditionIds: b.dxConditionIds,
        fee,
        serviceDate: enc.periodStart ?? new Date(),
        renderingPractitionerId: enc.practitionerId,
        // A late charge (note already signed) goes to charge review instead of the claim automatically.
        status: signed ? "HELD" : "DRAFT",
        createdById: ctx.staff().userId,
      },
    });
    await recomputeEdits(ctx.db, enc);
    ctx.audit.resource("ChargeItem", row.id);
    ctx.audit.detail({ code: row.code, late: signed });
    return toDto(
      "ChargeItem",
      await ctx.db.chargeItem.findUniqueOrThrow({ where: { id: row.id } }),
    );
  },

  async updateChargeItem(ctx) {
    const { charge, enc } = await loadCharge(ctx, ctx.params.chargeItemId);
    ctx.checkVersion(charge.version, ctx.ifMatch());
    if (!(OPEN_STATUSES as readonly string[]).includes(charge.status))
      throw conflict(
        "charges_released",
        "This charge is already on a claim. Correct the claim instead.",
      );
    const b = ctx.body;
    const data: Prisma.ChargeItemUpdateInput = { version: { increment: 1 } };
    if (b.code && b.code !== charge.code) {
      const entry = (await procedureCatalog(ctx.db, [b.code])).get(b.code);
      if (!entry)
        throw validationFailed([
          { field: "code", code: "unknown", message: `${b.code} is not a known procedure code.` },
        ]);
      const fee = b.fee ?? (await standardFee(ctx.db, b.code));
      if (!fee) throw unprocessable("no_fee", `${b.code} has no fee in the practice fee schedule.`);
      Object.assign(data, {
        code: b.code,
        codeSystem: entry.system,
        description: entry.display,
        fee,
      });
    } else if (b.fee) data.fee = b.fee;
    if (b.modifiers) data.modifiers = b.modifiers.map((m) => m.toUpperCase());
    if (b.units !== undefined) {
      if (!(b.units > 0))
        throw validationFailed([
          { field: "units", code: "min", message: "Units must be at least 1." },
        ]);
      data.units = b.units;
    }
    if (b.dxConditionIds) {
      await validatePointers(ctx.db, enc.id, b.dxConditionIds);
      data.dxConditionIds = b.dxConditionIds;
    }
    if (b.holdNote !== undefined) data.holdNote = b.holdNote;
    const row = await ctx.db.chargeItem.update({
      where: { id: charge.id, version: charge.version },
      data,
    });
    await writeVersion(ctx.db, row.practiceId, "ChargeItem", row, ctx.staff().userId, "edited");
    await recomputeEdits(ctx.db, enc);
    return toDto(
      "ChargeItem",
      await ctx.db.chargeItem.findUniqueOrThrow({ where: { id: row.id } }),
    );
  },

  async deleteChargeItem(ctx) {
    const { charge, enc } = await loadCharge(ctx, ctx.params.chargeItemId);
    if (!(OPEN_STATUSES as readonly string[]).includes(charge.status))
      throw conflict(
        "charges_released",
        "This charge is already on a claim. Correct the claim instead.",
      );
    // Nothing is on the ledger before release, so removing a draft needs no reversing entry (INV-FIN-01).
    if (charge.status === "DRAFT") await ctx.db.chargeItem.delete({ where: { id: charge.id } });
    else
      await ctx.db.chargeItem.update({
        where: { id: charge.id },
        data: { status: "VOID", version: { increment: 1 } },
      });
    ctx.audit.detail({ code: charge.code, voided: charge.status !== "DRAFT" });
    await recomputeEdits(ctx.db, enc);
  },

  async applyCodingEdit(ctx) {
    const { charge, enc } = await loadCharge(ctx, ctx.params.chargeItemId);
    if (!(OPEN_STATUSES as readonly string[]).includes(charge.status))
      throw conflict("charges_released", "This charge is already on a claim.");
    const edit = editsOf(charge).find((e) => e.key === ctx.params.editKey);
    if (!edit) throw notFound("That edit no longer applies.");
    if (!edit.fix)
      throw unprocessable("no_fix", "This edit has no automatic fix. Change the line instead.");
    const target = edit.lineId ?? charge.id;
    const line = await ctx.db.chargeItem.findUniqueOrThrow({ where: { id: target } });
    if (!line.modifiers.includes(edit.fix.addModifier))
      await ctx.db.chargeItem.update({
        where: { id: line.id },
        data: { modifiers: [...line.modifiers, edit.fix.addModifier], version: { increment: 1 } },
      });
    ctx.audit.detail({ edit: edit.key, applied: edit.fix });
    await recomputeEdits(ctx.db, enc);
    return toDto(
      "ChargeItem",
      await ctx.db.chargeItem.findUniqueOrThrow({ where: { id: charge.id } }),
    );
  },

  async dismissCodingEdit(ctx) {
    const { charge, enc } = await loadCharge(ctx, ctx.params.chargeItemId);
    const edits = editsOf(charge);
    const edit = edits.find((e) => e.key === ctx.params.editKey);
    if (!edit) throw notFound("That edit no longer applies.");
    if (edit.severity === "error")
      throw unprocessable(
        "cannot_dismiss",
        "This edit must be fixed; only warnings can be dismissed.",
      );
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([{ field: "reason", code: "required", message: "Give a reason." }]);
    await ctx.db.chargeItem.update({
      where: { id: charge.id },
      data: {
        holdReasons: editsJson(
          edits.map((e) => (e.key === edit.key ? { ...e, dismissed: true, reason } : e)),
        ),
      },
    });
    ctx.audit.detail({ edit: edit.key, dismissed: true });
    await recomputeEdits(ctx.db, enc);
    return toDto(
      "ChargeItem",
      await ctx.db.chargeItem.findUniqueOrThrow({ where: { id: charge.id } }),
    );
  },

  async computeEmLevel(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const b = ctx.body;
    const out = suggestEm({ ...b, totalMinutes: b.totalMinutes ?? null });
    if (!out)
      throw unprocessable(
        "below_time_threshold",
        "Total time is below the lowest level for this visit type. Use medical decision making instead.",
      );
    await ctx.db.encounter.update({
      where: { id: enc.id },
      data: {
        emMethod: b.basis,
        emTotalMinutes: b.totalMinutes ?? null,
        mdmProblems: b.problems ?? null,
        mdmData: b.data ?? null,
        mdmRisk: b.risk ?? null,
        emSuggestedCode: out.code,
      },
    });
    return out;
  },

  async markNoChargeVisit(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const reason = ctx.body.reason?.trim();
    if (!reason)
      throw validationFailed([{ field: "reason", code: "required", message: "Give a reason." }]);
    const released = await ctx.db.chargeItem.count({
      where: { encounterId: enc.id, status: { in: ["READY", "BILLED"] } },
    });
    if (released)
      throw conflict("charges_released", "Charges for this visit are already on a claim.");
    await ctx.db.chargeItem.updateMany({
      where: { encounterId: enc.id, status: { in: [...OPEN_STATUSES] } },
      data: { status: "VOID" },
    });
    await ctx.db.encounter.update({
      where: { id: enc.id },
      data: { noChargeVisit: true, version: { increment: 1 } },
    });
    ctx.audit.detail({ noCharge: true, reason });
    return encounterDetail(ctx.db, enc.id);
  },
};
