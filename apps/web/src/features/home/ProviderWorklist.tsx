import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { AppointmentView, ProviderWorklist } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import {
  addDaysIso,
  ageSex,
  formatDayTitle,
  formatShortDate,
  formatTime,
  todayIso,
} from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Card, CardHeader, Page, PageHeader } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { StatusChip } from "@/components/domain/StatusChip";
import { PatientLink } from "@/features/patients/PatientBits";
import { useOpenEncounter } from "@/features/encounter/useOpenEncounter";
import { Pressable } from "@/components/ui/pressable";

const S = "home.provider-worklist";
type Readiness = ProviderWorklist["readiness"][number];
const SEEN = ["CHECKOUT", "COMPLETED"];
const GONE = ["NO_SHOW", "LEFT_WITHOUT_BEING_SEEN"];

/** home.provider-worklist (flow:access/07, encounter/01): what is ready and what is blocking. */
export function ProviderWorklistPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const enc = useOpenEncounter();
  const [day, setDay] = React.useState(todayIso());
  const isToday = day === todayIso();
  const w = useApi(
    "getProviderWorklist",
    { query: { date: day } },
    { refetchInterval: isToday ? 30_000 : false },
  );
  const [notify, setNotify] = React.useState(false);
  const start = useApiMutation("startVisit", {
    invalidates: ["getProviderWorklist", "getEncounter"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const late = useApiMutation("sendRunningLateNotice", {
    onSuccess: () => toast("Update queued for waiting patients."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const data = w.data;
  const ready = new Map((data?.readiness ?? []).map((r) => [r.appointmentId, r]));
  const schedule = (data?.schedule ?? []).filter((a) => !GONE.includes(a.status));
  const messaging = me.connectedGateways.some((g) => g.startsWith("MessagingGateway"));

  const openVisit = (a: AppointmentView, r: Readiness | undefined) => {
    const go = () =>
      enc.open(
        {
          patientId: a.patient.id,
          appointmentId: a.id,
          practitionerId: a.practitioner.id,
          locationId: a.location.id,
          encounterId: r?.encounterId,
        },
        "encounter.note",
      );
    if (a.status === "READY_FOR_PROVIDER" || a.status === "ROOMED")
      start.mutate(
        { params: { appointmentId: a.id }, body: { to: "with-provider", version: a.version } },
        { onSuccess: go },
      );
    else go();
  };
  const prechart = (a: AppointmentView, r: Readiness | undefined) =>
    enc.open(
      {
        patientId: a.patient.id,
        appointmentId: a.id,
        practitionerId: a.practitioner.id,
        locationId: a.location.id,
        encounterId: r?.encounterId,
      },
      "encounter.prechart",
    );
  const nextToPrechart = schedule
    .filter((a) => ["BOOKED", "CONFIRMED"].includes(a.status) && !ready.get(a.id)?.precharted)
    .slice(0, 3);

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
            <span className="text-small tabular-nums text-ink-2">
              {ageSex(row.original.patient.birthDate, row.original.patient.sexForClinicalUse)}
              {row.original.room ? ` · ${row.original.room.name}` : ""}
              {row.original.modality === "VIDEO" ? " · video" : ""}
            </span>
          </span>
        ),
      },
      {
        id: "reason",
        header: "Reason",
        enableSorting: false,
        cell: ({ row }) => (
          <span data-testid={tid(S, "col-reason")}>
            {row.original.reason ?? row.original.visitType.name}
          </span>
        ),
      },
      {
        id: "where",
        header: "Where now",
        accessorFn: (a) => a.status,
        cell: ({ row }) => (
          <span className="grid justify-items-start gap-1">
            <StatusChip
              machine="appointment"
              value={row.original.status}
              testId={tid(S, "col-where")}
            />
            {["ARRIVED", "ROOMED", "READY_FOR_PROVIDER"].includes(row.original.status) ? (
              <span className="text-small tabular-nums text-ink-2">
                {row.original.status === "ARRIVED" ? "waiting " : ""}
                {row.original.minutesInStatus ?? 0} min
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "ready",
        header: "Ready?",
        enableSorting: false,
        cell: ({ row }) => {
          const r = ready.get(row.original.id);
          const a = row.original;
          const parts: React.ReactNode[] = [];
          if (r?.vitalsDone)
            parts.push(<span key="v">Vitals ✓{r.vitalAlert ? ` · ${r.vitalAlert}` : ""}</span>);
          else if (["ROOMED", "READY_FOR_PROVIDER"].includes(a.status))
            parts.push(<span key="v">Vitals pending</span>);
          if (r?.pendedOrders)
            parts.push(
              <span key="o" className="text-small text-ink-2">
                {r.pendedOrders} orders pended
              </span>,
            );
          if (["BOOKED", "CONFIRMED"].includes(a.status))
            parts.push(<span key="p">{r?.precharted ? "Pre-charted ✓" : "Not pre-charted"}</span>);
          for (const n of r?.notes ?? [])
            parts.push(
              <Tag key={n} tone="outline" className="outline-dashed">
                {n}
              </Tag>,
            );
          return (
            <span className="grid justify-items-start gap-0.5" data-testid={tid(S, "col-ready")}>
              {parts.length ? parts : "—"}
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
          const r = ready.get(a.id);
          if (["ARRIVED", "ROOMED", "READY_FOR_PROVIDER", "WITH_PROVIDER"].includes(a.status))
            return (
              <Button
                size="sm"
                variant={a.status === "READY_FOR_PROVIDER" ? "primary" : "secondary"}
                disabled={start.isPending || enc.pending}
                onClick={() => openVisit(a, r)}
                data-testid={tid(S, "row-open")}
              >
                Open
              </Button>
            );
          if (["BOOKED", "CONFIRMED"].includes(a.status) && isBuilt("encounter.prechart"))
            return (
              <Button
                size="sm"
                variant="ghost"
                disabled={enc.pending}
                onClick={() => prechart(a, r)}
                data-testid={tid(S, "row-prechart")}
              >
                Pre-chart
              </Button>
            );
          return null;
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, start.isPending, enc.pending],
  );

  const seen = schedule.filter((a) => SEEN.includes(a.status)).length;
  const location = me.locations.find((l) => l.id === me.activeLocationId);
  const oldUnsigned = (data?.unsignedNotes ?? []).filter(
    (n) => noteAgeDays(n.dateOfService) >= 2,
  ).length;
  const sendButton = (
    <Button
      size="sm"
      disabled={!messaging || late.isPending}
      onClick={() => setNotify(true)}
      data-testid={tid(S, "late-notify")}
    >
      Text waiting patients an update
    </Button>
  );
  return (
    <Page>
      <PageHeader
        title={`${isToday ? "Today" : "Tomorrow"} · ${formatDayTitle(day)}`}
        testId={tid(S, "date-title")}
        actions={
          <>
            <Button
              onClick={() => setDay(isToday ? addDaysIso(todayIso(), 1) : todayIso())}
              data-testid={tid(S, "tomorrow")}
            >
              {isToday ? "Tomorrow" : "Back to today"}
            </Button>
            {isBuilt("encounter.prechart") && nextToPrechart.length ? (
              <Button
                onClick={() => prechart(nextToPrechart[0]!, ready.get(nextToPrechart[0]!.id))}
                data-testid={tid(S, "prechart-next")}
              >
                Pre-chart next {nextToPrechart.length}
              </Button>
            ) : null}
          </>
        }
      />
      <p className="-mt-3 text-body text-ink-2">
        {schedule.length} visits · {seen} seen · {schedule.length - seen} to go
        {location ? ` · ${location.name}` : ""}
      </p>
      {isToday && data && data.minutesBehind > 15 ? (
        <Alert
          tone="caution"
          testId={tid(S, "late-alert")}
          title={`You're running ${data.minutesBehind} minutes behind.`}
          action={
            can("sendRunningLateNotice") ? (
              messaging ? (
                sendButton
              ) : (
                <Unavailable reason="Texting patients needs SMS or email to be connected.">
                  {sendButton}
                </Unavailable>
              )
            ) : null
          }
        >
          {data.waitingLong
            ? `${data.waitingLong} patient${data.waitingLong === 1 ? " is" : "s are"} waiting longer than 20 minutes.`
            : ""}
        </Alert>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6">
        <Card>
          <CardHeader
            title="Schedule"
            actions={
              <span className="text-small text-ink-2">
                Readiness from the flow board and pre-chart
              </span>
            }
          />
          <DataTable
            columns={columns}
            data={schedule}
            loading={w.isLoading}
            error={w.error}
            onRetry={() => void w.refetch()}
            empty={isToday ? "No visits today" : "No visits tomorrow"}
            getRowId={(a) => a.id}
            testId={tid(S, "schedule-table")}
          />
        </Card>
        <div className="grid gap-6">
          <Card>
            <CardHeader title="Inbox" />
            <ul>
              <Count
                label="Results to review"
                value={data?.resultsToReview}
                testId={tid(S, "inbox-results")}
                to={isBuilt("inbox.results") ? pathTo("inbox.results") : undefined}
              />
              <Count
                label="Rx renewals & changes"
                value={data?.rxRequests}
                testId={tid(S, "inbox-rx")}
              />
              <Count
                label="Patient messages"
                value={data?.messages}
                testId={tid(S, "inbox-messages")}
              />
              <Count
                label="Co-sign"
                value={data?.pendingCosign}
                testId={tid(S, "inbox-cosign")}
                to={isBuilt("inbox.cosign") ? pathTo("inbox.cosign") : undefined}
              />
            </ul>
          </Card>
          <Card>
            <CardHeader
              title="Unsigned notes"
              actions={
                oldUnsigned ? (
                  <Tag tone="outline" className="outline-dashed">
                    {oldUnsigned} over 48 h
                  </Tag>
                ) : null
              }
            />
            {data?.unsignedNotes.length ? (
              <ul>
                {data.unsignedNotes.map((n) => (
                  <li key={n.id} className="border-b border-line last:border-0">
                    <Pressable
                      type="button"
                      className="flex w-full items-baseline justify-between gap-3 py-3 text-left hover:bg-surface-hover"
                      onClick={() =>
                        navigate(
                          pathTo("encounter.note", {
                            patientId: n.patient.id,
                            encounterId: n.encounterId,
                          }),
                        )
                      }
                      data-testid={tid(S, "unsigned-note")}
                    >
                      <span className="grid">
                        <b className="font-semibold">{n.patient.name}</b>
                        <span className="text-small text-ink-2">
                          {formatShortDate(n.dateOfService)} · {n.title}
                        </span>
                      </span>
                      <span className="shrink-0 text-small tabular-nums">
                        {noteAge(n.dateOfService)}
                      </span>
                    </Pressable>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-ink-2">All notes signed.</p>
            )}
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={notify}
        onOpenChange={setNotify}
        title="Text waiting patients an update?"
        description={`Patients waiting or booked in the next two hours get a text that you're running about ${data?.minutesBehind ?? 0} minutes late. It has no clinical details.`}
        action="Send update"
        testId={tid(S, "late-confirm")}
        onConfirm={() =>
          me.user.practitionerId &&
          late.mutate({
            body: {
              practitionerId: me.user.practitionerId,
              minutes: Math.max(5, Math.min(180, data?.minutesBehind ?? 15)),
              notifyPatients: true,
            },
          })
        }
      />
    </Page>
  );
}

/** Age of an unsigned note in practice calendar days since its date of service. */
const noteAgeDays = (dateOfService: string) =>
  Math.round(
    (new Date(`${todayIso()}T00:00:00Z`).getTime() -
      new Date(`${dateOfService}T00:00:00Z`).getTime()) /
      86_400_000,
  );
const noteAge = (dateOfService: string) => {
  const days = noteAgeDays(dateOfService);
  return days <= 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
};

function Count({
  label,
  value,
  testId,
  to,
}: {
  label: string;
  value: number | undefined;
  testId: string;
  to?: string;
}) {
  const body = (
    <>
      <span className="text-body">{label}</span>
      <b className="text-h2 tabular-nums">{value ?? "—"}</b>
    </>
  );
  return (
    <li className="border-b border-line last:border-0" data-testid={testId}>
      {to ? (
        <Link to={to} className="flex items-center justify-between py-3 hover:bg-surface-hover">
          {body}
        </Link>
      ) : (
        <div className="flex items-center justify-between py-3">{body}</div>
      )}
    </li>
  );
}
