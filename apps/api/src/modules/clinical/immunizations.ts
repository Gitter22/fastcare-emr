import type { ImmunizationForecastItem } from "@agile-emr/shared";
import type { Immunization, Tx } from "../../db.js";
import { isoDate, toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { connectedGateways } from "../../platform/integrations.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { conflict, notFound, unprocessable, validationFailed } from "../../platform/problem.js";
import { practiceTimeZone, todayLocal } from "../../platform/time.js";
import { assertEncounterOpen } from "./conditions.js";
import { loadEncounter } from "../encounters/access.js";

/**
 * Immunizations and standing-order vaccines (flow:checkin/05). The forecast is a small rule set for the adult
 * schedule the practice runs under protocol (influenza, Td/Tdap, pneumococcal, zoster); registry forecasts replace
 * it once IisGateway is connected (source "iis"). Administration needs an unexpired lot with stock on hand.
 */

const GROUPS = {
  influenza: {
    name: "Influenza",
    cvx: [
      "140",
      "141",
      "150",
      "158",
      "171",
      "185",
      "186",
      "197",
      "205",
      "320",
      "135",
      "153",
      "168",
      "111",
      "149",
    ],
  },
  td: { name: "Td/Tdap", cvx: ["115", "113", "09", "138", "139"] },
  pneumococcal: {
    name: "Pneumococcal",
    cvx: ["133", "215", "216", "327", "33", "152", "100", "109"],
  },
  zoster: { name: "Zoster (recombinant)", cvx: ["187"] },
} as const;

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Age in whole years on a date. */
function ageOn(birth: Date, on: Date) {
  let a = on.getUTCFullYear() - birth.getUTCFullYear();
  if (
    on.getUTCMonth() < birth.getUTCMonth() ||
    (on.getUTCMonth() === birth.getUTCMonth() && on.getUTCDate() < birth.getUTCDate())
  )
    a--;
  return a;
}

/** Pure forecast over the patient's completed doses. `today` is the practice's local date (YYYY-MM-DD). */
export function forecast(
  birthDate: Date,
  doses: Array<Pick<Immunization, "cvxCode" | "occurrenceAt">>,
  today: string,
  stockedCvx: string[] = [],
): ImmunizationForecastItem[] {
  const now = new Date(`${today}T12:00:00Z`);
  const age = ageOn(birthDate, now);
  const of = (cvx: readonly string[]) =>
    doses
      .filter((d) => cvx.includes(d.cvxCode))
      .sort((a, b) => a.occurrenceAt.getTime() - b.occurrenceAt.getTime());
  const options = (cvx: readonly string[]) => {
    const stocked = cvx.filter((c) => stockedCvx.includes(c));
    return stocked.length ? stocked : [...cvx.slice(0, 3)];
  };
  const out: ImmunizationForecastItem[] = [];
  const due = (group: keyof typeof GROUPS, dueDate: Date, doseNumber?: number) =>
    out.push({
      vaccineGroup: GROUPS[group].name,
      cvxOptions: options(GROUPS[group].cvx),
      ...(doseNumber ? { doseNumber } : {}),
      dueDate: ymd(dueDate),
      overdue: ymd(dueDate) < ymd(addDays(now, -30)),
      source: "cds",
    });

  // Influenza: everyone 6 months and older, once per season (August through March).
  const month = now.getUTCMonth() + 1;
  const ageMonths =
    (now.getUTCFullYear() - birthDate.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - birthDate.getUTCMonth());
  if (ageMonths >= 6 && (month >= 8 || month <= 3)) {
    const seasonStart = new Date(
      Date.UTC(month >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1, 7, 1),
    );
    if (!of(GROUPS.influenza.cvx).some((d) => d.occurrenceAt >= seasonStart)) due("influenza", now);
  }
  if (age >= 19) {
    const last = of(GROUPS.td.cvx).at(-1);
    const next = last
      ? new Date(
          Date.UTC(
            last.occurrenceAt.getUTCFullYear() + 10,
            last.occurrenceAt.getUTCMonth(),
            last.occurrenceAt.getUTCDate(),
          ),
        )
      : now;
    if (next <= addDays(now, 30)) due("td", next);
  }
  // Pneumococcal: adults 50 and older without a conjugate or polysaccharide dose (ACIP 2024).
  if (age >= 50 && !of(GROUPS.pneumococcal.cvx).length) due("pneumococcal", now);
  // Recombinant zoster: two doses, 2-6 months apart, from age 50.
  if (age >= 50) {
    const z = of(GROUPS.zoster.cvx);
    if (z.length === 0) due("zoster", now, 1);
    else if (z.length === 1) due("zoster", addDays(z[0]!.occurrenceAt, 60), 2);
  }
  return out;
}

async function stockedCvx(tx: Tx, today: string) {
  const lots = await tx.vaccineLot.findMany({
    where: { active: true, quantityOnHand: { gt: 0 }, expirationDate: { gte: new Date(today) } },
    select: { cvxCode: true },
  });
  return [...new Set(lots.map((l) => l.cvxCode))];
}

export async function patientForecast(tx: Tx, patientId: string, birthDate: Date) {
  const today = todayLocal(await practiceTimeZone(tx));
  const doses = await tx.immunization.findMany({
    where: { patientId, status: "COMPLETED", stagingStatus: "ACTIVE" },
    select: { cvxCode: true, occurrenceAt: true },
  });
  return forecast(birthDate, doses, today, await stockedCvx(tx, today));
}

export const immunizationHandlers: HandlerMap = {
  async listImmunizations(ctx) {
    await requirePatient(ctx, ctx.params.patientId);
    const rows = await ctx.db.immunization.findMany({
      where: {
        patientId: ctx.params.patientId,
        stagingStatus: ctx.query.stagingStatus ?? "ACTIVE",
      },
      orderBy: { occurrenceAt: "desc" },
    });
    ctx.audit.detail({ rows: rows.length });
    return toDtos("Immunization", rows);
  },

  async getImmunizationForecast(ctx) {
    const p = await requirePatient(ctx, ctx.params.patientId);
    return patientForecast(ctx.db, p.id, p.birthDate);
  },

  async listVaccineLots(ctx) {
    const q = ctx.query;
    const rows = await ctx.db.vaccineLot.findMany({
      where: {
        active: true,
        ...(q.cvx ? { cvxCode: q.cvx } : {}),
        ...(q.locationId ? { locationId: q.locationId } : {}),
      },
      orderBy: [{ cvxCode: "asc" }, { expirationDate: "asc" }],
    });
    return toDtos("VaccineLot", rows);
  },

  async createVaccineLot(ctx) {
    const b = ctx.body;
    const cvx = await ctx.db.codeConcept.findFirst({ where: { system: "CVX", code: b.cvxCode } });
    if (!cvx)
      throw validationFailed([
        { field: "cvxCode", code: "invalid", message: "Choose a vaccine (CVX)." },
      ]);
    if (b.quantityOnHand < 0)
      throw validationFailed([
        { field: "quantityOnHand", code: "invalid", message: "Quantity can't be negative." },
      ]);
    const loc = await ctx.db.location.findUnique({ where: { id: b.locationId } });
    if (!loc)
      throw validationFailed([
        { field: "locationId", code: "invalid", message: "Choose a location." },
      ]);
    const dup = await ctx.db.vaccineLot.findFirst({
      where: { locationId: b.locationId, cvxCode: b.cvxCode, lotNumber: b.lotNumber.trim() },
    });
    if (dup) throw conflict("duplicate_lot", "This lot is already in inventory at this location.");
    const row = await ctx.db.vaccineLot.create({
      data: {
        practiceId: loc.practiceId,
        locationId: loc.id,
        cvxCode: b.cvxCode,
        mvxCode: b.mvxCode ?? null,
        lotNumber: b.lotNumber.trim(),
        expirationDate: new Date(b.expirationDate),
        quantityOnHand: b.quantityOnHand,
        fundingSource: b.fundingSource ?? null,
        active: b.active ?? true,
      },
    });
    ctx.audit.resource("VaccineLot", row.id);
    return toDto("VaccineLot", row);
  },

  async updateVaccineLot(ctx) {
    const lot = await ctx.db.vaccineLot.findUnique({ where: { id: ctx.params.vaccineLotId } });
    if (!lot) throw notFound();
    const b = ctx.body;
    if (b.quantityOnHand != null && b.quantityOnHand < 0)
      throw validationFailed([
        { field: "quantityOnHand", code: "invalid", message: "Quantity can't be negative." },
      ]);
    const row = await ctx.db.vaccineLot.update({
      where: { id: lot.id },
      data: {
        ...(b.quantityOnHand != null ? { quantityOnHand: b.quantityOnHand } : {}),
        ...(b.expirationDate ? { expirationDate: new Date(b.expirationDate) } : {}),
        ...(b.active != null ? { active: b.active } : {}),
        ...(b.fundingSource !== undefined ? { fundingSource: b.fundingSource } : {}),
      },
    });
    ctx.audit.resource("VaccineLot", row.id);
    return toDto("VaccineLot", row);
  },

  async administerImmunization(ctx) {
    const enc = await loadEncounter(ctx, ctx.params.encounterId);
    await assertEncounterOpen(ctx, enc.id);
    const b = ctx.body;
    const lot = await ctx.db.vaccineLot.findUnique({ where: { id: b.vaccineLotId } });
    if (!lot || !lot.active)
      throw validationFailed([
        { field: "vaccineLotId", code: "invalid", message: "Choose a lot from inventory." },
      ]);
    if (lot.cvxCode !== b.cvx)
      throw validationFailed([
        { field: "vaccineLotId", code: "mismatch", message: "That lot is a different vaccine." },
      ]);
    const today = todayLocal(await practiceTimeZone(ctx.db));
    // flow:checkin/05 failure: "Expired vaccine lot blocks administration."
    if (isoDate(lot.expirationDate)! < today)
      throw conflict(
        "lot_expired",
        `Lot ${lot.lotNumber} expired on ${isoDate(lot.expirationDate)}. Choose another lot.`,
      );
    if (lot.quantityOnHand < 1)
      throw conflict("lot_empty", `Lot ${lot.lotNumber} has no doses left.`);
    if (!b.site?.trim() || !b.route?.trim())
      throw validationFailed([
        {
          field: b.site ? "route" : "site",
          code: "required",
          message: "Enter the site and route.",
        },
      ]);
    if (!b.visGivenDate || !b.visEditionDate)
      throw validationFailed([
        {
          field: "visEditionDate",
          code: "required",
          message: "Record the VIS given to the patient.",
        },
      ]);
    if (b.reportToIis && !connectedGateways().includes("IisGateway"))
      throw unprocessable(
        "integration_not_connected",
        "The state registry isn't connected yet. Record the dose without reporting it.",
      );
    const ordered = await ctx.db.practitioner.findUnique({ where: { id: b.orderedById } });
    if (!ordered)
      throw validationFailed([
        { field: "orderedById", code: "invalid", message: "Choose the ordering provider." },
      ]);
    const cvx = await ctx.db.codeConcept.findFirst({ where: { system: "CVX", code: b.cvx } });
    const me = ctx.staff();
    const row = await ctx.db.immunization.create({
      data: {
        practiceId: enc.practiceId,
        patientId: enc.patientId,
        encounterId: enc.id,
        cvxCode: b.cvx,
        mvxCode: lot.mvxCode,
        display: cvx?.shortDisplay ?? cvx?.display ?? b.cvx,
        occurrenceAt: new Date(b.administeredAt),
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        expirationDate: lot.expirationDate,
        site: b.site.trim(),
        route: b.route.trim(),
        doseQuantity: b.doseQuantity,
        performerId: me.practitionerId,
        visEditionDate: new Date(b.visEditionDate),
        visPresentedAt: new Date(b.visGivenDate),
        standingOrder: b.orderedById !== me.practitionerId,
        registryStatus: b.reportToIis ? "queued" : "not-reported",
      },
    });
    await ctx.db.vaccineLot.update({
      where: { id: lot.id },
      data: { quantityOnHand: { decrement: 1 } },
    });
    ctx.audit.resource("Immunization", row.id);
    return toDto("Immunization", row);
  },
};
