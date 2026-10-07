import { addDays, hhmmToMinutes, localParts, zonedToUtc } from "../../platform/time.js";

/**
 * Availability (schedule.calendar open slots, schedule.booking-drawer slot finder). Pure: callers load templates,
 * blocks and appointments; this computes bookable slots in practice-local time.
 *
 * Template slots JSON (ScheduleTemplate.slots): [{weekday 0-6, start "08:00", end "12:00", visitTypeIds[], overbook}]
 *   - visitTypeIds empty = any visit type may book in that window
 *   - overbook = extra concurrent bookings allowed in that window (default 0)
 */
export interface TemplateWindow {
  weekday: number;
  start: string;
  end: string;
  visitTypeIds?: string[];
  overbook?: number;
}

export interface TemplateInput {
  practitionerId: string;
  locationId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  windows: TemplateWindow[];
}

export interface Busy {
  practitionerId: string | null; // null = practice-wide block
  start: Date;
  end: Date;
  kind: "appointment" | "block";
}

export interface Slot {
  start: Date;
  end: Date;
  practitionerId: string;
  locationId: string;
}

export interface SlotQuery {
  fromDate: string;
  toDate: string; // inclusive
  tz: string;
  stepMinutes: number;
  durationMinutes: number;
  visitTypeId: string;
  practitionerIds?: string[];
  locationId?: string;
  timeOfDay?: "morning" | "afternoon" | "any";
  notBefore: Date;
  limit?: number;
}

export function parseWindows(raw: unknown): TemplateWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .map((w) => ({
      weekday: Number(w.weekday),
      start: String(w.start),
      end: String(w.end),
      visitTypeIds: Array.isArray(w.visitTypeIds) ? (w.visitTypeIds as string[]) : [],
      overbook: Number(w.overbook ?? 0) || 0,
    }))
    .filter(
      (w) =>
        w.weekday >= 0 &&
        w.weekday <= 6 &&
        /^\d{2}:\d{2}$/.test(w.start) &&
        /^\d{2}:\d{2}$/.test(w.end) &&
        w.start < w.end,
    );
}

/** Templates in force on a date: for each practitioner/location the latest effectiveFrom wins. */
export function templatesOn(templates: TemplateInput[], date: string): TemplateInput[] {
  const live = templates.filter(
    (t) => t.effectiveFrom <= date && (!t.effectiveTo || t.effectiveTo >= date),
  );
  const latest = new Map<string, TemplateInput>();
  for (const t of live) {
    const k = `${t.practitionerId}|${t.locationId}`;
    const cur = latest.get(k);
    if (!cur || cur.effectiveFrom < t.effectiveFrom) latest.set(k, t);
  }
  return [...latest.values()];
}

const overlaps = (aS: Date, aE: Date, bS: Date, bE: Date) => aS < bE && bS < aE;

export function openSlots(q: SlotQuery, templates: TemplateInput[], busy: Busy[]): Slot[] {
  const out: Slot[] = [];
  for (let date = q.fromDate; date <= q.toDate; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    for (const t of templatesOn(templates, date)) {
      if (q.practitionerIds?.length && !q.practitionerIds.includes(t.practitionerId)) continue;
      if (q.locationId && t.locationId !== q.locationId) continue;
      for (const w of t.windows) {
        if (w.weekday !== weekday) continue;
        if (w.visitTypeIds?.length && !w.visitTypeIds.includes(q.visitTypeId)) continue;
        const ws = hhmmToMinutes(w.start);
        const we = hhmmToMinutes(w.end);
        for (let m = ws; m + q.durationMinutes <= we; m += q.stepMinutes) {
          if (q.timeOfDay === "morning" && m >= 12 * 60) break;
          if (q.timeOfDay === "afternoon" && m < 12 * 60) continue;
          const start = zonedToUtc(
            date,
            `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
            q.tz,
          );
          const end = new Date(start.getTime() + q.durationMinutes * 60_000);
          if (start < q.notBefore) continue;
          const mine = busy.filter(
            (b) =>
              (b.practitionerId === t.practitionerId || b.practitionerId === null) &&
              overlaps(start, end, b.start, b.end),
          );
          if (mine.some((b) => b.kind === "block")) continue;
          if (mine.filter((b) => b.kind === "appointment").length > (w.overbook ?? 0)) continue;
          out.push({ start, end, practitionerId: t.practitionerId, locationId: t.locationId });
          if (q.limit && out.length >= q.limit) return sortSlots(out);
        }
      }
    }
  }
  return sortSlots(out);
}

const sortSlots = (s: Slot[]) =>
  s.sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() || a.practitionerId.localeCompare(b.practitionerId),
  );

/**
 * Guard for booking/rescheduling (states.yaml: "slot available per visit type rules"): the requested start must be
 * an open slot, unless the user records an overbook reason.
 */
export function isBookable(
  start: Date,
  durationMinutes: number,
  practitionerId: string,
  locationId: string,
  q: Omit<SlotQuery, "fromDate" | "toDate" | "practitionerIds" | "locationId">,
  templates: TemplateInput[],
  busy: Busy[],
): boolean {
  const date = localParts(start, q.tz).date;
  return openSlots(
    {
      ...q,
      fromDate: date,
      toDate: date,
      practitionerIds: [practitionerId],
      locationId,
      durationMinutes,
    },
    templates,
    busy,
  ).some((s) => s.start.getTime() === start.getTime());
}

/** Occupying statuses: a cancelled, no-show or left-without-being-seen appointment frees its time. */
export const OCCUPYING = [
  "REQUESTED",
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "ROOMED",
  "READY_FOR_PROVIDER",
  "WITH_PROVIDER",
  "CHECKOUT",
  "COMPLETED",
] as const;

/** Flow-board stages and default wait targets (minutes) when the practice has not set schedule.waitTargetMinutes. */
export const FLOW_STAGES = [
  "ARRIVED",
  "ROOMED",
  "READY_FOR_PROVIDER",
  "WITH_PROVIDER",
  "CHECKOUT",
] as const;
