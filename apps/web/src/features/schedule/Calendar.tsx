import * as React from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { AppointmentView, ScheduleBlock } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, routeOf, tid } from "@/app/routes";
import { useApi, useApiAll } from "@/lib/api/hooks";
import {
  addDaysIso,
  dayRangeIso,
  formatDayTitle,
  formatTime,
  todayIso,
  zonedParts,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, ErrorState, LoadingRows } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import { SubNav } from "@/shell/patterns";
import { AppointmentDrawer } from "./AppointmentDrawer";
import { BookingDrawer } from "./BookingDrawer";
import { Pressable } from "@/components/ui/pressable";

const S = "schedule.calendar";
const DAY_START = 7 * 60;
const DAY_END = 18 * 60;
const PX_PER_MIN = 1.6;
const ROW_STEP = 20;
type View = "day" | "week";

/**
 * schedule.calendar (+ schedule.booking-drawer, schedule.appointment-detail as drawers on their own routes).
 * Day view: one column per provider with open slots from templates, blocks and bookings; double-bookings flagged.
 */
export function CalendarPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { appointmentId } = useParams();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIso();
  const view = (params.get("mode") as View) ?? "day";
  const [selected, setSelected] = React.useState<string[] | null>(null);
  const [locationId, setLocationId] = React.useState(me.activeLocationId ?? "");
  const setDate = (d: string) => setParams((p) => (p.set("date", d), p));

  const practitioners = useApi("listPractitioners", { query: {} });
  const locations = useApi("listLocations");
  const visitTypes = useApi("listVisitTypes");
  const templates = useApi("listScheduleTemplates", { query: locationId ? { locationId } : {} });
  const rangeEnd = view === "week" ? addDaysIso(date, 6) : date;
  const appts = useApiAll(
    "listAppointments",
    { query: { ...dayRangeIso(date, rangeEnd), ...(locationId ? { locationId } : {}) } },
    { refetchInterval: 30_000 },
  );
  const blocks = useApi("listScheduleBlocks", { query: dayRangeIso(date, rangeEnd) });
  const waitlist = useApi("listWaitlist", { query: {} }, { enabled: can("listWaitlist") });
  // Open slots come from the server's availability rules (templates, blocks, bookings), sized for the shortest visit type.
  const slotType = [...(visitTypes.data ?? [])]
    .filter((v) => v.active)
    .sort((a, b) => a.durationMinutes - b.durationMinutes)[0];
  const open = useApi(
    "searchAvailability",
    {
      query: {
        visitTypeId: slotType?.id ?? "",
        fromDate: date,
        toDate: date,
        ...(locationId ? { locationId } : {}),
      },
    },
    { enabled: view === "day" && !!slotType && can("searchAvailability") },
  );

  const scheduled = React.useMemo(() => {
    const withTemplate = new Set((templates.data ?? []).map((t) => t.practitionerId));
    return (practitioners.data ?? []).filter((p) => p.active && withTemplate.has(p.id));
  }, [practitioners.data, templates.data]);
  const columns = scheduled.filter((p) => !selected || selected.includes(p.id));
  const booking = pathname === routeOf("schedule.booking-drawer") || params.get("view") === "book";
  const visible = (appts.data ?? []).filter((a) => a.status !== "CANCELLED");

  const needsLook = React.useMemo(() => {
    const items: Array<{ kind: string; text: string; id: string }> = [];
    const short = (n: string) => n.split(",")[0];
    for (const a of visible) {
      if (a.eligibility === "INACTIVE" || a.eligibility === "ERROR")
        items.push({
          kind: "Ins.",
          id: a.id,
          text: `${short(a.patient.name)} · ${a.eligibility === "INACTIVE" ? "coverage inactive" : "not verified"}`,
        });
    }
    // Each overlapping pair for the same provider, once (double-book warning).
    for (const [i, a] of visible.entries()) {
      for (const b of visible.slice(i + 1)) {
        if (a.practitioner.id === b.practitioner.id && a.start < b.end && b.start < a.end) {
          const [first, second] = a.start <= b.start ? [a, b] : [b, a];
          items.push({
            kind: "Overlap",
            id: second.id,
            text: `${formatTime(second.start)} ${short(second.patient.name)} overlaps ${short(first.patient.name)}`,
          });
        }
      }
    }
    return items;
  }, [visible]);

  return (
    <div className="grid content-start gap-6 p-8">
      <SubNav which="schedule" />
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-6">
        <div className="grid min-w-0 gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="icon"
              aria-label="Previous"
              onClick={() => setDate(addDaysIso(date, view === "week" ? -7 : -1))}
              data-testid={tid(S, "prev-day")}
            >
              <ChevronLeft size={18} strokeWidth={1.75} />
            </Button>
            <Button onClick={() => setDate(todayIso())} data-testid={tid(S, "today")}>
              Today
            </Button>
            <Button
              size="icon"
              aria-label="Next"
              onClick={() => setDate(addDaysIso(date, view === "week" ? 7 : 1))}
              data-testid={tid(S, "next-day")}
            >
              <ChevronRight size={18} strokeWidth={1.75} />
            </Button>
            <h1 className="px-2 text-h1 text-ink" data-testid={tid(S, "date-title")}>
              {view === "week" ? `Week of ${formatDayTitle(date)}` : formatDayTitle(date)}
            </h1>
            <Tabs value={view} onValueChange={(v) => setParams((p) => (p.set("mode", v), p))}>
              <TabsList data-testid={tid(S, "view-switch")}>
                <TabsTrigger value="day">Day</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
              </TabsList>
            </Tabs>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button data-testid={tid(S, "provider-picker")}>
                  Providers: {selected ? selected.length : "All"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {scheduled.map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p.id}
                    checked={!selected || selected.includes(p.id)}
                    onCheckedChange={(c) => {
                      const cur = selected ?? scheduled.map((x) => x.id);
                      const next = c ? [...cur, p.id] : cur.filter((x) => x !== p.id);
                      setSelected(next.length === scheduled.length ? null : next);
                    }}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {p.firstName} {p.lastName}
                    {p.credential ? `, ${p.credential}` : ""}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select
              aria-label="Location"
              testId={tid(S, "location-picker")}
              className="w-40"
              value={locationId}
              onValueChange={setLocationId}
              options={(locations.data ?? [])
                .filter((l) => l.active)
                .map((l) => ({ value: l.id, label: l.name }))}
            />
            {can("bookAppointment") ? (
              <Button
                variant="primary"
                className="ml-auto"
                onClick={() => navigate(`${pathTo("schedule.booking-drawer")}?date=${date}`)}
                data-testid={tid(S, "book")}
              >
                <Plus size={18} strokeWidth={1.75} />
                Book
              </Button>
            ) : null}
          </div>
          {appts.isLoading || templates.isLoading ? (
            <Card>
              <LoadingRows />
            </Card>
          ) : appts.error ? (
            <Card>
              <ErrorState onRetry={() => void appts.refetch()} />
            </Card>
          ) : view === "day" ? (
            <DayGrid
              date={date}
              columns={columns.map((p) => ({
                id: p.id,
                name: `${p.credential === "MD" || p.credential === "DO" ? "Dr. " : ""}${p.firstName} ${p.lastName}${p.credential && !["MD", "DO"].includes(p.credential) ? `, ${p.credential}` : ""}`,
              }))}
              appointments={visible}
              blocks={blocks.data ?? []}
              openSlots={open.data?.slots ?? []}
              newPatientTypeIds={
                new Set((visitTypes.data ?? []).filter((v) => v.newPatientOnly).map((v) => v.id))
              }
              onOpen={(a) =>
                navigate(
                  `${pathTo("schedule.appointment-detail", { appointmentId: a.id })}?date=${date}`,
                )
              }
              onOpenSlot={(practitionerId, start) =>
                can("bookAppointment") &&
                navigate(
                  `${pathTo("schedule.booking-drawer")}?date=${date}&practitionerId=${practitionerId}&start=${encodeURIComponent(start)}`,
                )
              }
            />
          ) : (
            <WeekList
              date={date}
              appointments={visible}
              onOpen={(a) =>
                navigate(
                  `${pathTo("schedule.appointment-detail", { appointmentId: a.id })}?date=${date}&mode=week`,
                )
              }
            />
          )}
        </div>
        <aside className="grid gap-6">
          <Card className="p-4" data-testid={tid(S, "mini-month")}>
            <DayPicker
              mode="single"
              selected={new Date(`${date}T12:00:00`)}
              defaultMonth={new Date(`${date}T12:00:00`)}
              onSelect={(d) =>
                d &&
                setDate(
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
                )
              }
              classNames={{
                month_caption: "pb-2 text-h3",
                nav: "absolute right-4 top-4 flex gap-1",
                button_previous: "grid size-control-sm place-items-center hover:bg-surface-hover",
                button_next: "grid size-control-sm place-items-center hover:bg-surface-hover",
                weekday: "h-8 w-9 text-caption text-ink-2",
                day: "size-9 p-0 text-center",
                day_button: "size-9 tabular-nums hover:bg-surface-hover",
                selected: "bg-ink text-on-primary [&>button]:hover:bg-ink",
                today: "font-bold",
                outside: "text-ink-3",
              }}
            />
          </Card>
          <Card>
            <CardHeader title="Needs a look" />
            {needsLook.length ? (
              <ul className="grid gap-3" data-testid={tid(S, "needs-look")}>
                {needsLook.slice(0, 8).map((n) => (
                  <li key={`${n.kind}-${n.id}`} className="flex items-start gap-2 text-body">
                    <Tag tone="caution">{n.kind}</Tag>
                    <Pressable
                      type="button"
                      className="text-left hover:underline"
                      onClick={() =>
                        navigate(
                          `${pathTo("schedule.appointment-detail", { appointmentId: n.id })}?date=${date}`,
                        )
                      }
                    >
                      {n.text}
                    </Pressable>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-ink-2">No overlaps or coverage problems.</p>
            )}
          </Card>
          <Card>
            <CardHeader title="Legend" />
            <ul className="grid gap-2 text-body" data-testid={tid(S, "legend")}>
              <li className="flex items-center gap-3">
                <span className="h-4 w-6 shadow-[inset_0_0_0_2px_var(--color-ink)]" />
                New patient
              </li>
              <li className="flex items-center gap-3">
                <span className="h-4 w-6 bg-surface-muted" />
                Established
              </li>
              <li className="flex items-center gap-3">
                <span className="h-4 w-6 border border-dashed border-line-strong" />
                Open slot
              </li>
              <li className="flex items-center gap-3">
                <span className="h-4 w-6 bg-surface-active" />
                Blocked
              </li>
            </ul>
          </Card>
          {can("listWaitlist") && isBuilt("schedule.waitlist") ? (
            <Card>
              <CardHeader title="Waitlist" />
              <p className="text-body text-ink">
                {waitlist.data?.data.filter((w) => w.status === "ACTIVE").length ?? 0} patients want
                an earlier slot
              </p>
              <Button
                className="mt-4"
                onClick={() => navigate(pathTo("schedule.waitlist"))}
                data-testid={tid(S, "waitlist-card")}
              >
                Offer open slots
              </Button>
            </Card>
          ) : null}
        </aside>
      </div>
      <BookingDrawer
        open={booking}
        onClose={() => navigate(`${pathTo("schedule.calendar")}?date=${date}&mode=${view}`)}
        defaultDate={date}
      />
      <AppointmentDrawer
        appointmentId={appointmentId ?? null}
        onClose={() => navigate(`${pathTo("schedule.calendar")}?date=${date}&mode=${view}`)}
      />
    </div>
  );
}

function DayGrid({
  date,
  columns,
  appointments,
  blocks,
  openSlots,
  newPatientTypeIds,
  onOpen,
  onOpenSlot,
}: {
  date: string;
  columns: Array<{ id: string; name: string }>;
  appointments: AppointmentView[];
  blocks: ScheduleBlock[];
  openSlots: Array<{ start: string; end: string; practitionerId: string }>;
  newPatientTypeIds: Set<string>;
  onOpen: (a: AppointmentView) => void;
  onOpenSlot: (practitionerId: string, startIso: string) => void;
}) {
  const rows = Array.from(
    { length: (DAY_END - DAY_START) / ROW_STEP },
    (_, i) => DAY_START + i * ROW_STEP,
  );
  const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  if (!columns.length) {
    return (
      <Card>
        <p className="text-body text-ink-2">
          No provider schedules at this location. Set up weekly templates in Admin › Visit types.
        </p>
      </Card>
    );
  }
  return (
    <div className="overflow-x-auto bg-surface" data-testid={tid(S, "grid")}>
      <div
        className="grid min-w-[720px]"
        style={{ gridTemplateColumns: `64px repeat(${columns.length}, minmax(200px, 1fr))` }}
      >
        <div className="border-b border-ink" />
        {columns.map((c) => {
          const mine = appointments.filter(
            (a) => a.practitioner.id === c.id && zonedParts(a.start).date === date,
          );
          return (
            <div
              key={c.id}
              className="grid gap-0.5 border-b border-ink px-3 py-3"
              data-testid={tid(S, "provider-column")}
            >
              <span className="text-h3 text-ink">{c.name}</span>
              <span className="text-small text-ink-2">{mine.length} booked</span>
            </div>
          );
        })}
        <div className="relative" style={{ height: (DAY_END - DAY_START) * PX_PER_MIN }}>
          {rows.map((m) =>
            m % 60 === 0 && m > DAY_START ? (
              <span
                key={m}
                className="absolute right-2 text-small tabular-nums text-ink-2"
                style={{ top: (m - DAY_START) * PX_PER_MIN - 8 }}
              >
                {hhmm(m)}
              </span>
            ) : null,
          )}
        </div>
        {columns.map((c) => {
          const mine = appointments.filter(
            (a) => a.practitioner.id === c.id && zonedParts(a.start).date === date,
          );
          const myBlocks = blocks.filter(
            (b) =>
              (!b.practitionerId || b.practitionerId === c.id) && zonedParts(b.start).date === date,
          );
          return (
            <div
              key={c.id}
              className="relative border-l border-line"
              style={{ height: (DAY_END - DAY_START) * PX_PER_MIN }}
            >
              {rows.map((m) => (
                <div
                  key={m}
                  className={cn("absolute inset-x-0", m % 60 === 0 && "border-t border-line")}
                  style={{ top: (m - DAY_START) * PX_PER_MIN }}
                />
              ))}
              {openSlots
                .filter((o) => o.practitionerId === c.id)
                .map((o) => {
                  const m = zonedParts(o.start).minutes;
                  return (
                    <Pressable
                      key={o.start}
                      type="button"
                      data-testid={tid(S, "open-slot")}
                      onClick={() => onOpenSlot(c.id, o.start)}
                      className="absolute inset-x-1 border border-dashed border-line-strong text-small text-ink-2 hover:bg-surface-hover"
                      style={{
                        top: (m - DAY_START) * PX_PER_MIN + 1,
                        height: (zonedParts(o.end).minutes - m) * PX_PER_MIN - 2,
                      }}
                    >
                      Open
                    </Pressable>
                  );
                })}
              {myBlocks.map((b) => {
                const s = Math.max(DAY_START, zonedParts(b.start).minutes);
                const e = Math.min(DAY_END, zonedParts(b.end).minutes);
                return (
                  <div
                    key={b.id}
                    data-testid={tid(S, "blocked-time")}
                    className="absolute inset-x-1 bg-surface-active px-2 py-1 text-small text-ink-2"
                    style={{
                      top: (s - DAY_START) * PX_PER_MIN + 1,
                      height: Math.max(18, (e - s) * PX_PER_MIN - 2),
                    }}
                  >
                    Blocked · {b.reason}
                  </div>
                );
              })}
              {layout(mine).map(({ a, lane, lanes }) => {
                const s = zonedParts(a.start).minutes;
                const e = zonedParts(a.end).minutes;
                const isNew = newPatientTypeIds.has(a.visitType.id);
                const done = ["COMPLETED", "NO_SHOW", "LEFT_WITHOUT_BEING_SEEN"].includes(a.status);
                return (
                  <Pressable
                    key={a.id}
                    type="button"
                    onClick={() => onOpen(a)}
                    data-testid={tid(S, "appt-block")}
                    className={cn(
                      "absolute grid content-start gap-0.5 overflow-hidden px-2 py-1 text-left text-small hover:bg-surface-hover",
                      isNew
                        ? "bg-surface shadow-[inset_0_0_0_2px_var(--color-ink)]"
                        : "bg-surface-muted",
                      a.modality === "VIDEO" && "border border-dashed border-ink-2",
                      done && "text-ink-2",
                    )}
                    style={{
                      top: (s - DAY_START) * PX_PER_MIN + 1,
                      height: Math.max(22, (e - s) * PX_PER_MIN - 2),
                      left: `calc(${(lane / lanes) * 100}% + 4px)`,
                      width: `calc(${100 / lanes}% - 8px)`,
                    }}
                  >
                    <span className="truncate">
                      <span className="font-semibold text-ink">{a.patient.name}</span> ·{" "}
                      {a.visitType.name}
                      {a.modality === "VIDEO" ? " · Video" : ""}
                    </span>
                    {(e - s) * PX_PER_MIN > 40 ? (
                      <span className="flex items-center gap-1">
                        <StatusChip machine="appointment" value={a.status} />
                        {a.eligibility === "INACTIVE" || a.eligibility === "ERROR" ? (
                          <Tag tone="caution">Ins.</Tag>
                        ) : null}
                        {lanes > 1 ? (
                          <Tag tone="caution" data-testid={tid(S, "overlap-flag")}>
                            Overlap
                          </Tag>
                        ) : null}
                      </span>
                    ) : null}
                  </Pressable>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Side-by-side lanes for overlapping appointments (double-book warning). */
function layout(appts: AppointmentView[]) {
  const sorted = [...appts].sort((a, b) => a.start.localeCompare(b.start));
  const lanesEnd: string[] = [];
  const placed = sorted.map((a) => {
    let lane = lanesEnd.findIndex((end) => end <= a.start);
    if (lane < 0) {
      lane = lanesEnd.length;
      lanesEnd.push(a.end);
    } else lanesEnd[lane] = a.end;
    return { a, lane };
  });
  return placed.map((p) => {
    const overlapping = placed.filter((q) => q.a.start < p.a.end && p.a.start < q.a.end);
    return { ...p, lanes: Math.max(...overlapping.map((q) => q.lane)) + 1 };
  });
}

function WeekList({
  date,
  appointments,
  onOpen,
}: {
  date: string;
  appointments: AppointmentView[];
  onOpen: (a: AppointmentView) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(date, i));
  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((d) => {
        const list = appointments
          .filter((a) => zonedParts(a.start).date === d)
          .sort((a, b) => a.start.localeCompare(b.start));
        return (
          <section key={d} className="grid content-start gap-1 bg-surface p-3">
            <h3 className="text-label text-ink">{formatDayTitle(d)}</h3>
            <span className="text-small text-ink-2">{list.length} booked</span>
            {list.map((a) => (
              <Pressable
                key={a.id}
                type="button"
                onClick={() => onOpen(a)}
                className="grid bg-surface-muted px-2 py-1 text-left text-small hover:bg-surface-hover"
                data-testid={tid(S, "appt-block")}
              >
                <span className="tabular-nums text-ink-2">{formatTime(a.start)}</span>
                <span className="truncate font-semibold">{a.patient.name}</span>
              </Pressable>
            ))}
          </section>
        );
      })}
    </div>
  );
}
