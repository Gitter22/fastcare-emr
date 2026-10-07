import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import type { AppointmentView } from "@agile-emr/shared";
import { toCents, fromCents } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { useApi, useApiAll } from "@/lib/api/hooks";
import {
  addDaysIso,
  dayRangeIso,
  ageSex,
  formatDate,
  formatDayTitle,
  formatTime,
  money,
  todayIso,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { Alert, Card, CardHeader, Page, PageHeader } from "@/components/ui/layout";
import { Select, Switch } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import { EligibilityChip } from "@/components/domain/Eligibility";
import { PatientLink } from "@/features/patients/PatientBits";
import { ArriveDrawer } from "./ArriveDrawer";

const S = "home.frontdesk-board";
type Tile = "all" | "in-clinic" | "eligibility" | "forms" | "balances";
const IN_CLINIC = ["ARRIVED", "ROOMED", "READY_FOR_PROVIDER", "WITH_PROVIDER", "CHECKOUT"];
const DONE = ["COMPLETED", "NO_SHOW", "CANCELLED", "LEFT_WITHOUT_BEING_SEEN"];

/** home.frontdesk-board (flow:checkin/01): run today's arrivals without opening charts. */
export function FrontDeskBoardPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [practitionerId, setPractitionerId] = React.useState("");
  const [showCompleted, setShowCompleted] = React.useState(false);
  const [tile, setTile] = React.useState<Tile>("all");
  const today = todayIso();
  const board = useApi(
    "getFrontDeskBoard",
    {
      query: {
        date: today,
        ...(me.activeLocationId ? { locationId: me.activeLocationId } : {}),
        ...(practitionerId ? { practitionerId } : {}),
      },
    },
    { refetchInterval: 30_000 },
  );
  const practitioners = useApi("listPractitioners", { query: {} });
  const tomorrow = useApiAll("listAppointments", {
    query: {
      ...dayRangeIso(addDaysIso(today, 1)),
      ...(me.activeLocationId ? { locationId: me.activeLocationId } : {}),
    },
  });
  const waitlist = useApi(
    "listWaitlist",
    { query: { status: ["OFFERED"] } },
    { enabled: can("listWaitlist") },
  );
  const integrations = useApi("listIntegrations", undefined, { enabled: can("listIntegrations") });
  const clearinghouse = integrations.data?.find((i) => i.kind === "STEDI");

  const all = React.useMemo(
    () =>
      (board.data?.columns ?? [])
        .flatMap((c) => c.appointments)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [board.data],
  );
  const alertsFor = (kind: string) =>
    new Set((board.data?.alerts ?? []).filter((a) => a.kind === kind).map((a) => a.appointmentId));
  const eligIssues = alertsFor("eligibility");
  const formIssues = alertsFor("forms");
  const balances = all.filter((a) => toCents(a.balanceDue) > 0 && !DONE.includes(a.status));
  const inClinic = all.filter((a) => IN_CLINIC.includes(a.status));
  const longestWait = Math.max(
    0,
    ...inClinic.filter((a) => a.status === "ARRIVED").map((a) => a.minutesInStatus ?? 0),
  );
  const rows = all.filter((a) => {
    if (!showCompleted && DONE.includes(a.status) && tile === "all") return false;
    if (tile === "in-clinic") return IN_CLINIC.includes(a.status);
    if (tile === "eligibility") return eligIssues.has(a.id);
    if (tile === "forms") return formIssues.has(a.id);
    if (tile === "balances") return balances.some((b) => b.id === a.id);
    return true;
  });
  const arriveId = params.get("view") === "arrive" ? params.get("appointment") : null;

  const columns = React.useMemo<Col<AppointmentView>[]>(
    () => [
      {
        id: "time",
        header: "Time",
        accessorFn: (a) => a.start,
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap font-semibold tabular-nums"
            data-testid={tid(S, "col-time")}
          >
            {formatTime(row.original.start)}
          </span>
        ),
      },
      {
        id: "patient",
        header: "Patient",
        accessorFn: (a) => a.patient.name,
        cell: ({ row }) => (
          <span className="grid" data-testid={tid(S, "col-patient")}>
            <PatientLink patient={row.original.patient} />
            <span className="whitespace-nowrap text-small tabular-nums text-ink-2">
              {formatDate(row.original.patient.birthDate)} ·{" "}
              {ageSex(row.original.patient.birthDate, row.original.patient.sexForClinicalUse)}
            </span>
          </span>
        ),
      },
      {
        id: "visit",
        header: "Provider · Visit",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="grid" data-testid={tid(S, "col-visit")}>
            <span>{row.original.practitioner.name}</span>
            <span className="flex items-center gap-1 text-small text-ink-2">
              {row.original.visitType.name}
              {row.original.modality === "VIDEO" ? <Tag>Video</Tag> : null}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (a) => a.status,
        cell: ({ row }) => (
          <span className="grid justify-items-start gap-1">
            <StatusChip
              machine="appointment"
              value={row.original.status}
              testId={tid(S, "col-status")}
            />
            {row.original.status === "ARRIVED" ? (
              <span className="text-small tabular-nums text-ink-2">
                waiting {row.original.minutesInStatus ?? 0} min
              </span>
            ) : null}
            {row.original.checkinStatus === "COMPLETED" ? (
              <span className="text-small text-ink-2">E-check-in done</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "elig",
        header: "Eligibility",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <EligibilityChip
              status={row.original.eligibility}
              selfPay={!row.original.eligibility}
              testId={tid(S, "col-eligibility")}
            />
            {row.original.copayDue ? (
              <span className="text-small tabular-nums text-ink-2">
                copay {money(row.original.copayDue)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "forms",
        header: "Forms",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.formsOutstanding ? (
            <Tag tone="caution" data-testid={tid(S, "col-forms")}>
              {row.original.formsOutstanding} to sign
            </Tag>
          ) : (
            <span data-testid={tid(S, "col-forms")}>Complete</span>
          ),
      },
      {
        id: "due",
        header: "Due today",
        enableSorting: false,
        meta: { numeric: true },
        cell: ({ row }) => {
          const due =
            toCents(row.original.copayDue) + Math.max(0, toCents(row.original.balanceDue));
          return (
            <span className="grid justify-items-end" data-testid={tid(S, "col-due")}>
              <span>{due ? money(fromCents(due)) : "—"}</span>
              {due && row.original.copayDue && toCents(row.original.balanceDue) > 0 ? (
                <span className="text-small font-normal text-ink-2">copay + prior</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "action",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) => {
          const a = row.original;
          if (
            (a.status === "BOOKED" || a.status === "CONFIRMED") &&
            eligIssues.has(a.id) &&
            a.eligibility === "INACTIVE" &&
            isBuilt("chart.demographics")
          )
            return (
              <Button
                size="sm"
                onClick={() =>
                  navigate(pathTo("chart.demographics", { patientId: a.patient.id }, "coverage"))
                }
                data-testid={tid(S, "row-resolve")}
              >
                Resolve
              </Button>
            );
          if ((a.status === "BOOKED" || a.status === "CONFIRMED") && can("arriveAppointment"))
            return (
              <Button
                size="sm"
                onClick={() => setParams({ view: "arrive", appointment: a.id })}
                data-testid={tid(S, "row-arrive")}
              >
                Arrive
              </Button>
            );
          if (isBuilt("schedule.appointment-detail"))
            return (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  navigate(pathTo("schedule.appointment-detail", { appointmentId: a.id }))
                }
                data-testid={tid(S, "row-open")}
              >
                Open
              </Button>
            );
          return null;
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.data, can],
  );

  const tomorrowRows = tomorrow.data?.filter((a) => !DONE.includes(a.status)) ?? [];
  const location = me.locations.find(
    (l) => l.id === (board.data?.locationId ?? me.activeLocationId),
  );
  return (
    <Page>
      <PageHeader
        title={`Today · ${formatDayTitle(today)}`}
        testId={tid(S, "date-title")}
        actions={
          <>
            <Select
              aria-label="Provider"
              testId={tid(S, "provider-filter")}
              className="w-52"
              value={practitionerId}
              onValueChange={(v) => setPractitionerId(v === "ALL" ? "" : v)}
              placeholder="All providers"
              options={[
                { value: "ALL", label: "All providers" },
                ...(practitioners.data ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.firstName} ${p.lastName}`,
                })),
              ]}
            />
            <Switch
              checked={showCompleted}
              onCheckedChange={setShowCompleted}
              label="Show completed"
              data-testid={tid(S, "show-completed")}
            />
            {can("bookAppointment") && isBuilt("schedule.calendar") ? (
              <Button
                variant="primary"
                onClick={() => navigate(pathTo("schedule.booking-drawer"))}
                data-testid={tid(S, "book-appointment")}
              >
                <Plus size={18} strokeWidth={1.75} />
                Book appointment
              </Button>
            ) : null}
          </>
        }
      />
      {clearinghouse && clearinghouse.health === "DOWN" ? (
        <Alert
          tone="caution"
          testId={tid(S, "interface-banner")}
          title="Clearinghouse not responding."
          action={
            isBuilt("admin.interfaces") ? (
              <Button size="sm" onClick={() => navigate(pathTo("admin.interfaces"))}>
                Interface status
              </Button>
            ) : null
          }
        >
          Eligibility below may be from the last batch. Real-time checks retry automatically.
        </Alert>
      ) : null}
      <div className="grid grid-cols-5 gap-4">
        <StatTile
          id="tile-arrivals"
          active={tile === "all"}
          onClick={() => setTile("all")}
          label="Arrivals today"
          value={all.filter((a) => !["CANCELLED"].includes(a.status)).length}
          hint={`${all.filter((a) => a.status === "BOOKED" || a.status === "CONFIRMED").length} still to come`}
        />
        <StatTile
          id="tile-in-clinic"
          active={tile === "in-clinic"}
          onClick={() => setTile("in-clinic")}
          label="In clinic now"
          value={inClinic.length}
          hint={inClinic.length ? `Longest wait ${longestWait} min` : "Nobody waiting"}
        />
        <StatTile
          id="tile-eligibility"
          active={tile === "eligibility"}
          onClick={() => setTile("eligibility")}
          label="Eligibility issues"
          value={eligIssues.size}
          hint="Need action before visit"
        />
        <StatTile
          id="tile-forms"
          active={tile === "forms"}
          onClick={() => setTile("forms")}
          label="Forms incomplete"
          value={formIssues.size}
          hint="Consents to sign"
        />
        <StatTile
          id="tile-balances"
          active={tile === "balances"}
          onClick={() => setTile("balances")}
          label="Balances due"
          value={balances.length}
          hint={`${money(fromCents(balances.reduce((s, a) => s + toCents(a.balanceDue), 0)))} total`}
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_256px] items-start gap-6">
        <Card>
          <CardHeader
            title="Arrivals"
            actions={
              <span className="text-small text-ink-2">{location?.name ?? ""} · sorted by time</span>
            }
          />
          <DataTable
            columns={columns}
            data={rows}
            loading={board.isLoading}
            error={board.error}
            onRetry={() => void board.refetch()}
            empty={tile === "all" ? "No appointments today" : "Nothing in this group"}
            getRowId={(a) => a.id}
            testId={tid(S, "arrivals-table")}
          />
        </Card>
        <div className="grid gap-6">
          <Card>
            <CardHeader title="Needs attention" />
            <ul className="grid gap-4">
              <AttentionRow
                testId={tid(S, "att-consents")}
                label="Unsigned consents"
                sub={`Today's patients · ${formIssues.size}`}
                action={
                  formIssues.size ? (
                    <Button size="sm" variant="link" onClick={() => setTile("forms")}>
                      Show
                    </Button>
                  ) : null
                }
              />
              {can("listWaitlist") ? (
                <AttentionRow
                  testId={tid(S, "att-waitlist")}
                  label="Waitlist offers pending"
                  sub={`${waitlist.data?.data.length ?? 0} waiting for a reply`}
                  action={
                    isBuilt("schedule.waitlist") ? (
                      <Button
                        size="sm"
                        variant="link"
                        onClick={() => navigate(pathTo("schedule.waitlist"))}
                      >
                        View
                      </Button>
                    ) : null
                  }
                />
              ) : null}
              {can("listStagedChanges") && isBuilt("inbox.previsit-queue") ? (
                <AttentionRow
                  testId={tid(S, "att-previsit")}
                  label="Patient-entered changes"
                  sub="Demographics and insurance"
                  action={
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => navigate(pathTo("inbox.previsit-queue"))}
                    >
                      Review
                    </Button>
                  }
                />
              ) : null}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Tomorrow" />
            <p className="text-body text-ink" data-testid={tid(S, "tomorrow-summary")}>
              {tomorrowRows.length} appointments · eligibility checks run automatically 48 hours
              ahead.
            </p>
            <p className="mt-2 text-body text-ink-2">
              {tomorrowRows.filter((a) => a.status === "BOOKED").length} not confirmed yet.
            </p>
            {isBuilt("schedule.calendar") ? (
              <Button
                className="mt-4"
                onClick={() =>
                  navigate(
                    pathTo("schedule.calendar", {}, undefined, { date: addDaysIso(today, 1) }),
                  )
                }
                data-testid={tid(S, "tomorrow-unconfirmed")}
              >
                Open call list
              </Button>
            ) : null}
          </Card>
        </div>
      </div>
      <ArriveDrawer appointmentId={arriveId} onClose={() => setParams({})} />
    </Page>
  );
}

function StatTile({
  id,
  label,
  value,
  hint,
  active,
  onClick,
  caution,
}: {
  id: string;
  label: string;
  value: number;
  hint: string;
  active: boolean;
  onClick: () => void;
  caution?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={tid(S, id)}
      aria-pressed={active}
      className={cn(
        "grid gap-1 bg-surface p-5 text-left transition-colors duration-fast hover:bg-surface-hover",
        active && "shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
      )}
    >
      <span className="text-small text-ink-2">{label}</span>
      <span className={cn("text-display tabular-nums", caution ? "text-caution-ink" : "text-ink")}>
        {value}
      </span>
      <span className="text-small text-ink">{hint}</span>
    </button>
  );
}

function AttentionRow({
  label,
  sub,
  action,
  testId,
}: {
  label: string;
  sub: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3" data-testid={testId}>
      <span className="grid">
        <span className="text-body text-ink">{label}</span>
        <span className="text-small text-ink-2">{sub}</span>
      </span>
      {action}
    </li>
  );
}
