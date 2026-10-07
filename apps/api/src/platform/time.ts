import type { Tx } from "../db.js";

/**
 * Practice-local time. DateTime columns are UTC; business dates (@db.Date) and schedule templates are in the
 * practice time zone (docs/09-data-model.md). Intl does the zone math; no date library needed.
 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(d: Date, tz: string): LocalParts {
  const p = Object.fromEntries(
    fmt(tz)
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, "0")}:${p.minute}`,
    weekday: WEEKDAYS.indexOf(p.weekday!),
    minutes: hour * 60 + Number(p.minute),
  };
}

function offsetMs(d: Date, tz: string): number {
  const p = Object.fromEntries(
    fmt(tz)
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Local wall-clock date + "HH:MM" in tz -> UTC instant (DST-safe). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let utc = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(utc), tz);
  if (second !== utc) utc = second;
  return new Date(utc);
}

/** [start, end) of a local calendar day, as UTC instants. */
export function dayRange(date: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(date, "00:00", tz), end: zonedToUtc(addDays(date, 1), "00:00", tz) };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const minutesToHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export async function practiceTimeZone(tx: Tx): Promise<string> {
  const p = await tx.practice.findFirst({ select: { timezone: true } });
  return p?.timezone ?? "America/Chicago";
}

export function todayLocal(tz: string): string {
  return localParts(new Date(), tz).date;
}
