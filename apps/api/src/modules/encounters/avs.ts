import type { AfterVisitSummary, Encounter, Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import { binary, type HandlerMap } from "../../platform/http/context.js";
import { renderPdf } from "../../platform/pdf.js";
import { conflict, validationFailed } from "../../platform/problem.js";
import { localParts, practiceTimeZone } from "../../platform/time.js";
import { LOINC } from "../clinical/domain.js";
import { buildBanner } from "../patients/banner.js";
import { practitionerName } from "../scheduling/views.js";
import { loadEncounter } from "./access.js";
import { encounterTitle } from "./notes/service.js";

/**
 * After-visit summary (encounter.avs, schedule.checkout). Plain language, generated from the visit: reason,
 * diagnoses, vitals, medication changes, follow-up and the provider's instructions. The content is rebuilt on every
 * read until it is released, so it always matches the chart; release freezes it (flow:encounter/08).
 */

export const AVS_LANGUAGES = ["en", "es"] as const;

export interface AvsContent {
  visit: { title: string; date: string; provider: string; location: string | null };
  reason: string | null;
  diagnoses: string[];
  vitals: Array<{ label: string; value: string }>;
  medications: { current: string[]; started: string[]; stopped: string[] };
  allergies: string[];
  followUp: string | null;
}

async function buildContent(tx: Tx, enc: Encounter): Promise<AvsContent> {
  const tz = await practiceTimeZone(tx);
  const since = enc.periodStart ?? enc.createdAt;
  const [practitioner, location, dx, meds, allergies, vitals, title] = await Promise.all([
    tx.practitioner.findUnique({ where: { id: enc.practitionerId } }),
    enc.locationId ? tx.location.findUnique({ where: { id: enc.locationId } }) : null,
    tx.condition.findMany({
      where: {
        encounterId: enc.id,
        category: "ENCOUNTER_DIAGNOSIS",
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
      orderBy: { rank: "asc" },
    }),
    tx.medicationStatement.findMany({
      where: { patientId: enc.patientId, stagingStatus: "ACTIVE" },
      orderBy: { display: "asc" },
    }),
    tx.allergyIntolerance.findMany({
      where: {
        patientId: enc.patientId,
        clinicalStatus: "ACTIVE",
        stagingStatus: "ACTIVE",
        verificationStatus: { not: "ENTERED_IN_ERROR" },
      },
    }),
    tx.observation.findMany({
      where: { encounterId: enc.id, category: "VITAL_SIGNS", stagingStatus: "ACTIVE" },
      orderBy: { effectiveAt: "asc" },
    }),
    encounterTitle(tx, enc),
  ]);
  const med = (m: (typeof meds)[number]) =>
    m.dosageText ? `${m.display} — ${m.dosageText}` : m.display;
  const active = meds.filter((m) => m.status === "ACTIVE");
  const latest = new Map<string, (typeof vitals)[number]>();
  for (const v of vitals) latest.set(v.loincCode, v);
  const vital = (code: string, label: string, fmt: (v: (typeof vitals)[number]) => string) => {
    const v = latest.get(code);
    return v ? [{ label, value: fmt(v) }] : [];
  };
  const q = (v: (typeof vitals)[number]) => v.valueQuantity?.toString() ?? "";
  return {
    visit: {
      title,
      date: localParts(since, tz).date,
      provider: practitioner ? practitionerName(practitioner) : "",
      location: location?.name ?? null,
    },
    reason: enc.chiefComplaint ?? null,
    diagnoses: dx.map((d) => d.display),
    vitals: [
      ...vital(LOINC.bpPanel, "Blood pressure", (v) => `${v.valueString} mmHg`),
      ...vital(LOINC.heartRate, "Pulse", (v) => `${q(v)} /min`),
      ...vital(
        LOINC.temperature,
        "Temperature",
        (v) => `${q(v)} ${v.valueUnit === "Cel" ? "°C" : "°F"}`,
      ),
      ...vital(LOINC.weight, "Weight", (v) => `${Math.round(Number(q(v)) * 2.20462 * 10) / 10} lb`),
      ...vital(LOINC.bmi, "BMI", q),
      ...vital(LOINC.spo2, "Oxygen", (v) => `${q(v)}%`),
    ],
    medications: {
      current: active.map(med),
      started: active.filter((m) => m.createdAt >= since).map(med),
      stopped: meds
        .filter((m) => m.status === "STOPPED" && m.updatedAt >= since)
        .map((m) => m.display),
    },
    allergies: allergies.map((a) => a.substanceDisplay),
    followUp: enc.followUpInstruction ?? null,
  };
}

/** The visit's AVS, created on first use and refreshed until released. */
export async function ensureAvs(tx: Tx, enc: Encounter): Promise<AfterVisitSummary> {
  // Serialised per encounter (held to commit): concurrent first reads must not create two summaries.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`avs:${enc.id}`}))`;
  const existing = await tx.afterVisitSummary.findFirst({ where: { encounterId: enc.id } });
  if (existing?.releasedAt) return existing;
  const content = (await buildContent(tx, enc)) as unknown as object;
  if (existing)
    return tx.afterVisitSummary.update({ where: { id: existing.id }, data: { content } });
  return tx.afterVisitSummary.create({
    data: { practiceId: enc.practiceId, encounterId: enc.id, patientId: enc.patientId, content },
  });
}

const LABELS = {
  en: {
    title: "After-visit summary",
    reason: "Why you came in",
    diagnoses: "What we found",
    vitals: "Your measurements today",
    instructions: "What to do next",
    followUp: "Follow-up",
    started: "Medicines started today",
    stopped: "Medicines to stop",
    current: "Your medicine list",
    allergies: "Allergies on file",
    none: "None",
    footer: "Questions? Message us through the patient portal or call the office.",
  },
  es: {
    title: "Resumen de la visita",
    reason: "Motivo de la visita",
    diagnoses: "Lo que encontramos",
    vitals: "Sus mediciones de hoy",
    instructions: "Qué hacer ahora",
    followUp: "Seguimiento",
    started: "Medicamentos que empezó hoy",
    stopped: "Medicamentos que debe dejar",
    current: "Su lista de medicamentos",
    allergies: "Alergias registradas",
    none: "Ninguno",
    footer: "¿Preguntas? Escríbanos por el portal del paciente o llame al consultorio.",
  },
} as const;

export const avsHandlers: HandlerMap = {
  async getAfterVisitSummary(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const avs = await ensureAvs(ctx.db, enc);
    ctx.audit.resource("AfterVisitSummary", avs.id);
    return toDto("AfterVisitSummary", avs);
  },

  async updateAfterVisitSummary(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const avs = await ensureAvs(ctx.db, enc);
    if (avs.releasedAt)
      throw conflict("avs_released", "This summary was already released to the patient.");
    const b = ctx.body;
    if (b.language && !(AVS_LANGUAGES as readonly string[]).includes(b.language))
      throw validationFailed([
        { field: "language", code: "invalid", message: "Choose English or Spanish." },
      ]);
    const row = await ctx.db.afterVisitSummary.update({
      where: { id: avs.id },
      data: {
        ...(b.language ? { language: b.language } : {}),
        ...(b.instructions !== undefined
          ? { instructions: b.instructions?.slice(0, 20_000) ?? null }
          : {}),
        ...(b.educationIds ? { educationIds: b.educationIds } : {}),
      },
    });
    ctx.audit.resource("AfterVisitSummary", row.id);
    return toDto("AfterVisitSummary", row);
  },

  async releaseAfterVisitSummary(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const signed = await ctx.db.clinicalNote.findFirst({
      where: { encounterId: enc.id, status: { in: ["SIGNED", "ADDENDED", "PENDING_COSIGN"] } },
    });
    if (!signed)
      throw conflict("note_not_signed", "Sign the visit note before releasing the summary.");
    const avs = await ensureAvs(ctx.db, enc);
    const row = avs.releasedAt
      ? avs
      : await ctx.db.afterVisitSummary.update({
          where: { id: avs.id },
          data: { releasedAt: new Date() },
        });
    ctx.audit.resource("AfterVisitSummary", row.id);
    return toDto("AfterVisitSummary", row);
  },

  async getAfterVisitSummaryPdf(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    const avs = await ensureAvs(ctx.db, enc);
    const c = avs.content as unknown as AvsContent;
    const L =
      LABELS[(avs.language as "en" | "es") in LABELS ? (avs.language as "en" | "es") : "en"];
    const [patient, practice] = await Promise.all([
      ctx.db.patient.findUniqueOrThrow({ where: { id: enc.patientId } }),
      ctx.db.practice.findUniqueOrThrow({ where: { id: enc.practiceId } }),
    ]);
    const banner = await buildBanner(ctx.db, patient);
    const pdf = await renderPdf(
      {
        title: `${L.title} · ${c.visit.date}`,
        patientLine: `${banner.name} · DOB ${banner.birthDate} · MRN ${banner.mrn}`,
        practiceName: practice.legalName,
      },
      (w) => {
        w.paragraph(
          `${c.visit.title} · ${c.visit.provider}${c.visit.location ? ` · ${c.visit.location}` : ""}`,
        );
        if (c.reason) {
          w.subheading(L.reason);
          w.paragraph(c.reason);
        }
        w.subheading(L.diagnoses);
        w.list(c.diagnoses);
        if (c.vitals.length) {
          w.subheading(L.vitals);
          w.keyValue(c.vitals.map((v) => [v.label, v.value]));
        }
        if (avs.instructions?.trim()) {
          w.subheading(L.instructions);
          w.paragraph(avs.instructions);
        }
        if (c.followUp) {
          w.subheading(L.followUp);
          w.paragraph(c.followUp);
        }
        if (c.medications.started.length) {
          w.subheading(L.started);
          w.list(c.medications.started);
        }
        if (c.medications.stopped.length) {
          w.subheading(L.stopped);
          w.list(c.medications.stopped);
        }
        w.subheading(L.current);
        w.list(c.medications.current);
        w.subheading(L.allergies);
        w.list(c.allergies.length ? c.allergies : [L.none]);
        w.spacer();
        w.muted(L.footer);
      },
    );
    await ctx.db.afterVisitSummary.update({
      where: { id: avs.id },
      data: { printedAt: new Date() },
    });
    return binary("application/pdf", pdf, `after-visit-summary-${c.visit.date}.pdf`);
  },
};
