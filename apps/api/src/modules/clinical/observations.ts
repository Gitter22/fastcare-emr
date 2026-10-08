import { POC_TESTS, type ObservationTrend, type VitalsInput, cToF } from "@agile-emr/shared";
import type { Observation, ObservationCategory, Prisma, ResultFlag, Tx } from "../../db.js";
import { limitOf, page, toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { unprocessable, validationFailed } from "../../platform/problem.js";
import { settingValue } from "../../platform/settings.js";
import { writeVersion } from "../../platform/versioning.js";
import { loadEncounter } from "../encounters/access.js";
import { assertEncounterOpen } from "./conditions.js";
import {
  type AlertRanges,
  DEFAULT_ALERT_RANGES,
  LOINC,
  PLAUSIBLE,
  VITAL_DISPLAY,
  bmi,
  isAlertRanges,
  vitalAlerts,
} from "./domain.js";
import { recordProvenance } from "./provenance.js";

/** Vitals, flowsheets, social history and point-of-care results (chart.vitals, encounter.rooming). */

export const alertRanges = (tx: Tx) =>
  settingValue<AlertRanges>(tx, "vitals.alertRanges", DEFAULT_ALERT_RANGES, isAlertRanges);

const num = (v: Prisma.Decimal | null) => (v == null ? null : v.toNumber());

/** Systolic or diastolic of a BP panel, else the quantity. */
export function observationValue(o: Observation, code?: string): number | null {
  if (o.loincCode === LOINC.bpPanel) {
    const c = (o.components ?? {}) as { systolic?: number; diastolic?: number };
    if (code === LOINC.diastolic) return c.diastolic ?? null;
    return c.systolic ?? null;
  }
  return num(o.valueQuantity);
}

/** Latest active observation per code for a patient, optionally before a moment (last visit's values). */
export async function latestByCode(
  tx: Tx,
  patientId: string,
  codes: readonly string[],
  where: Prisma.ObservationWhereInput = {},
): Promise<Observation[]> {
  const rows = await tx.observation.findMany({
    where: {
      patientId,
      loincCode: { in: [...codes] },
      stagingStatus: "ACTIVE",
      status: { not: "CANCELLED" },
      ...where,
    },
    orderBy: { effectiveAt: "desc" },
    take: 200,
  });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.loincCode) ? false : (seen.add(r.loincCode), true)));
}

function checkPlausible(b: VitalsInput) {
  const errors: Array<{ field: string; code: string; message: string }> = [];
  const range = (
    field: keyof VitalsInput,
    v: number | undefined,
    [lo, hi]: readonly [number, number],
    label: string,
  ) => {
    if (v == null) return;
    if (!Number.isFinite(v) || v < lo || v > hi)
      errors.push({
        field,
        code: "out_of_range",
        message: `${label} must be between ${lo} and ${hi}.`,
      });
  };
  range("systolic", b.systolic, PLAUSIBLE.systolic, "Systolic");
  range("diastolic", b.diastolic, PLAUSIBLE.diastolic, "Diastolic");
  range("heartRate", b.heartRate, PLAUSIBLE.heartRate, "Pulse");
  range("respiratoryRate", b.respiratoryRate, PLAUSIBLE.respiratoryRate, "Respiratory rate");
  range("spo2", b.spo2, PLAUSIBLE.spo2, "SpO₂");
  range("heightCm", b.heightCm, PLAUSIBLE.heightCm, "Height (cm)");
  range("weightKg", b.weightKg, PLAUSIBLE.weightKg, "Weight (kg)");
  range("painScore", b.painScore, PLAUSIBLE.painScore, "Pain");
  range(
    "headCircumferenceCm",
    b.headCircumferenceCm,
    PLAUSIBLE.headCircumferenceCm,
    "Head circumference (cm)",
  );
  if (b.temperature != null) {
    const f = b.temperatureUnit === "cel" ? cToF(b.temperature) : b.temperature;
    range("temperature", f, PLAUSIBLE.temperatureF, "Temperature (°F)");
  }
  if ((b.systolic == null) !== (b.diastolic == null))
    errors.push({
      field: b.systolic == null ? "systolic" : "diastolic",
      code: "required",
      message: "Enter both numbers of the blood pressure.",
    });
  if (errors.length) throw validationFailed(errors);
}

export const observationHandlers: HandlerMap = {
  async listObservations(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(q);
    const where: Prisma.ObservationWhereInput = {
      patientId: ctx.params.patientId,
      stagingStatus: q.stagingStatus ?? "ACTIVE",
      status: { not: "CANCELLED" },
      ...(q.category ? { category: q.category as ObservationCategory } : {}),
      ...(q.loinc ? { loincCode: q.loinc } : {}),
      ...(q.fromDate || q.toDate
        ? {
            effectiveAt: {
              ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
              ...(q.toDate ? { lt: new Date(new Date(q.toDate).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
      ...(q.cursor ? { effectiveAt: { lt: new Date(q.cursor) } } : {}),
    };
    const rows = await ctx.db.observation.findMany({
      where,
      orderBy: [{ effectiveAt: "desc" }, { id: "asc" }],
      take: limit + 1,
    });
    ctx.audit.detail({ rows: rows.length });
    return page(
      rows,
      limit,
      (r) => toDto("Observation", r),
      (r) => r.effectiveAt.toISOString(),
    );
  },

  async getObservationTrend(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    if (!q.loinc) throw unprocessable("validation_failed", "Choose a measurement.");
    const bpPart = q.loinc === LOINC.systolic || q.loinc === LOINC.diastolic;
    const rows = await ctx.db.observation.findMany({
      where: {
        patientId: ctx.params.patientId,
        loincCode: bpPart ? LOINC.bpPanel : q.loinc,
        stagingStatus: "ACTIVE",
        status: { not: "CANCELLED" },
        ...(q.fromDate || q.toDate
          ? {
              effectiveAt: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(q.toDate) } : {}),
              },
            }
          : {}),
      },
      orderBy: { effectiveAt: "asc" },
      take: 500,
    });
    const ranges = await alertRanges(ctx.db);
    const range =
      q.loinc === LOINC.systolic
        ? `${ranges.systolic.low}-${ranges.systolic.high}`
        : q.loinc === LOINC.diastolic
          ? `${ranges.diastolic.low}-${ranges.diastolic.high}`
          : (rows.at(-1)?.referenceRangeText ?? undefined);
    const trend: ObservationTrend = {
      code: q.loinc,
      display:
        q.loinc === LOINC.systolic
          ? "Systolic blood pressure"
          : q.loinc === LOINC.diastolic
            ? "Diastolic blood pressure"
            : (rows[0]?.display ?? VITAL_DISPLAY[q.loinc] ?? q.loinc),
      ...(rows[0]?.valueUnit ? { unit: rows[0].valueUnit } : bpPart ? { unit: "mm[Hg]" } : {}),
      ...(range ? { referenceRange: range } : {}),
      points: rows
        .map((r) => ({ r, v: observationValue(r, q.loinc) }))
        .filter((x): x is { r: Observation; v: number } => x.v != null)
        .map(({ r, v }) => ({
          at: r.effectiveAt.toISOString(),
          value: v,
          ...(r.flag ? { flag: r.flag } : {}),
          observationId: r.id,
        })),
    };
    ctx.audit.detail({ points: trend.points.length });
    return trend;
  },

  async acceptObservations(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.observation.findMany({
      where: { id: { in: ctx.body.ids }, patientId: patient.id, stagingStatus: "STAGED" },
    });
    if (rows.length !== new Set(ctx.body.ids).size)
      throw unprocessable(
        "validation_failed",
        "Some readings were already reviewed or belong to another patient.",
      );
    const me = ctx.staff();
    for (const r of rows) {
      const row = await ctx.db.observation.update({
        where: { id: r.id },
        data: { stagingStatus: "ACTIVE", version: { increment: 1 } },
      });
      await writeVersion(ctx.db, row.practiceId, "Observation", row, me.userId, "reconcile-accept");
      await recordProvenance(ctx.db, row.practiceId, {
        targetType: "Observation",
        targetId: row.id,
        source: r.source,
        activity: "reconcile-accept",
        agentId: me.userId,
      });
    }
    ctx.audit.detail({ accepted: rows.length });
  },

  async recordVitals(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const b = ctx.body;
    checkPlausible(b);
    const any = [
      b.systolic,
      b.heartRate,
      b.respiratoryRate,
      b.temperature,
      b.spo2,
      b.heightCm,
      b.weightKg,
      b.painScore,
      b.headCircumferenceCm,
    ].some((v) => v != null);
    if (!any) throw unprocessable("validation_failed", "Enter at least one measurement.");
    const ranges = await alertRanges(ctx.db);
    const alerts = vitalAlerts(b, ranges);
    const me = ctx.staff();
    const at = b.takenAt ? new Date(b.takenAt) : new Date();
    const base = {
      practiceId: enc.practiceId,
      patientId: enc.patientId,
      encounterId: enc.id,
      category: "VITAL_SIGNS" as const,
      effectiveAt: at,
      performerId: me.practitionerId,
      note: b.note ?? null,
    };
    const flagFor = (prefix: string): ResultFlag | null =>
      alerts.some((a) => a.code.startsWith(prefix)) ? "ABNORMAL" : null;
    const interp = (prefix: string) =>
      alerts.find((a) => a.code.startsWith(prefix))?.code.endsWith("high")
        ? "H"
        : alerts.some((a) => a.code.startsWith(prefix))
          ? "L"
          : "N";
    const rows: Prisma.ObservationCreateManyInput[] = [];
    const q = (loinc: string, value: number | undefined, unit: string, prefix?: string) => {
      if (value == null) return;
      rows.push({
        ...base,
        loincCode: loinc,
        display: VITAL_DISPLAY[loinc]!,
        valueQuantity: value,
        valueUnit: unit,
        ...(prefix ? { flag: flagFor(prefix), interpretation: interp(prefix) } : {}),
      });
    };
    if (b.systolic != null && b.diastolic != null)
      rows.push({
        ...base,
        loincCode: LOINC.bpPanel,
        display: VITAL_DISPLAY[LOINC.bpPanel]!,
        valueString: `${b.systolic}/${b.diastolic}`,
        valueUnit: "mm[Hg]",
        components: {
          systolic: b.systolic,
          diastolic: b.diastolic,
          ...(b.position ? { position: b.position } : {}),
        },
        flag: flagFor("bp"),
        interpretation: interp("bp"),
      });
    q(LOINC.heartRate, b.heartRate, "/min", "hr");
    q(LOINC.respiratoryRate, b.respiratoryRate, "/min", "rr");
    q(LOINC.temperature, b.temperature, b.temperatureUnit === "cel" ? "Cel" : "[degF]", "temp");
    q(LOINC.spo2, b.spo2, "%", "spo2");
    q(LOINC.height, b.heightCm, "cm");
    q(LOINC.weight, b.weightKg, "kg");
    q(LOINC.pain, b.painScore, "{score}");
    q(LOINC.headCircumference, b.headCircumferenceCm, "cm");
    // BMI from this reading, else the latest height on file (height is not re-measured at every visit).
    let bmiValue: number | null = null;
    if (b.weightKg != null || b.heightCm != null) {
      const [lastHeight, lastWeight] = await Promise.all([
        b.heightCm == null ? latestByCode(ctx.db, enc.patientId, [LOINC.height]) : [],
        b.weightKg == null
          ? latestByCode(ctx.db, enc.patientId, [LOINC.weight], { encounterId: enc.id })
          : [],
      ]);
      bmiValue = bmi(
        b.weightKg ?? num(lastWeight[0]?.valueQuantity ?? null),
        b.heightCm ?? num(lastHeight[0]?.valueQuantity ?? null),
      );
      if (bmiValue != null) q(LOINC.bmi, bmiValue, "kg/m2");
    }
    const created: Observation[] = [];
    for (const data of rows) {
      const row = await ctx.db.observation.create({
        data: data as Prisma.ObservationUncheckedCreateInput,
      });
      await writeVersion(ctx.db, row.practiceId, "Observation", row, me.userId);
      created.push(row);
    }
    ctx.audit.detail({ observations: created.length, alerts: alerts.map((a) => a.code) });
    return {
      observations: toDtos("Observation", created),
      ...(bmiValue != null ? { bmi: bmiValue } : {}),
      alerts: alerts.map((a) => a.text),
    };
  },

  async recordSocialHistory(ctx) {
    const patient = await requirePatient(ctx, ctx.params.patientId);
    const b = ctx.body;
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The observation must be for this patient.");
    if (b.category !== "SOCIAL_HISTORY" && b.category !== "SDOH")
      throw unprocessable("validation_failed", "Record social history or SDOH observations here.");
    if (b.encounterId) {
      const enc = await loadEncounter(ctx, b.encounterId);
      if (enc.patientId !== patient.id)
        throw unprocessable("validation_failed", "That visit is for another patient.");
    }
    const me = ctx.staff();
    const row = await ctx.db.observation.create({
      data: {
        practiceId: patient.practiceId,
        patientId: patient.id,
        encounterId: b.encounterId ?? null,
        category: b.category,
        loincCode: b.loincCode,
        display: b.display,
        effectiveAt: new Date(b.effectiveAt),
        valueString: b.valueString ?? null,
        valueCode: b.valueCode ?? null,
        valueBoolean: b.valueBoolean ?? null,
        ...(b.valueQuantity != null
          ? { valueQuantity: b.valueQuantity, valueUnit: b.valueUnit ?? null }
          : {}),
        note: b.note ?? null,
        performerId: me.practitionerId,
      },
    });
    ctx.audit.resource("Observation", row.id);
    await writeVersion(ctx.db, row.practiceId, "Observation", row, me.userId);
    return toDto("Observation", row);
  },

  async recordPocResult(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const b = ctx.body;
    if (!/^\d{1,7}-\d$/.test(b.loinc)) throw unprocessable("validation_failed", "Choose the test.");
    if (!b.value?.trim())
      throw validationFailed([{ field: "value", code: "required", message: "Enter the result." }]);
    const numeric = /^-?\d+(\.\d+)?$/.test(b.value.trim()) ? Number(b.value) : null;
    const loinc = await ctx.db.codeConcept.findFirst({ where: { system: "LOINC", code: b.loinc } });
    const me = ctx.staff();
    const row = await ctx.db.observation.create({
      data: {
        practiceId: enc.practiceId,
        patientId: enc.patientId,
        encounterId: enc.id,
        category: "POINT_OF_CARE",
        loincCode: b.loinc,
        display:
          POC_TESTS.find((t) => t.loinc === b.loinc)?.display ??
          loinc?.shortDisplay ??
          loinc?.display ??
          b.loinc,
        effectiveAt: new Date(b.performedAt),
        ...(numeric != null
          ? { valueQuantity: numeric, valueUnit: b.unit ?? null }
          : { valueString: b.value.trim() }),
        flag: b.interpretation ?? null,
        note: b.lotNumber ? `Kit lot ${b.lotNumber}` : null,
        performerId: me.practitionerId,
      },
    });
    ctx.audit.resource("Observation", row.id);
    await writeVersion(ctx.db, row.practiceId, "Observation", row, me.userId);
    return toDto("Observation", row);
  },
};
