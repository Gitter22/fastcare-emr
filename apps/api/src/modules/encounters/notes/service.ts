import type { ClinicalNoteDetail, ClinicalNoteSummary } from "@agile-emr/shared";
import type { ClinicalNote, Encounter, Tx } from "../../../db.js";
import { toDto, toDtos } from "../../../platform/dto.js";
import type { Ctx } from "../../../platform/http/context.js";
import { canSeeLabels, requirePatient } from "../../../platform/patientAccess.js";
import { conflict, forbidden, notFound } from "../../../platform/problem.js";
import { transitionsFrom } from "../../../platform/stateMachine.js";
import { localParts, practiceTimeZone } from "../../../platform/time.js";
import { isUnspecified } from "../../clinical/reference.js";
import { summaries } from "../../patients/service.js";
import { practitionerName } from "../../scheduling/views.js";
import { type Preflight, computePreflight, lockExpiry, lockHeldByOther } from "./domain.js";

const NOTE_STATE: Record<ClinicalNote["status"], string> = {
  DRAFT: "draft",
  READY_TO_SIGN: "ready-to-sign",
  PENDING_COSIGN: "pending-cosign",
  SIGNED: "signed",
  ADDENDED: "addended",
};
export const noteState = (n: Pick<ClinicalNote, "status">) => NOTE_STATE[n.status];
export const isLocked = (n: Pick<ClinicalNote, "status">) =>
  n.status === "SIGNED" || n.status === "ADDENDED" || n.status === "PENDING_COSIGN";

/** A note the caller may read: patient access, then the note's own restricted labels (INV-SEC-03). */
export async function loadNote(ctx: Ctx, noteId: string) {
  const note = await ctx.db.clinicalNote.findUnique({ where: { id: noteId } });
  if (!note) throw notFound();
  await requirePatient(ctx, note.patientId);
  if (!(await canSeeLabels(ctx, note.patientId, note.securityLabels)))
    throw forbidden("restricted_record", "This note is restricted. Request access with a reason.");
  ctx.audit.resource("ClinicalNote", note.id);
  return note;
}

/** The encounter's note, created as a draft on first open (getNote "creates a draft if none"). */
export async function ensureNote(ctx: Ctx, enc: Encounter): Promise<ClinicalNote> {
  // Screens load the note from several requests at once; serialise creation per encounter (held to commit) so two
  // first opens can't each create a draft.
  await ctx.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`note:${enc.id}`}))`;
  const existing = await ctx.db.clinicalNote.findFirst({
    where: { encounterId: enc.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  const practitioner = await ctx.db.practitioner.findUnique({ where: { id: enc.practitionerId } });
  const note = await ctx.db.clinicalNote.create({
    data: {
      practiceId: enc.practiceId,
      encounterId: enc.id,
      patientId: enc.patientId,
      // The rendering provider authors the note; an MA opening it first is scribing for them.
      authorId: practitioner?.userId ?? ctx.staff().userId,
      securityLabels: enc.securityLabels,
    },
  });
  if (enc.chiefComplaint?.trim())
    await ctx.db.noteSection.create({
      data: {
        practiceId: enc.practiceId,
        noteId: note.id,
        key: "cc",
        ordinal: 0,
        content: enc.chiefComplaint.trim(),
      },
    });
  return note;
}

/** Visit title: the appointment's visit type, else the encounter class. */
export async function encounterTitle(tx: Tx, enc: Pick<Encounter, "appointmentId" | "class">) {
  if (enc.appointmentId) {
    const a = await tx.appointment.findUnique({
      where: { id: enc.appointmentId },
      include: { visitType: true },
    });
    if (a?.visitType) return `${a.visitType.name} visit`.replace(/ visit visit$/i, " visit");
  }
  return {
    AMB: "Office visit",
    VR: "Video visit",
    PHONE: "Phone encounter",
    ASYNC: "Portal encounter",
    HH: "Home visit",
  }[enc.class];
}

export async function noteDetail(tx: Tx, note: ClinicalNote): Promise<ClinicalNoteDetail> {
  const [sections, addenda, holder] = await Promise.all([
    tx.noteSection.findMany({ where: { noteId: note.id }, orderBy: { ordinal: "asc" } }),
    tx.addendum.findMany({ where: { noteId: note.id }, orderBy: { signedAt: "asc" } }),
    note.lockedByUserId && note.lockedAt && lockExpiry(note.lockedAt) > new Date()
      ? tx.user.findUnique({ where: { id: note.lockedByUserId } })
      : null,
  ]);
  const segments = sections.length
    ? await tx.aiDraftSegment.findMany({
        where: { sectionId: { in: sections.map((s) => s.id) } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  return {
    ...toDto("ClinicalNote", note),
    sections: toDtos("NoteSection", sections),
    aiSegments: toDtos("AiDraftSegment", segments),
    addenda: toDtos("Addendum", addenda),
    ...(holder && note.lockedAt
      ? {
          lock: {
            heldBy: `${holder.firstName} ${holder.lastName}`,
            userId: holder.id,
            acquiredAt: note.lockedAt.toISOString(),
            expiresAt: lockExpiry(note.lockedAt).toISOString(),
          },
        }
      : {}),
    allowedTransitions: transitionsFrom("note", noteState(note)),
  };
}

export async function noteSummaries(tx: Tx, notes: ClinicalNote[]): Promise<ClinicalNoteSummary[]> {
  if (!notes.length) return [];
  const [encs, authors, patients, tz] = await Promise.all([
    tx.encounter.findMany({ where: { id: { in: notes.map((n) => n.encounterId) } } }),
    tx.user.findMany({
      where: { id: { in: notes.map((n) => n.authorId) } },
      include: { practitioner: true },
    }),
    summaries(tx, [...new Set(notes.map((n) => n.patientId))]),
    practiceTimeZone(tx),
  ]);
  const out: ClinicalNoteSummary[] = [];
  for (const n of notes) {
    const enc = encs.find((e) => e.id === n.encounterId)!;
    const author = authors.find((a) => a.id === n.authorId);
    const when = enc.periodStart ?? n.createdAt;
    out.push({
      id: n.id,
      encounterId: n.encounterId,
      patient: patients.find((p) => p.id === n.patientId)!,
      status: n.status,
      title: await encounterTitle(tx, enc),
      authorName: author?.practitioner
        ? practitionerName(author.practitioner)
        : author
          ? `${author.firstName} ${author.lastName}`
          : "Unknown",
      dateOfService: localParts(when, tz).date,
      updatedAt: n.updatedAt.toISOString(),
      ageHours: Math.max(0, Math.floor((Date.now() - n.createdAt.getTime()) / 3_600_000)),
    });
  }
  return out;
}

/** Edits are allowed on draft/ready notes, by the lock holder only (INV-SAFE-02, locked-by-another-user). */
export async function assertEditable(tx: Tx, note: ClinicalNote, userId: string) {
  if (isLocked(note))
    throw conflict("note_signed", "This note is signed. Add an addendum instead.");
  if (lockHeldByOther(note, userId)) {
    const u = await tx.user.findUnique({ where: { id: note.lockedByUserId! } });
    throw conflict(
      "note_locked",
      `${u ? `${u.firstName} ${u.lastName}` : "Someone"} is editing this note.`,
      {
        heldBy: u ? `${u.firstName} ${u.lastName}` : null,
      },
    );
  }
}

/**
 * Co-sign rules (CosignRule): a supervised clinician's note routes to the supervisor when the rule's criteria match.
 * Supported criteria: newPatient (no earlier signed note at the practice), always (no criteria).
 */
export async function cosignFor(
  tx: Tx,
  enc: Encounter,
): Promise<{ applies: boolean; cosigner: { userId: string; name: string } | null }> {
  const rules = await tx.cosignRule.findMany({
    where: { practitionerId: enc.practitionerId, active: true, appliesTo: { has: "note" } },
  });
  for (const r of rules) {
    const c = (r.criteria ?? {}) as { newPatient?: boolean };
    let applies = true;
    if (c.newPatient) {
      const prior = await tx.clinicalNote.count({
        where: {
          patientId: enc.patientId,
          encounterId: { not: enc.id },
          status: { in: ["SIGNED", "ADDENDED"] },
        },
      });
      applies = prior === 0;
    }
    if (!applies) continue;
    const sup = await tx.practitioner.findUnique({ where: { id: r.supervisorId } });
    return {
      applies: true,
      cosigner: sup?.userId ? { userId: sup.userId, name: practitionerName(sup) } : null,
    };
  }
  return { applies: false, cosigner: null };
}

/** Gather the pre-flight facts for an encounter's note (encounter.sign). */
export async function preflightFor(
  tx: Tx,
  enc: Encounter,
  note: ClinicalNote,
  userId: string,
): Promise<Preflight> {
  const [sections, diagnoses, rx, orders, charges, cosign] = await Promise.all([
    tx.noteSection.findMany({ where: { noteId: note.id } }),
    tx.condition.findMany({
      where: {
        encounterId: enc.id,
        category: "ENCOUNTER_DIAGNOSIS",
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
      orderBy: { rank: "asc" },
    }),
    tx.medicationRequest.findMany({
      where: { encounterId: enc.id, status: "DRAFT" },
    }),
    tx.serviceRequest.findMany({
      where: { encounterId: enc.id, status: { not: "CANCELLED" } },
      include: { reasons: true },
    }),
    tx.chargeItem.findMany({ where: { encounterId: enc.id, status: { notIn: ["VOID"] } } }),
    cosignFor(tx, enc),
  ]);
  const pending = sections.length
    ? await tx.aiDraftSegment.findMany({
        where: { sectionId: { in: sections.map((s) => s.id) }, status: "PENDING" },
      })
    : [];
  const holder = lockHeldByOther(note, userId)
    ? await tx.user.findUnique({ where: { id: note.lockedByUserId! } })
    : null;
  return computePreflight({
    sections,
    pendingAi: pending.map((p) => ({
      sectionKey: sections.find((s) => s.id === p.sectionId)!.key,
    })),
    diagnoses,
    unsignedRx: rx.map((r) => ({ display: r.display })),
    ordersWithoutDx: orders.filter((o) => !o.reasons.length).map((o) => ({ display: o.display })),
    chargesWithoutPointer: charges
      .filter((c) => !c.dxConditionIds.length)
      .map((c) => ({ code: c.code })),
    lockedBy: holder ? `${holder.firstName} ${holder.lastName}` : null,
    cosigner: cosign.cosigner,
    cosignRuleApplies: cosign.applies,
    unspecified: diagnoses
      .filter((d) => d.icd10Code && isUnspecified(d.display))
      .map((d) => ({ code: d.icd10Code!, display: d.display })),
  });
}
