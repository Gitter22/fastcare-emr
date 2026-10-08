import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ClinicalDayList } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { ageSex, formatDayTitle, formatTime, todayIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { Card, CardHeader, Page, PageHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { StatusChip } from "@/components/domain/StatusChip";
import { PatientLink } from "@/features/patients/PatientBits";
import { useOpenEncounter } from "@/features/encounter/useOpenEncounter";

const S = "home.clinical-daylist";
type Row = ClinicalDayList["rows"][number];
const DONE = ["COMPLETED", "NO_SHOW", "LEFT_WITHOUT_BEING_SEEN"];

/** home.clinical-daylist (flow:checkin/03, 05): who needs rooming, protocols or follow-up today. */
export function ClinicalDayListPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const enc = useOpenEncounter();
  const [practitionerId, setPractitionerId] = React.useState("");
  const today = todayIso();
  const list = useApi(
    "getClinicalDayList",
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
  const recalls = useApi(
    "listRecalls",
    { query: { status: ["DUE"] } },
    { enabled: can("listRecalls") && isBuilt("schedule.recall-list") },
  );
  const rows = (list.data?.rows ?? []).filter((r) => !DONE.includes(r.appointment.status));

  const columns = React.useMemo<Col<Row>[]>(
    () => [
      {
        id: "time",
        header: "Time",
        accessorFn: (r) => r.appointment.start,
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap font-semibold tabular-nums"
            data-testid={tid(S, "col-time")}
          >
            {formatTime(row.original.appointment.start)}
          </span>
        ),
      },
      {
        id: "patient",
        header: "Patient",
        accessorFn: (r) => r.appointment.patient.name,
        cell: ({ row }) => (
          <span className="grid" data-testid={tid(S, "col-patient")}>
            <PatientLink patient={row.original.appointment.patient} />
            <span className="text-small tabular-nums text-ink-2">
              {ageSex(
                row.original.appointment.patient.birthDate,
                row.original.appointment.patient.sexForClinicalUse,
              )}{" "}
              · {row.original.appointment.visitType.name} ·{" "}
              {row.original.appointment.practitioner.name}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => r.appointment.status,
        cell: ({ row }) => (
          <span className="grid justify-items-start gap-1">
            <StatusChip
              machine="appointment"
              value={row.original.appointment.status}
              testId={tid(S, "col-status")}
            />
            {["ARRIVED", "ROOMED", "READY_FOR_PROVIDER"].includes(
              row.original.appointment.status,
            ) ? (
              <span className="text-small tabular-nums text-ink-2" data-testid={tid(S, "col-wait")}>
                {row.original.appointment.minutesInStatus ?? 0} min
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "room",
        header: "Room",
        enableSorting: false,
        cell: ({ row }) => (
          <span data-testid={tid(S, "col-room")}>{row.original.appointment.room?.name ?? "—"}</span>
        ),
      },
      {
        id: "protocols",
        header: "Protocols",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="grid gap-0.5 text-small" data-testid={tid(S, "col-protocols")}>
            {row.original.protocols.length ? (
              <span>
                {row.original.protocols.map((p) => p.replace(/ vaccine due$/, "")).join(", ")}{" "}
                {row.original.protocols.length === 1 ? "vaccine" : "vaccines"} due
              </span>
            ) : null}
            {row.original.pendingOrders ? (
              <span>{row.original.pendingOrders} orders pended</span>
            ) : null}
            {row.original.prechartReady ? <span className="text-ink-2">Pre-charted</span> : null}
            {!row.original.protocols.length &&
            !row.original.pendingOrders &&
            !row.original.prechartReady
              ? "—"
              : null}
          </span>
        ),
      },
      {
        id: "action",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) => {
          const a = row.original.appointment;
          if (a.status === "ARRIVED" && can("roomAppointment") && isBuilt("schedule.flow-board"))
            return (
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  navigate(`${pathTo("schedule.flow-board")}?view=room&appointment=${a.id}`)
                }
                data-testid={tid(S, "row-room")}
              >
                Room
              </Button>
            );
          if (
            ["ROOMED", "READY_FOR_PROVIDER", "WITH_PROVIDER"].includes(a.status) &&
            isBuilt("encounter.rooming")
          )
            return (
              <Button
                size="sm"
                disabled={enc.pending}
                onClick={() =>
                  enc.open(
                    {
                      patientId: a.patient.id,
                      appointmentId: a.id,
                      practitionerId: a.practitioner.id,
                      locationId: a.location.id,
                      encounterId: row.original.encounterId,
                    },
                    "encounter.rooming",
                  )
                }
                data-testid={tid(S, "row-rooming")}
              >
                Rooming
              </Button>
            );
          return null;
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can, enc.pending],
  );

  const location = me.locations.find((l) => l.id === me.activeLocationId);
  const count = (s: string[]) => rows.filter((r) => s.includes(r.appointment.status)).length;
  return (
    <Page>
      <PageHeader
        title={`Today · ${formatDayTitle(today)}`}
        testId={tid(S, "date-title")}
        actions={
          <Select
            aria-label="Provider"
            testId={tid(S, "provider-filter")}
            className="w-56"
            value={practitionerId}
            onValueChange={(v) => setPractitionerId(v === "ALL" ? "" : v)}
            placeholder="All providers"
            options={[
              { value: "ALL", label: "All providers" },
              ...(practitioners.data ?? [])
                .filter((p) => p.npi)
                .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}` })),
            ]}
          />
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)_280px] items-start gap-6">
        <Card>
          <CardHeader
            title="Patients"
            actions={
              <span className="text-small text-ink-2">
                {location?.name ?? ""} · {count(["ARRIVED"])} to room · {count(["ROOMED"])} in
                rooming
              </span>
            }
          />
          <DataTable
            columns={columns}
            data={rows}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty="No patients left today"
            getRowId={(r) => r.appointment.id}
            testId={tid(S, "daylist-table")}
          />
        </Card>
        <Card>
          <CardHeader title="Work" />
          <ul className="grid gap-3 text-body">
            {isBuilt("schedule.recall-list") && can("listRecalls") ? (
              <li className="flex items-center justify-between">
                <Link
                  to={pathTo("schedule.recall-list")}
                  className="underline underline-offset-4 hover:text-pine-700"
                  data-testid={tid(S, "recall-link")}
                >
                  Recalls due
                </Link>
                <b className="tabular-nums">{recalls.data?.data?.length ?? "—"}</b>
              </li>
            ) : null}
            {isBuilt("schedule.flow-board") ? (
              <li>
                <Link
                  to={pathTo("schedule.flow-board")}
                  className="underline underline-offset-4 hover:text-pine-700"
                  data-testid={tid(S, "flow-board-link")}
                >
                  Open flow board
                </Link>
              </li>
            ) : null}
          </ul>
        </Card>
      </div>
    </Page>
  );
}
