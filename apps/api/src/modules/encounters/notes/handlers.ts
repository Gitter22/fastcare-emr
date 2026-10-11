import { releaseOnSign } from "../../rcm/charges.js";
import type { ClinicalNoteSummary, CosignItem } from "@agile-emr/shared";
import type { ClinicalNote, Prisma } from "../../../db.js";
import { limitOf, page, toDto, toDtos } from "../../../platform/dto.js";
import { binary, type Ctx, type HandlerMap } from "../../../platform/http/context.js";
import { notifyUsers, initials } from "../../../platform/notify.js";
import { completeTasksFor, createTask } from "../../../platform/tasks.js";
import { canSeeLabels, requirePatient } from "../../../platform/patientAccess.js";
import { renderPdf } from "../../../platform/pdf.js";
import {
  conflict,
  forbidden,
  invariantBlocked,
  notFound,
  unprocessable,
  validationFailed,
} from "../../../platform/problem.js";
import { settingValue } from "../../../platform/settings.js";
import { assertTransition } from "../../../platform/stateMachine.js";
import { practiceTimeZone, localParts } from "../../../platform/time.js";
import { writeVersion } from "../../../platform/versioning.js";
import { recordProvenance } from "../../clinical/provenance.js";
import { buildBanner } from "../../patients/banner.js";
import { loadAppointment, transition } from "../../scheduling/service.js";
import { loadEncounter } from "../access.js";
import { ensureAvs } from "../avs.js";
import {
  BASE_SECTIONS,
  apKey,
  isApKey,
  lockExpiry,
  sectionOrdinal,
  validSectionKey,
} from "./domain.js";
import {
  assertEditable,
  cosignFor,
  encounterTitle,
  ensureNote,
  isLocked,
  loadNote,
  noteDetail,
  noteSummaries,
  preflightFor,
} from "./service.js";

/**
 * Encounter note (encounter.note, encounter.sign, chart.timeline, inbox.cosign). Signed notes are immutable; changes
 * after signing are addenda (INV-SAFE-02). Only providers sign (INV-SAFE-01, enforced by x-roles before the handler).
 */

const MAX_SECTION = 50_000;
// Plain text only: strip control characters except tab and newline.
const clean = (t: string) =>
  t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, MAX_SECTION);

async function diagnosisRanks(ctx: Ctx, encounterId: string) {
  const dx = await ctx.db.condition.findMany({
    where: {
      encounterId,
      category: "ENCOUNTER_DIAGNOSIS",
      verificationStatus: { not: "ENTERED_IN_ERROR" },
    },
    select: { id: true, rank: true },
  });
  return new Map(dx.map((d) => [d.id, d.rank ?? 99]));
}

/** Write sections and renew the caller's edit lock; bumps the note version once. */
async function writeSections(
  ctx: Ctx,
  note: ClinicalNote,
  sections: Array<{ key: string; text: string }>,
) {
  const ranks = await diagnosisRanks(ctx, note.encounterId);
  for (const s of sections) {
    if (!validSectionKey(s.key))
      throw validationFailed([
        { field: "sections", code: "invalid", message: `Unknown note section "${s.key}".` },
      ]);
    if (isApKey(s.key) && !ranks.has(s.key.slice(3)))
      throw validationFailed([
        { field: "sections", code: "invalid", message: "That diagnosis isn't on this visit." },
      ]);
  }
  for (const s of sections)
    await ctx.db.noteSection.upsert({
      where: { noteId_key: { noteId: note.id, key: s.key } },
      create: {
        practiceId: note.practiceId,
        noteId: note.id,
        key: s.key,
        ordinal: sectionOrdinal(s.key, ranks),
        content: clean(s.text),
      },
      update: { content: clean(s.text), ordinal: sectionOrdinal(s.key, ranks) },
    });
  const me = ctx.staff();
  const row = await ctx.db.clinicalNote.update({
    where: { id: note.id, version: note.version },
    data: { lockedByUserId: me.userId, lockedAt: new Date(), version: { increment: 1 } },
  });
  await writeVersion(ctx.db, row.practiceId, "ClinicalNote", row, me.userId);
  return row;
}

function assertPatientContext(note: ClinicalNote, patientId: string | undefined) {
  // INV-ID-03: the patient on screen must be the encounter's patient.
  if (!patientId || patientId !== note.patientId)
    throw conflict(
      "patient_context_mismatch",
      "The patient on screen isn't this note's patient. Reopen the note from the right chart.",
    );
}

async function noteIdentity(ctx: Ctx, note: ClinicalNote) {
  const [patient, practice, enc, tz] = await Promise.all([
    ctx.db.patient.findUniqueOrThrow({ where: { id: note.patientId } }),
    ctx.db.practice.findUniqueOrThrow({ where: { id: note.practiceId } }),
    ctx.db.encounter.findUniqueOrThrow({ where: { id: note.encounterId } }),
    practiceTimeZone(ctx.db),
  ]);
  const banner = await buildBanner(ctx.db, patient);
  const dos = localParts(enc.periodStart ?? note.createdAt, tz).date;
  return { banner, practice, enc, dos, tz };
}

export const noteHandlers: HandlerMap = {
  async getNote(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const note = await ensureNote(ctx, enc);
    if (!(await canSeeLabels(ctx, note.patientId, note.securityLabels)))
      throw forbidden(
        "restricted_record",
        "This note is restricted. Request access with a reason.",
      );
    ctx.audit.resource("ClinicalNote", note.id);
    return noteDetail(ctx.db, note);
  },

  async saveNoteSections(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const note = await ensureNote(ctx, enc);
    const me = ctx.staff();
    await assertEditable(ctx.db, note, me.userId);
    ctx.checkVersion(note.version, ctx.body.version);
    const row = await writeSections(
      ctx,
      note,
      ctx.body.sections.map((s) => ({ key: s.key, text: s.text ?? "" })),
    );
    ctx.audit.resource("ClinicalNote", row.id);
    return noteDetail(ctx.db, row);
  },

  async lockNote(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const me = ctx.staff();
    await assertEditable(ctx.db, note, me.userId);
    const now = new Date();
    await ctx.db.clinicalNote.update({
      where: { id: note.id },
      data: { lockedByUserId: me.userId, lockedAt: now },
    });
    const u = await ctx.db.user.findUniqueOrThrow({ where: { id: me.userId } });
    return {
      heldBy: `${u.firstName} ${u.lastName}`,
      userId: u.id,
      acquiredAt: now.toISOString(),
      expiresAt: lockExpiry(now).toISOString(),
    };
  },

  async releaseNoteLock(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    if (note.lockedByUserId === ctx.staff().userId)
      await ctx.db.clinicalNote.update({
        where: { id: note.id },
        data: { lockedByUserId: null, lockedAt: null },
      });
  },

  async applyNoteTemplate(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const me = ctx.staff();
    await assertEditable(ctx.db, note, me.userId);
    ctx.checkVersion(note.version, ctx.body.version);
    const tpl = await ctx.db.noteTemplate.findUnique({ where: { id: ctx.body.noteTemplateId } });
    if (!tpl || !tpl.active || (!tpl.shared && tpl.ownerId && tpl.ownerId !== me.userId))
      throw unprocessable("validation_failed", "Choose an available template.");
    const existing = await ctx.db.noteSection.findMany({ where: { noteId: note.id } });
    const tplSections = (tpl.sections as Array<{ key: string; defaultText?: string }>).filter(
      (s) => BASE_SECTIONS.some((b) => b.key === s.key) && s.defaultText,
    );
    const updates = tplSections.map((s) => {
      const current = existing.find((e) => e.key === s.key)?.content.trim() ?? "";
      const text =
        ctx.body.mode === "replace" || !current ? s.defaultText! : `${current}\n${s.defaultText}`;
      return { key: s.key, text };
    });
    const row = await writeSections(ctx, note, updates);
    const withTpl = await ctx.db.clinicalNote.update({
      where: { id: row.id },
      data: { templateId: tpl.id },
    });
    ctx.audit.detail({ templateId: tpl.id, mode: ctx.body.mode });
    return noteDetail(ctx.db, withTpl);
  },

  async copyForwardNote(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const source = await ctx.db.clinicalNote.findFirst({
      where: {
        patientId: note.patientId,
        encounterId: { not: note.encounterId },
        status: { in: ["SIGNED", "ADDENDED"] },
      },
      orderBy: { signedAt: "desc" },
      include: { sections: true },
    });
    if (!source || !(await canSeeLabels(ctx, source.patientId, source.securityLabels)))
      throw conflict("no_prior_note", "There's no earlier signed note to copy from.");
    const tz = await practiceTimeZone(ctx.db);
    const signedOn = localParts(source.signedAt!, tz).date;
    const days = Math.floor((Date.now() - source.signedAt!.getTime()) / 86_400_000);
    const [medsChanged, newVitals] = await Promise.all([
      ctx.db.medicationStatement.count({
        where: { patientId: note.patientId, updatedAt: { gt: source.signedAt! } },
      }),
      ctx.db.observation.count({
        where: {
          patientId: note.patientId,
          category: "VITAL_SIGNS",
          effectiveAt: { gt: source.signedAt! },
        },
      }),
    ]);
    const staleItems = [
      `Copied from the note signed ${signedOn} (${days} day${days === 1 ? "" : "s"} ago). Review every line.`,
    ];
    if (newVitals)
      staleItems.push("Vitals have been recorded since; the copied exam may quote old values.");
    if (medsChanged) staleItems.push("The medication list changed since that note.");
    ctx.audit.detail({ sourceNoteId: source.id });
    return {
      sections: toDtos(
        "NoteSection",
        source.sections
          .filter((s) => ["hpi", "ros", "exam", "data"].includes(s.key))
          .sort((a, b) => a.ordinal - b.ordinal),
      ),
      sourceNoteId: source.id,
      staleItems,
    };
  },

  async decideAiSegment(ctx) {
    const seg = await ctx.db.aiDraftSegment.findUnique({
      where: { id: ctx.params.aiSegmentId },
      include: { section: true },
    });
    if (!seg) throw notFound();
    const note = await loadNote(ctx, seg.section.noteId);
    const me = ctx.staff();
    await assertEditable(ctx.db, note, me.userId);
    ctx.checkVersion(note.version, ctx.body.version);
    if (seg.status !== "PENDING")
      throw conflict("already_decided", "This draft text was already reviewed.");
    const b = ctx.body;
    if (b.decision === "edit" && !b.editedText?.trim())
      throw validationFailed([
        { field: "editedText", code: "required", message: "Enter the edited text." },
      ]);
    const text =
      b.decision === "accept" ? seg.text : b.decision === "edit" ? b.editedText!.trim() : null;
    if (text) {
      const current = seg.section.content.trim();
      await writeSections(ctx, note, [
        { key: seg.section.key, text: current ? `${current}\n${text}` : text },
      ]);
    } else {
      await ctx.db.clinicalNote.update({
        where: { id: note.id },
        data: { version: { increment: 1 } },
      });
    }
    const row = await ctx.db.aiDraftSegment.update({
      where: { id: seg.id },
      data: {
        status:
          b.decision === "accept" ? "ACCEPTED" : b.decision === "edit" ? "EDITED" : "DISCARDED",
        ...(b.decision === "edit" ? { text: b.editedText!.trim() } : {}),
        decidedById: me.userId,
        decidedAt: new Date(),
      },
    });
    await recordProvenance(ctx.db, note.practiceId, {
      targetType: "AiDraftSegment",
      targetId: seg.id,
      source: "AI_DRAFT",
      activity: `ai-${b.decision}`,
      agentId: me.userId,
      agentDisplay: seg.model,
    });
    ctx.audit.resource("AiDraftSegment", seg.id);
    return toDto("AiDraftSegment", row);
  },

  async markNoteReadyToSign(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const me = ctx.staff();
    assertTransition("note", note.status, "ready-to-sign", me.role);
    ctx.checkVersion(note.version, ctx.body.version);
    await assertEditable(ctx.db, note, me.userId);
    const row = await ctx.db.clinicalNote.update({
      where: { id: note.id },
      data: { status: "READY_TO_SIGN", version: { increment: 1 } },
    });
    await writeVersion(ctx.db, row.practiceId, "ClinicalNote", row, me.userId);
    return noteDetail(ctx.db, row);
  },

  async getSignPreflight(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const note = await ensureNote(ctx, enc);
    return preflightFor(ctx.db, enc, note, ctx.staff().userId);
  },

  async signNote(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const b = ctx.body;
    const me = ctx.staff();
    if (isLocked(note))
      throw conflict("note_signed", "This note is already signed. Add an addendum instead.");
    assertPatientContext(note, b.patientId);
    if (!b.attest)
      throw validationFailed([
        { field: "attest", code: "required", message: "Confirm the attestation to sign." },
      ]);
    ctx.checkVersion(note.version, b.version);
    if (await settingValue(ctx.db, "notes.signRequiresStepUp", true)) ctx.requireStepUp();
    const enc = await ctx.db.encounter.findUniqueOrThrow({ where: { id: note.encounterId } });
    const pre = await preflightFor(ctx.db, enc, note, me.userId);
    if (!pre.canSign)
      throw invariantBlocked(
        pre.blockers.map((x) => ({
          code: x.code,
          text: x.text,
          invariant: x.code === "ai_text_unaccepted" ? "INV-DATA-02" : "INV-SAFE-08",
        })),
        `Fix ${pre.blockers.length} item${pre.blockers.length === 1 ? "" : "s"} before signing.`,
      );
    const cosign = await cosignFor(ctx.db, enc);
    const to = cosign.applies ? "pending-cosign" : "signed";
    assertTransition("note", note.status, to, me.role);
    const now = new Date();
    const row = await ctx.db.clinicalNote.update({
      where: { id: note.id, version: note.version },
      data: {
        status: cosign.applies ? "PENDING_COSIGN" : "SIGNED",
        signedById: me.userId,
        signedAt: now,
        cosignRequired: cosign.applies,
        cosignerId: cosign.cosigner?.userId ?? null,
        lockedByUserId: null,
        lockedAt: null,
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, row.practiceId, "ClinicalNote", row, me.userId, "signed");
    // Problems addressed this visit.
    const dx = await ctx.db.condition.findMany({
      where: {
        encounterId: enc.id,
        category: "ENCOUNTER_DIAGNOSIS",
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
    });
    const codes = dx.map((d) => d.icd10Code).filter((c): c is string => !!c);
    if (codes.length)
      await ctx.db.condition.updateMany({
        where: {
          patientId: enc.patientId,
          category: "PROBLEM_LIST_ITEM",
          icd10Code: { in: codes },
          stagingStatus: "ACTIVE",
        },
        data: { lastAddressedAt: now },
      });
    await ctx.db.encounter.update({
      where: { id: enc.id },
      data: { status: "FINISHED", periodEnd: enc.periodEnd ?? now, version: { increment: 1 } },
    });
    // The visit moves on to checkout once the provider is done (flow:encounter/07 -> 08).
    if (enc.appointmentId) {
      const a = await loadAppointment(ctx, enc.appointmentId);
      if (a.status === "WITH_PROVIDER") {
        await transition(ctx, a, "checkout", { note: "Note signed" });
        if (a.roomId)
          await ctx.db.room.update({ where: { id: a.roomId }, data: { status: "NEEDS_CLEANING" } });
      }
    }
    const avs = await ensureAvs(ctx.db, enc);
    let tasksCreated = 0;
    if (cosign.applies && cosign.cosigner) {
      const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: note.patientId } });
      await createTask(ctx.db, row.practiceId, {
        type: "COSIGN",
        title: `Co-sign note for ${initials(patient)}`,
        patientId: note.patientId,
        focusType: "ClinicalNote",
        focusId: note.id,
        ownerUserId: cosign.cosigner.userId,
        createdById: me.userId,
      });
      tasksCreated = 1;
      await notifyUsers(ctx.db, row.practiceId, [cosign.cosigner.userId], {
        type: "GENERAL",
        title: `Note for ${initials(patient)} is waiting for your co-signature`,
        linkRoute: "/inbox/cosign",
      });
    }
    ctx.audit.detail({
      to,
      cosigner: cosign.cosigner?.userId ?? null,
      warnings: b.acknowledgedWarnings ?? [],
    });
    const [summary] = await noteSummaries(ctx.db, [row]);
    // flow:rcm/01: a signed note releases clean charges to a claim; the rest wait in charge review.
    const chargesCreated = to === "signed" ? await releaseOnSign(ctx.db, enc.id, me.userId) : 0;
    return { note: summary!, chargesCreated, tasksCreated, avsId: avs.id };
  },

  async cosignNote(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const b = ctx.body;
    const me = ctx.staff();
    if (note.status !== "PENDING_COSIGN")
      throw conflict("not_pending_cosign", "This note isn't waiting for a co-signature.");
    assertPatientContext(note, b.patientId);
    if (note.cosignerId !== me.userId)
      throw forbidden(
        "not_cosigner",
        "Only the supervising provider named on this note can co-sign it.",
      );
    if (!b.attest)
      throw validationFailed([
        { field: "attest", code: "required", message: "Confirm the attestation to co-sign." },
      ]);
    ctx.checkVersion(note.version, b.version);
    assertTransition("note", note.status, "signed", me.role);
    const row = await ctx.db.clinicalNote.update({
      where: { id: note.id, version: note.version },
      data: { status: "SIGNED", cosignedAt: new Date(), version: { increment: 1 } },
    });
    await writeVersion(ctx.db, row.practiceId, "ClinicalNote", row, me.userId, "co-signed");
    await completeTasksFor(ctx.db, "ClinicalNote", note.id, ["COSIGN"], me.userId);
    const [summary] = await noteSummaries(ctx.db, [row]);
    const chargesCreated = await releaseOnSign(ctx.db, note.encounterId, me.userId);
    return { note: summary!, chargesCreated, tasksCreated: 0 };
  },

  async returnNoteToAuthor(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const me = ctx.staff();
    if (note.status !== "PENDING_COSIGN")
      throw conflict("not_pending_cosign", "This note isn't waiting for a co-signature.");
    if (note.cosignerId !== me.userId)
      throw forbidden(
        "not_cosigner",
        "Only the supervising provider named on this note can return it.",
      );
    const comment = clean(ctx.body.comment ?? "").trim();
    if (!comment)
      throw validationFailed([
        { field: "comment", code: "required", message: "Say what needs another look." },
      ]);
    const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: note.patientId } });
    // The note stays pending co-sign (states.yaml has no way back to draft); the author answers in the task.
    const task = await createTask(ctx.db, note.practiceId, {
      type: "PROVIDER_QUERY",
      title: `Co-signer question on note for ${initials(patient)}`,
      description: comment,
      patientId: note.patientId,
      focusType: "ClinicalNote",
      focusId: note.id,
      ownerUserId: note.signedById ?? note.authorId,
      createdById: me.userId,
    });
    await notifyUsers(ctx.db, note.practiceId, [note.signedById ?? note.authorId], {
      type: "GENERAL",
      title: `Your co-signer asked about a note for ${initials(patient)}`,
      linkRoute: `/patient/${note.patientId}/encounter/${note.encounterId}/note`,
    });
    ctx.audit.resource("Task", task.id);
    return toDto("Task", task);
  },

  async addAddendum(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const me = ctx.staff();
    if (note.status !== "SIGNED" && note.status !== "ADDENDED")
      throw conflict("note_not_signed", "Addenda are for signed notes. Edit the draft instead.");
    const text = clean(ctx.body.text ?? "").trim();
    const reason = clean(ctx.body.reason ?? "").trim();
    if (!text)
      throw validationFailed([{ field: "text", code: "required", message: "Write the addendum." }]);
    if (!reason)
      throw validationFailed([
        { field: "reason", code: "required", message: "Give a reason for the addendum." },
      ]);
    assertTransition("note", note.status, "addended", me.role);
    const add = await ctx.db.addendum.create({
      data: {
        practiceId: note.practiceId,
        noteId: note.id,
        text: `${text}\n\nReason: ${reason}`,
        authorId: me.userId,
      },
    });
    const row = await ctx.db.clinicalNote.update({
      where: { id: note.id },
      data: { status: "ADDENDED", version: { increment: 1 } },
    });
    await writeVersion(ctx.db, row.practiceId, "ClinicalNote", row, me.userId, "addendum");
    ctx.audit.resource("Addendum", add.id);
    return toDto("Addendum", add);
  },

  async listPatientNotes(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(q);
    const where: Prisma.ClinicalNoteWhereInput = {
      patientId: ctx.params.patientId,
      ...(q.status?.length ? { status: { in: q.status as ClinicalNote["status"][] } } : {}),
      ...(q.fromDate || q.toDate
        ? {
            createdAt: {
              ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
              ...(q.toDate ? { lt: new Date(new Date(q.toDate).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
      ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
    };
    const rows = await ctx.db.clinicalNote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    // Restricted notes are left out (INV-SEC-03); chart.summary reports how many were hidden.
    const visible: ClinicalNote[] = [];
    for (const r of rows)
      if (await canSeeLabels(ctx, r.patientId, r.securityLabels)) visible.push(r);
    const summaries = await noteSummaries(ctx.db, visible);
    ctx.audit.detail({ rows: visible.length, hidden: rows.length - visible.length });
    return page(
      visible.map((n, i) => ({ n, s: summaries[i]! })),
      limit,
      (x) => x.s,
      (x) => x.n.createdAt.toISOString(),
    );
  },

  async getNoteDetail(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    return noteDetail(ctx.db, note);
  },

  async getNotePdf(ctx) {
    const note = await loadNote(ctx, ctx.params.noteId);
    const { banner, practice, enc, dos, tz } = await noteIdentity(ctx, note);
    const [sections, addenda, dx, signer, title] = await Promise.all([
      ctx.db.noteSection.findMany({ where: { noteId: note.id }, orderBy: { ordinal: "asc" } }),
      ctx.db.addendum.findMany({ where: { noteId: note.id }, orderBy: { signedAt: "asc" } }),
      ctx.db.condition.findMany({
        where: {
          encounterId: enc.id,
          category: "ENCOUNTER_DIAGNOSIS",
          verificationStatus: { not: "ENTERED_IN_ERROR" },
        },
        orderBy: { rank: "asc" },
      }),
      note.signedById ? ctx.db.user.findUnique({ where: { id: note.signedById } }) : null,
      encounterTitle(ctx.db, enc),
    ]);
    const users = await ctx.db.user.findMany({
      where: { id: { in: addenda.map((a) => a.authorId) } },
    });
    const pdf = await renderPdf(
      {
        title: `${title} · ${dos}`,
        patientLine: `${banner.name} · DOB ${banner.birthDate} · MRN ${banner.mrn}`,
        practiceName: practice.legalName,
      },
      (w) => {
        if (note.status === "DRAFT" || note.status === "READY_TO_SIGN")
          w.muted("DRAFT — not signed");
        for (const s of BASE_SECTIONS) {
          const content = sections.find((x) => x.key === s.key)?.content;
          if (!content?.trim()) continue;
          w.subheading(s.title);
          w.paragraph(content);
        }
        if (dx.length) {
          w.subheading("Assessment and plan");
          dx.forEach((d, i) => {
            w.paragraph(`${i + 1}. ${d.display} (${d.icd10Code ?? "uncoded"})`);
            const plan = sections.find((x) => x.key === apKey(d.id))?.content;
            if (plan?.trim()) w.paragraph(plan);
          });
        }
        w.spacer();
        if (note.signedAt && signer)
          w.muted(
            `Electronically signed by ${signer.firstName} ${signer.lastName} on ${localParts(note.signedAt, tz).date} ${localParts(note.signedAt, tz).time}${note.status === "PENDING_COSIGN" ? " · pending co-signature" : ""}`,
          );
        for (const a of addenda) {
          const u = users.find((x) => x.id === a.authorId);
          w.subheading(`Addendum · ${localParts(a.signedAt, tz).date}`);
          w.paragraph(a.text);
          w.muted(`Signed by ${u ? `${u.firstName} ${u.lastName}` : "unknown"}`);
        }
      },
    );
    return binary("application/pdf", pdf, `note-${dos}.pdf`);
  },

  async listNoteTemplates(ctx) {
    const me = ctx.staff();
    const q = ctx.query.q?.trim();
    const rows = await ctx.db.noteTemplate.findMany({
      where: {
        active: true,
        OR: [{ shared: true }, { ownerId: null }, { ownerId: me.userId }],
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { name: "asc" },
    });
    return toDtos("NoteTemplate", rows);
  },

  async listSmartPhrases(ctx) {
    const me = ctx.staff();
    const q = ctx.query.q?.trim().replace(/^\./, "");
    const rows = await ctx.db.smartPhrase.findMany({
      where: {
        OR: [{ shared: true }, { ownerId: me.userId }],
        ...(q ? { trigger: { startsWith: q, mode: "insensitive" } } : {}),
      },
      orderBy: { trigger: "asc" },
    });
    return toDtos("SmartPhrase", rows);
  },

  async listCosignQueue(ctx) {
    const me = ctx.staff();
    const limit = limitOf(ctx.query);
    const rows = await ctx.db.clinicalNote.findMany({
      where: {
        status: "PENDING_COSIGN",
        cosignerId: me.userId,
        ...(ctx.query.cursor ? { signedAt: { gt: new Date(ctx.query.cursor) } } : {}),
      },
      orderBy: { signedAt: "asc" },
      take: limit + 1,
    });
    const summaries = await noteSummaries(ctx.db, rows);
    const items: Array<{ n: ClinicalNote; item: CosignItem }> = rows.map((n, i) => ({
      n,
      item: {
        note: summaries[i] as ClinicalNoteSummary,
        author: summaries[i]!.authorName,
        waitingHours: Math.floor((Date.now() - (n.signedAt ?? n.updatedAt).getTime()) / 3_600_000),
      },
    }));
    ctx.audit.detail({ rows: rows.length });
    return page(
      items,
      limit,
      (x) => x.item,
      (x) => (x.n.signedAt ?? x.n.updatedAt).toISOString(),
    );
  },
};
