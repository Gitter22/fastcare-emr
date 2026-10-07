import schemaTags from "../../contracts/schema-tags.json" with { type: "json" };
import type { Prisma, Tx } from "../../db.js";
import { encryptOptionalField } from "../../platform/crypto.js";
import { limitOf, toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { notifyRole } from "../../platform/notify.js";
import { auditPage } from "../../platform/auditView.js";
import {
  RESTRICTED_LABELS,
  recentPatientIds,
  rememberRecentPatient,
  requirePatient,
} from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { ageText, displayName, parseDate, parseSearch } from "./domain.js";
import {
  MERGEABLE_FIELDS,
  contactData,
  decryptRelated,
  fieldText,
  findDuplicates,
  isBlocking,
  nextMrn,
  patientDetail,
  patientFlags,
  primaryEmail,
  primaryPhone,
  relatedData,
  searchPatientIds,
  summaries,
  toSummary,
} from "./service.js";
import { bannerExtras } from "./banner.js";

const date = (s: string | null | undefined) =>
  s ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s) : s === null ? null : undefined;
const pid = (ctx: Ctx) => ctx.practiceId!;

function cursorOffset(cursor: string | undefined): number {
  const n = Number(cursor ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Patient columns accepted from create/update bodies (the DTO already excludes @server fields). */
function patientColumns(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (k === "birthDate" || k === "deceasedAt") out[k] = date(v as string);
    else out[k] = v;
  }
  return out;
}

export const patientHandlers: HandlerMap = {
  async searchPatients(ctx) {
    const q = ctx.query;
    const parsed = parseSearch(q.q);
    const birthDate = q.birthDate ?? parsed.birthDate;
    const phone = q.phone?.replace(/\D/g, "") || parsed.phoneDigits;
    const limit = limitOf(q);
    const offset = cursorOffset(q.cursor);
    const ids = await searchPatientIds(ctx.db, {
      names: parsed.names,
      birthDate,
      phoneDigits: phone,
      mrn: q.mrn ?? parsed.mrn,
      limit: limit + 1,
      offset,
    });
    const rows = await summaries(ctx.db, ids.slice(0, limit));
    ctx.audit.detail({
      results: rows.length,
      criteria: Object.keys(q).filter((k) => k !== "cursor" && k !== "limit"),
    });
    return {
      data: rows,
      nextCursor: ids.length > limit ? String(offset + limit) : null,
      hasMore: ids.length > limit,
    };
  },

  async checkDuplicates(ctx) {
    const b = ctx.body;
    const candidates = await findDuplicates(ctx.db, b);
    ctx.audit.detail({ candidates: candidates.length });
    return {
      candidates: candidates.map(({ patient, score, matchedOn }) => ({
        patient,
        score,
        matchedOn,
      })),
      blocking: isBlocking(candidates),
    };
  },

  async createPatient(ctx) {
    const b = ctx.body;
    const me = ctx.staff();
    const practiceId = pid(ctx);
    const phone = b.contactPoints?.find((c) => c.system === "PHONE" || c.system === "SMS")?.value;
    const email = b.contactPoints?.find((c) => c.system === "EMAIL")?.value;
    // INV-ID-02: the server re-runs the duplicate search; a strong match blocks without a recorded reason.
    const dups = await findDuplicates(ctx.db, {
      firstName: b.patient.firstName,
      lastName: b.patient.lastName,
      birthDate: b.patient.birthDate,
      phone,
      email,
      ssnLast4: b.patient.ssnLast4,
    });
    if (isBlocking(dups) && !b.duplicateOverrideReason?.trim()) {
      throw conflict(
        "duplicate",
        "This person may already be registered. Compare the records, or record why this is a different person.",
        {
          candidates: dups.map(({ patient, score, matchedOn }) => ({ patient, score, matchedOn })),
        },
      );
    }
    const mrn = await nextMrn(ctx.db, practiceId);
    const created = await ctx.db.patient.create({
      data: {
        ...(patientColumns(
          b.patient as unknown as Record<string, unknown>,
        ) as Prisma.PatientUncheckedCreateInput),
        raceCodes: b.patient.raceCodes ?? [],
        ethnicityCodes: b.patient.ethnicityCodes ?? [],
        securityLabels: b.patient.securityLabels ?? [],
        practiceId,
        mrn,
        createdById: me.userId,
      } as Prisma.PatientUncheckedCreateInput,
    });
    await ctx.db.patientIdentifier.create({
      data: {
        practiceId,
        patientId: created.id,
        system: `urn:agile-emr:mrn:${practiceId}`,
        value: mrn,
        type: "MR",
      },
    });
    for (const a of b.addresses ?? [])
      await ctx.db.patientAddress.create({
        data: {
          ...a,
          practiceId,
          patientId: created.id,
          periodStart: date(a.periodStart),
          periodEnd: date(a.periodEnd),
        },
      });
    for (const c of b.contactPoints ?? [])
      await ctx.db.patientContactPoint.create({ data: contactData(practiceId, created.id, c) });
    let guarantorId: string | null = null;
    for (const r of b.relatedPersons ?? []) {
      const rp = await ctx.db.relatedPerson.create({
        data: {
          ...r,
          ...relatedData(r),
          practiceId,
          patientId: created.id,
          birthDate: date(r.birthDate),
          address: (r.address ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      if (r.isGuarantor) guarantorId = rp.id;
    }
    if (guarantorId)
      await ctx.db.patient.update({
        where: { id: created.id },
        data: { guarantorRelatedPersonId: guarantorId },
      });
    for (const c of b.coverages ?? []) {
      await ctx.db.coverage.create({
        data: {
          ...c,
          practiceId,
          patientId: created.id,
          memberId: encryptOptionalField(c.memberId)!,
          periodStart: date(c.periodStart),
          periodEnd: date(c.periodEnd),
        },
      });
    }
    for (const c of b.consents ?? []) {
      await ctx.db.consent.create({
        data: {
          practiceId,
          patientId: created.id,
          type: c.type,
          status: "ACTIVE",
          signedAt: new Date(),
          signedBy: c.signerName,
          method: "tablet",
          documentFileId: c.signatureFileId ?? null,
          expiresAt: date(c.expiresAt) ?? null,
          scope: { documentVersion: c.documentVersion, signerRelationship: c.signerRelationship },
          recordedById: me.userId,
        },
      });
    }
    if (dups.length && b.duplicateOverrideReason) {
      // "Not the same person" is logged and queued for duplicate review (patients.merge-review).
      for (const d of dups) {
        const [a, bb] = [d.patient.id, created.id].sort();
        await ctx.db.duplicateCandidate.upsert({
          where: { patientAId_patientBId: { patientAId: a!, patientBId: bb! } },
          create: {
            practiceId,
            patientAId: a!,
            patientBId: bb!,
            score: d.score,
            matchedOn: d.matchedOn,
            reason: "created-anyway",
            createdById: me.userId,
          },
          update: {},
        });
      }
      ctx.audit.detail({ duplicateOverride: true, candidates: dups.length });
    }
    await ctx.db.provenanceRecord.create({
      data: {
        practiceId,
        targetType: "Patient",
        targetId: created.id,
        source: "ENTERED",
        activity: "create",
        agentType: "user",
        agentId: me.userId,
      },
    });
    const detail = await patientDetail(ctx.db, created.id);
    await writeVersion(ctx.db, practiceId, "Patient", detail, me.userId, "create");
    ctx.audit.patient(created.id);
    ctx.audit.resource("Patient", created.id);
    ctx.setHeader("Location", `/api/v1/patients/${created.id}`);
    return toDto("PatientDetail", detail);
  },

  async getPatient(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    ctx.audit.resource("Patient", ctx.params.patientId);
    if (ctx.principal?.kind === "staff")
      ctx.afterCommit(() =>
        rememberRecentPatient((ctx.principal as { userId: string }).userId, ctx.params.patientId),
      );
    return toDto("PatientDetail", await patientDetail(ctx.db, ctx.params.patientId));
  },

  async updatePatient(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    ctx.checkVersion(p.version);
    const data = patientColumns(ctx.body as Record<string, unknown>);
    if (
      data.ssnLast4 !== undefined &&
      data.ssnLast4 !== null &&
      !/^\d{4}$/.test(String(data.ssnLast4))
    ) {
      throw unprocessable("validation_failed", "Enter the last 4 digits.", {
        errors: [{ field: "ssnLast4", code: "pattern", message: "Enter 4 digits." }],
      });
    }
    await ctx.db.patient.update({
      where: { id: p.id },
      data: { ...(data as Prisma.PatientUncheckedUpdateInput), version: { increment: 1 } },
    });
    const detail = await patientDetail(ctx.db, p.id);
    await writeVersion(ctx.db, pid(ctx), "Patient", detail, ctx.staff().userId, "update");
    ctx.audit.resource("Patient", p.id);
    ctx.audit.detail({ fields: Object.keys(data) });
    return toDto("PatientDetail", detail);
  },

  async replacePatientAddresses(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    await ctx.db.patientAddress.deleteMany({ where: { patientId: p.id } });
    for (const a of ctx.body)
      await ctx.db.patientAddress.create({
        data: {
          ...a,
          practiceId: pid(ctx),
          patientId: p.id,
          periodStart: date(a.periodStart),
          periodEnd: date(a.periodEnd),
        },
      });
    await bumpPatientVersion(ctx, p.id, "addresses");
    return toDtos(
      "PatientAddress",
      await ctx.db.patientAddress.findMany({ where: { patientId: p.id } }),
    );
  },

  async replacePatientContactPoints(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const old = await ctx.db.patientContactPoint.findMany({ where: { patientId: p.id } });
    await ctx.db.patientContactPoint.deleteMany({ where: { patientId: p.id } });
    for (const c of ctx.body) {
      const data = contactData(pid(ctx), p.id, c);
      // TCPA opt-out (STOP) survives an edit of the same number.
      if (old.some((o) => o.valueIndex && o.valueIndex === data.valueIndex && o.smsOptOut))
        data.smsOptOut = true;
      await ctx.db.patientContactPoint.create({ data });
    }
    await bumpPatientVersion(ctx, p.id, "contactPoints");
    const rows = await ctx.db.patientContactPoint.findMany({
      where: { patientId: p.id },
      orderBy: [{ system: "asc" }, { rank: "asc" }],
    });
    const { decryptContact } = await import("./service.js");
    return toDtos("PatientContactPoint", rows.map(decryptContact));
  },

  async listRelatedPersons(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.relatedPerson.findMany({
      where: { patientId: p.id, active: true },
      orderBy: [{ isGuarantor: "desc" }, { lastName: "asc" }],
    });
    return toDtos("RelatedPerson", rows.map(decryptRelated));
  },

  async createRelatedPerson(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    const rp = await ctx.db.relatedPerson.create({
      data: {
        ...b,
        ...relatedData(b),
        practiceId: pid(ctx),
        patientId: p.id,
        birthDate: date(b.birthDate),
        address: (b.address ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    if (b.isGuarantor) {
      await ctx.db.relatedPerson.updateMany({
        where: { patientId: p.id, id: { not: rp.id } },
        data: { isGuarantor: false },
      });
      await ctx.db.patient.update({
        where: { id: p.id },
        data: { guarantorRelatedPersonId: rp.id, version: { increment: 1 } },
      });
    }
    ctx.audit.resource("RelatedPerson", rp.id);
    return toDto("RelatedPerson", decryptRelated(rp));
  },

  async updateRelatedPerson(ctx) {
    const rp = await ctx.db.relatedPerson.findUnique({ where: { id: ctx.params.relatedPersonId } });
    if (!rp) throw notFound();
    await requirePatient(ctx, rp.patientId);
    const b = ctx.body;
    const updated = await ctx.db.relatedPerson.update({
      where: { id: rp.id },
      data: {
        ...b,
        ...relatedData(b),
        birthDate: date(b.birthDate),
        address:
          b.address === undefined ? undefined : ((b.address ?? null) as Prisma.InputJsonValue),
      },
    });
    if (b.isGuarantor) {
      await ctx.db.relatedPerson.updateMany({
        where: { patientId: rp.patientId, id: { not: rp.id } },
        data: { isGuarantor: false },
      });
      await ctx.db.patient.update({
        where: { id: rp.patientId },
        data: { guarantorRelatedPersonId: rp.id },
      });
    }
    ctx.audit.resource("RelatedPerson", rp.id);
    return toDto("RelatedPerson", decryptRelated(updated));
  },

  async getPatientBanner(ctx) {
    // INV-ID-01: the identity banner renders for every chart, restricted or not.
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    ctx.audit.resource("Patient", p.id);
    if (ctx.principal?.kind === "staff")
      ctx.afterCommit(() =>
        rememberRecentPatient((ctx.principal as { userId: string }).userId, p.id),
      );
    const extras = await bannerExtras(ctx.db, p);
    return {
      id: p.id,
      mrn: p.mrn,
      name: displayName(p),
      ...(p.preferredName ? { preferredName: p.preferredName } : {}),
      ...(p.pronouns ? { pronouns: p.pronouns } : {}),
      birthDate: p.birthDate.toISOString().slice(0, 10),
      age: ageText(p.birthDate, new Date(), p.deceasedAt),
      ...(p.sexForClinicalUse ? { sexForClinicalUse: p.sexForClinicalUse } : {}),
      ...(p.photoFileId ? { photoFileId: p.photoFileId } : {}),
      allergies: extras.allergies,
      noKnownAllergies: p.noKnownAllergies,
      ...(p.codeStatus ? { codeStatus: p.codeStatus } : {}),
      ...(extras.pcp ? { pcp: extras.pcp } : {}),
      ...(extras.primaryCoverage ? { primaryCoverage: extras.primaryCoverage } : {}),
      ...(extras.eligibility ? { eligibility: extras.eligibility } : {}),
      balance: extras.balance,
      ...(p.preferredLanguage ? { preferredLanguage: p.preferredLanguage } : {}),
      interpreterNeeded: p.interpreterNeeded,
      flags: [...patientFlags(p), ...extras.flags],
      restricted:
        p.securityLabels.some((l) => RESTRICTED_LABELS.includes(l)) || extras.restrictedRows > 0,
      part2: p.securityLabels.includes("42CFRPart2") || extras.part2Rows > 0,
    };
  },

  async requestEmergencyAccess(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const me = ctx.staff();
    const b = ctx.body;
    if (b.reason.trim().length < 10) {
      throw unprocessable("validation_failed", "Describe why you need access.", {
        errors: [
          { field: "reason", code: "minLength", message: "Give at least a short sentence." },
        ],
      });
    }
    const maxMinutes = Number(
      (await ctx.db.practiceSetting.findFirst({ where: { key: "security.breakGlassMinutes" } }))
        ?.value ?? 60,
    );
    const minutes = Math.min(Math.max(5, b.durationMinutes), maxMinutes);
    const labels = await restrictedLabelsFor(ctx.db, p.id, p.securityLabels);
    const grant = await ctx.db.emergencyAccessGrant.create({
      data: {
        practiceId: pid(ctx),
        userId: me.userId,
        patientId: p.id,
        reasonCode: b.reasonCategory === "continuity" ? "treatment-continuity" : b.reasonCategory,
        reasonText: b.reason.trim(),
        scope: labels.length ? labels : ["R"],
        expiresAt: new Date(Date.now() + minutes * 60_000),
      },
    });
    ctx.audit.resource("EmergencyAccessGrant", grant.id);
    ctx.audit.purpose("ETREAT", grant.id);
    // Privacy officer alert (managers), no PHI in the title.
    await notifyRole(ctx.db, pid(ctx), "MANAGER", {
      type: "EMERGENCY_ACCESS",
      title: `Break-the-glass access by ${me.role} needs review`,
      linkRoute: "/admin/audit-log?view=break-glass",
    });
    return toDto("EmergencyAccessGrant", grant);
  },

  async listPatientAccessLog(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const q = ctx.query;
    const limit = limitOf(q);
    const rows = await ctx.db.auditEvent.findMany({
      where: {
        patientId: p.id,
        ...(q.action ? { action: q.action } : {}),
        ...(q.fromDate || q.toDate
          ? {
              at: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lt: new Date(new Date(q.toDate).getTime() + 86_400_000) } : {}),
              },
            }
          : {}),
        ...(q.cursor ? { id: { lt: BigInt(q.cursor) } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    return auditPage(ctx.db, rows, limit);
  },

  async listDisclosures(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const rows = await ctx.db.disclosureLog.findMany({
      where: { patientId: p.id },
      orderBy: { disclosedAt: "desc" },
      take: 500,
    });
    return { data: toDtos("DisclosureLog", rows), nextCursor: null, hasMore: false };
  },

  async recordDisclosure(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const b = ctx.body;
    const row = await ctx.db.disclosureLog.create({
      data: {
        ...b,
        practiceId: pid(ctx),
        patientId: p.id,
        disclosedAt: b.disclosedAt ? new Date(b.disclosedAt) : new Date(),
        recordedById: ctx.staff().userId,
      },
    });
    ctx.audit.resource("DisclosureLog", row.id);
    return toDto("DisclosureLog", row);
  },

  async createAmendmentRequest(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId, { identityOnly: true });
    const b = ctx.body;
    const receivedAt = b.receivedAt ? new Date(b.receivedAt) : new Date();
    const row = await ctx.db.amendmentRequest.create({
      data: {
        practiceId: pid(ctx),
        patientId: p.id,
        requestText: b.requestText,
        targetType: b.targetType ?? null,
        targetId: b.targetId ?? null,
        receivedAt,
        // §164.526(b)(2): act within 60 days of receipt.
        dueBy: new Date(receivedAt.getTime() + 60 * 86_400_000),
      },
    });
    ctx.audit.resource("AmendmentRequest", row.id);
    return toDto("AmendmentRequest", row);
  },

  async listAmendmentRequests(ctx) {
    const rows = await ctx.db.amendmentRequest.findMany({
      where: ctx.query.status?.length ? { status: { in: ctx.query.status as never } } : {},
      orderBy: { dueBy: "asc" },
      take: 500,
    });
    return { data: toDtos("AmendmentRequest", rows), nextCursor: null, hasMore: false };
  },

  async decideAmendmentRequest(ctx) {
    const row = await ctx.db.amendmentRequest.findUnique({
      where: { id: ctx.params.amendmentRequestId },
    });
    if (!row) throw notFound();
    ctx.audit.patient(row.patientId);
    if (row.status !== "RECEIVED")
      throw conflict("already_decided", "This request was already answered.");
    if (!ctx.body.explanation.trim())
      throw unprocessable("validation_failed", "Write the response to the patient.", {
        errors: [{ field: "explanation", code: "required", message: "Required." }],
      });
    const updated = await ctx.db.amendmentRequest.update({
      where: { id: row.id },
      data: {
        status: ctx.body.decision === "accept" ? "ACCEPTED" : "DENIED",
        responseText: ctx.body.explanation,
        decidedById: ctx.staff().userId,
        decidedAt: new Date(),
      },
    });
    ctx.audit.resource("AmendmentRequest", row.id);
    return toDto("AmendmentRequest", updated);
  },

  // ------------------------------------------------------------------ duplicates and merge (INV-ID-04)
  async listDuplicateCandidates(ctx) {
    const rows = await ctx.db.duplicateCandidate.findMany({
      where: { status: { in: (ctx.query.status?.length ? ctx.query.status : ["OPEN"]) as never } },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: limitOf(ctx.query) + 1,
      skip: cursorOffset(ctx.query.cursor),
    });
    const limit = limitOf(ctx.query);
    const views = await candidateViews(ctx.db, rows.slice(0, limit));
    return {
      data: views,
      nextCursor: rows.length > limit ? String(cursorOffset(ctx.query.cursor) + limit) : null,
      hasMore: rows.length > limit,
    };
  },

  async getDuplicateComparison(ctx) {
    const c = await ctx.db.duplicateCandidate.findUnique({
      where: { id: ctx.params.duplicateCandidateId },
    });
    if (!c) throw notFound();
    const [view] = await candidateViews(ctx.db, [c]);
    const [a, b] = await Promise.all([
      patientDetail(ctx.db, c.patientAId),
      patientDetail(ctx.db, c.patientBId),
    ]);
    const [rawA, rawB] = await Promise.all([
      ctx.db.patientContactPoint.findMany({ where: { patientId: c.patientAId } }),
      ctx.db.patientContactPoint.findMany({ where: { patientId: c.patientBId } }),
    ]);
    const fields = [
      ...MERGEABLE_FIELDS.map((f) => {
        const av = fieldText((a as Record<string, unknown>)[f]);
        const bv = fieldText((b as Record<string, unknown>)[f]);
        return {
          field: f,
          ...(av !== undefined ? { a: av } : {}),
          ...(bv !== undefined ? { b: bv } : {}),
          same: av === bv,
        };
      }),
      {
        field: "phone",
        a: primaryPhone(rawA) ?? undefined,
        b: primaryPhone(rawB) ?? undefined,
        same: false,
      },
    ].map((f) => (f.field === "phone" ? { ...f, same: f.a === f.b } : f));
    const recordCounts = await Promise.all(
      [
        "Appointment",
        "Encounter",
        "Condition",
        "MedicationStatement",
        "AllergyIntolerance",
        "Observation",
        "DocumentReference",
        "Coverage",
        "ChargeItem",
      ].map(async (type) => {
        const delegate = (
          ctx.db as unknown as Record<string, { count(a: object): Promise<number> }>
        )[type[0]!.toLowerCase() + type.slice(1)]!;
        const [na, nb] = await Promise.all([
          delegate.count({ where: { patientId: c.patientAId } }),
          delegate.count({ where: { patientId: c.patientBId } }),
        ]);
        return { type, a: na, b: nb };
      }),
    );
    ctx.audit.patient(c.patientAId);
    ctx.audit.add({
      action: "READ",
      patientId: c.patientBId,
      resourceType: "Patient",
      resourceId: c.patientBId,
    });
    return { candidate: view!, fields, recordCounts };
  },

  async mergePatients(ctx) {
    const c = await ctx.db.duplicateCandidate.findUnique({
      where: { id: ctx.params.duplicateCandidateId },
    });
    if (!c) throw notFound();
    if (c.status !== "OPEN" && c.status !== "UNMERGED")
      throw conflict("invalid_transition", "This pair was already resolved.");
    const b = ctx.body;
    const pair = [c.patientAId, c.patientBId];
    if (!pair.includes(b.survivorId) || !pair.includes(b.mergedId) || b.survivorId === b.mergedId) {
      throw unprocessable("validation_failed", "Pick one record to keep and the other to merge.");
    }
    if (!b.reason?.trim())
      throw unprocessable("validation_failed", "Record why these are the same person.", {
        errors: [{ field: "reason", code: "required", message: "Required." }],
      });
    const survivor = await ctx.db.patient.findUniqueOrThrow({ where: { id: b.survivorId } });
    const merged = await ctx.db.patient.findUniqueOrThrow({ where: { id: b.mergedId } });
    if (survivor.mergedIntoId || merged.mergedIntoId)
      throw conflict("merged", "One of these records is already merged.");
    ctx.checkVersion(survivor.version, b.version);
    const me = ctx.staff();

    // Field choices: take the merged record's value where chosen; remember the survivor's old value for unmerge.
    const aIsSurvivor = c.patientAId === b.survivorId;
    const changes: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const choice of b.fieldChoices) {
      if (!(MERGEABLE_FIELDS as readonly string[]).includes(choice.field)) continue;
      const fromSurvivor = (choice.from === "a") === aIsSurvivor;
      if (fromSurvivor) continue;
      previous[choice.field] = (survivor as Record<string, unknown>)[choice.field] ?? null;
      changes[choice.field] = (merged as Record<string, unknown>)[choice.field] ?? null;
    }

    // Repoint mutable patient-scoped rows; append-only rows (ledger, audit, disclosures...) stay and are read
    // through mergedIntoId. Every moved id is recorded so the merge can be undone exactly.
    const moved: Array<{ type: string; ids: string[] }> = [];
    for (const model of movableModels()) {
      const delegate = delegateFor(ctx.db, model);
      let rows = (await delegate.findMany({
        where: { patientId: merged.id },
        select: { id: true },
      })) as Array<{ id: string }>;
      if (model === "PortalAccess") {
        const taken = new Set(
          (
            (await ctx.db.portalAccess.findMany({
              where: { patientId: survivor.id },
              select: { portalUserId: true },
            })) as Array<{ portalUserId: string }>
          ).map((r) => r.portalUserId),
        );
        const all = await ctx.db.portalAccess.findMany({ where: { patientId: merged.id } });
        rows = all.filter((r) => !taken.has(r.portalUserId)).map((r) => ({ id: r.id }));
      }
      if (!rows.length) continue;
      await delegate.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { patientId: survivor.id },
      });
      moved.push({ type: model, ids: rows.map((r) => r.id) });
    }
    if (Object.keys(changes).length) {
      await ctx.db.patient.update({
        where: { id: survivor.id },
        data: { ...(changes as Prisma.PatientUncheckedUpdateInput), version: { increment: 1 } },
      });
    } else {
      await ctx.db.patient.update({
        where: { id: survivor.id },
        data: { version: { increment: 1 } },
      });
    }
    await ctx.db.patient.update({
      where: { id: merged.id },
      data: { mergedIntoId: survivor.id, active: false, version: { increment: 1 } },
    });
    const record = await ctx.db.patientMerge.create({
      data: {
        practiceId: pid(ctx),
        survivorId: survivor.id,
        mergedId: merged.id,
        fieldChoices: {
          choices: b.fieldChoices,
          previous,
          reason: b.reason,
        } as Prisma.InputJsonValue,
        movedRecords: moved as unknown as Prisma.InputJsonValue,
        mergedById: me.userId,
      },
    });
    await ctx.db.duplicateCandidate.update({
      where: { id: c.id },
      data: { status: "MERGED", resolvedById: me.userId, resolvedAt: new Date() },
    });
    await writeVersion(
      ctx.db,
      pid(ctx),
      "Patient",
      await ctx.db.patient.findUniqueOrThrow({ where: { id: survivor.id } }),
      me.userId,
      "merge",
    );
    await writeVersion(
      ctx.db,
      pid(ctx),
      "Patient",
      await ctx.db.patient.findUniqueOrThrow({ where: { id: merged.id } }),
      me.userId,
      "merged-into",
    );
    ctx.audit.patient(survivor.id);
    ctx.audit.resource("PatientMerge", record.id);
    ctx.audit.detail({
      movedTypes: moved.map((m) => m.type),
      moved: moved.reduce((n, m) => n + m.ids.length, 0),
    });
    ctx.audit.add({
      action: "MERGE",
      patientId: merged.id,
      resourceType: "PatientMerge",
      resourceId: record.id,
    });
    return toDto("PatientMerge", record);
  },

  async unmergePatients(ctx) {
    const m = await ctx.db.patientMerge.findUnique({ where: { id: ctx.params.patientMergeId } });
    if (!m) throw notFound();
    if (m.unmergedAt) throw conflict("invalid_transition", "This merge was already undone.");
    const me = ctx.staff();
    for (const group of m.movedRecords as Array<{ type: string; ids: string[] }>) {
      await delegateFor(ctx.db, group.type).updateMany({
        where: { id: { in: group.ids }, patientId: m.survivorId },
        data: { patientId: m.mergedId },
      });
    }
    const previous = ((m.fieldChoices as { previous?: Record<string, unknown> }).previous ??
      {}) as Record<string, unknown>;
    const restore: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(previous))
      restore[k] = k === "birthDate" && typeof v === "string" ? new Date(v) : v;
    await ctx.db.patient.update({
      where: { id: m.survivorId },
      data: { ...(restore as Prisma.PatientUncheckedUpdateInput), version: { increment: 1 } },
    });
    await ctx.db.patient.update({
      where: { id: m.mergedId },
      data: { mergedIntoId: null, active: true, version: { increment: 1 } },
    });
    const updated = await ctx.db.patientMerge.update({
      where: { id: m.id },
      data: { unmergedById: me.userId, unmergedAt: new Date() },
    });
    const [a, b] = [m.survivorId, m.mergedId].sort();
    await ctx.db.duplicateCandidate.updateMany({
      where: { patientAId: a!, patientBId: b! },
      data: { status: "UNMERGED", resolvedById: me.userId, resolvedAt: new Date() },
    });
    ctx.audit.patient(m.survivorId);
    ctx.audit.resource("PatientMerge", m.id);
    ctx.audit.add({
      action: "MERGE",
      patientId: m.mergedId,
      resourceType: "PatientMerge",
      resourceId: m.id,
      detail: { undo: true },
    });
    return toDto("PatientMerge", updated);
  },

  async dismissDuplicate(ctx) {
    const c = await ctx.db.duplicateCandidate.findUnique({
      where: { id: ctx.params.duplicateCandidateId },
    });
    if (!c) throw notFound();
    if (c.status === "MERGED")
      throw conflict("invalid_transition", "These records are merged. Undo the merge first.");
    await ctx.db.duplicateCandidate.update({
      where: { id: c.id },
      data: { status: "NOT_DUPLICATE", resolvedById: ctx.staff().userId, resolvedAt: new Date() },
    });
    ctx.audit.patient(c.patientAId);
    ctx.audit.resource("DuplicateCandidate", c.id);
  },

  async listRecentPatients(ctx) {
    const ids = await recentPatientIds(ctx.staff().userId);
    const rows = await summaries(ctx.db, ids);
    return rows.filter((r) => !r.flags.includes("merged"));
  },
};

async function bumpPatientVersion(ctx: Ctx, patientId: string, part: string) {
  const p = await ctx.db.patient.update({
    where: { id: patientId },
    data: { version: { increment: 1 } },
  });
  await writeVersion(
    ctx.db,
    pid(ctx),
    "Patient",
    await patientDetail(ctx.db, p.id),
    ctx.staff().userId,
    `update ${part}`,
  );
  ctx.audit.resource("Patient", patientId);
  ctx.audit.detail({ fields: [part] });
}

async function restrictedLabelsFor(
  tx: Tx,
  patientId: string,
  patientLabels: string[],
): Promise<string[]> {
  const labels = new Set(patientLabels.filter((l) => RESTRICTED_LABELS.includes(l)));
  const notes = await tx.clinicalNote.findMany({
    where: { patientId, NOT: { securityLabels: { isEmpty: true } } },
    select: { securityLabels: true },
  });
  for (const n of notes)
    for (const l of n.securityLabels) if (RESTRICTED_LABELS.includes(l)) labels.add(l);
  return [...labels];
}

async function candidateViews(
  tx: Tx,
  rows: Array<{
    id: string;
    score: number;
    status: "OPEN" | "MERGED" | "NOT_DUPLICATE" | "UNMERGED";
    patientAId: string;
    patientBId: string;
    matchedOn: string[];
    createdAt: Date;
  }>,
) {
  const ids = [...new Set(rows.flatMap((r) => [r.patientAId, r.patientBId]))];
  const [pts, merges] = await Promise.all([
    tx.patient.findMany({ where: { id: { in: ids } }, include: { contactPoints: true } }),
    tx.patientMerge.findMany({
      where: { unmergedAt: null, survivorId: { in: ids }, mergedId: { in: ids } },
    }),
  ]);
  const by = new Map(pts.map((p) => [p.id, toSummary(p)]));
  return rows
    .filter((r) => by.has(r.patientAId) && by.has(r.patientBId))
    .map((r) => {
      const m =
        r.status === "MERGED"
          ? merges.find(
              (x) =>
                [x.survivorId, x.mergedId].includes(r.patientAId) &&
                [x.survivorId, x.mergedId].includes(r.patientBId),
            )
          : undefined;
      return {
        id: r.id,
        score: r.score,
        status: r.status,
        a: by.get(r.patientAId)!,
        b: by.get(r.patientBId)!,
        matchedOn: r.matchedOn,
        createdAt: r.createdAt.toISOString(),
        ...(m ? { mergeId: m.id, survivorId: m.survivorId } : {}),
      };
    });
}

/** Mutable models that carry patientId (schema tags): everything patient-scoped except append-only tables. */
function movableModels(): string[] {
  const tags = schemaTags as { patientScoped: string[]; appendOnly: string[] };
  return tags.patientScoped.filter(
    (m) =>
      !tags.appendOnly.includes(m) &&
      !["DuplicateCandidate", "PatientMerge", "StagedChange"].includes(m),
  );
}

function delegateFor(tx: Tx, model: string) {
  return (
    tx as unknown as Record<
      string,
      { findMany(a: object): Promise<unknown[]>; updateMany(a: object): Promise<unknown> }
    >
  )[model[0]!.toLowerCase() + model.slice(1)]!;
}

export { primaryEmail, parseDate };
