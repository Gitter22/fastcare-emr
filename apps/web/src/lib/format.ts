import { formatMoney, stateLabel, type MachineId } from "@agile-emr/shared";

/** Display formats. Dates use the practice time zone (set from getMe). Status text only via stateLabel (INV-DATA-03). */
let practiceTz = "America/Chicago";
export const setPracticeTimeZone = (tz: string) => void (practiceTz = tz);
export const practiceTimeZone = () => practiceTz;

const dtf = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: practiceTz, ...o });

/** "03/14/1968" from a business date (YYYY-MM-DD, no time zone shift). */
export function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m && d.length === 10) return `${m[2]}/${m[3]}/${m[1]}`;
  return dtf({ month: "2-digit", day: "2-digit", year: "numeric" }).format(new Date(d));
}

/** "10:02 AM" in the practice time zone. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dtf({ hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Oct 7, 2026 10:02 AM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dtf({
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (iso.length === 10) {
    const [, m, d] = iso.split("-");
    return `${m}/${d}`;
  }
  return dtf({ month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Today's business date (YYYY-MM-DD) in the practice time zone. */
export function todayIso(): string {
  const parts = dtf({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(),
  );
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (Math.abs(m) < 1) return "just now";
  if (Math.abs(m) < 60) return m > 0 ? `${m} min ago` : `in ${-m} min`;
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return h > 0 ? `${h} h ago` : `in ${-h} h`;
  const d = Math.round(h / 24);
  return d > 0 ? `${d} d ago` : `in ${-d} d`;
}

export const money = formatMoney;
export const status = (machine: MachineId, value: string | null | undefined) =>
  stateLabel(machine, value);

export const pluralize = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function enumLabel(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.toLowerCase().replace(/_/g, " ");
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Local calendar date (YYYY-MM-DD) and minutes since midnight of an instant, in the practice time zone. */
export function zonedParts(iso: string): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: practiceTz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
  };
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Wed, Oct 7" for a business date. */
export function formatDayTitle(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** "36 F" style age + sex from DOB and sex for clinical use. */
export function ageSex(birthDate: string, sex?: string | null): string {
  const b = new Date(`${birthDate}T00:00:00Z`);
  const n = new Date();
  let y = n.getUTCFullYear() - b.getUTCFullYear();
  if (
    n.getUTCMonth() < b.getUTCMonth() ||
    (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())
  )
    y--;
  const age =
    y >= 2
      ? `${y}`
      : `${Math.max(0, Math.floor((n.getTime() - b.getTime()) / (30.44 * 86_400_000)))} mo`;
  const s = sex === "FEMALE" ? "F" : sex === "MALE" ? "M" : "";
  return `${age}${s ? ` ${s}` : ""}`;
}

function tzOffsetMs(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: practiceTz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return (
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second),
    ) -
    Math.floor(at.getTime() / 1000) * 1000
  );
}

/** UTC instant (ISO) of local midnight of a business date in the practice time zone (DST-safe). */
export function dayStartIso(date: string): string {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let utc = guess - tzOffsetMs(new Date(guess));
  const second = guess - tzOffsetMs(new Date(utc));
  if (second !== utc) utc = second;
  return new Date(utc).toISOString();
}

/** [start, end) instants covering business dates from..to inclusive. */
export const dayRangeIso = (from: string, to = from) => ({
  from: dayStartIso(from),
  to: dayStartIso(addDaysIso(to, 1)),
});
