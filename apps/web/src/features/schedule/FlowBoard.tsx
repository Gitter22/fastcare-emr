import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import type { AppointmentStatus, FlowBoard } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiAll, useApiMutation } from "@/lib/api/hooks";
import {
  ageSex,
  dayRangeIso,
  formatDate,
  formatDayTitle,
  formatTime,
  status,
  todayIso,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Alert, ErrorState, LoadingRows, PageHeader } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Select, Switch } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { SubNav } from "@/shell/patterns";

const S = "schedule.flow-board";
const COLUMNS: Array<{ status: AppointmentStatus; id: string }> = [
  { status: "ARRIVED", id: "col-arrived" },
  { status: "ROOMED", id: "col-roomed" },
  { status: "READY_FOR_PROVIDER", id: "col-ready" },
  { status: "WITH_PROVIDER", id: "col-with" },
  { status: "CHECKOUT", id: "col-checkout" },
];
type Row = FlowBoard["rows"][number];

/** schedule.flow-board (flow:checkin/02-03): where every patient is right now, with wait timers. */
export function FlowBoardPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [practitionerId, setPractitionerId] = React.useState("");
  const [mine, setMine] = React.useState(false);
  const board = useApi(
    "getFlowBoard",
    {
      query: {
        date: todayIso(),
        ...(me.activeLocationId ? { locationId: me.activeLocationId } : {}),
        ...(practitionerId ? { practitionerId } : {}),
      },
    },
    { refetchInterval: 20_000 },
  );
  const day = useApiAll(
    "listAppointments",
    {
      query: {
        ...dayRangeIso(todayIso()),
        ...(me.activeLocationId ? { locationId: me.activeLocationId } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const practitioners = useApi("listPractitioners", { query: {} });
  const inv = ["getFlowBoard", "getFrontDeskBoard", "listAppointments", "getRoomBoard"] as const;
  const lwbs = useApiMutation("markLeftWithoutBeingSeen", {
    invalidates: [...inv],
    onSuccess: () => toast("Marked as left without being seen."),
    onError: (e) => toast(errorMessage(e)),
  });
  const ready = useApiMutation("markReadyForProvider", {
    invalidates: [...inv],
    onSuccess: () => toast("Ready for provider."),
    onError: (e) => toast(errorMessage(e)),
  });
  const start = useApiMutation("startVisit", {
    invalidates: [...inv],
    onError: (e) => toast(errorMessage(e)),
  });
  const end = useApiMutation("endVisit", {
    invalidates: [...inv],
    onSuccess: () => toast("Sent to checkout."),
    onError: (e) => toast(errorMessage(e)),
  });

  const rows = (board.data?.rows ?? []).filter(
    (r) => !mine || r.appointment.practitioner.id === me.user.practitionerId,
  );
  const target = board.data?.thresholds.find((t) => t.status === "ARRIVED")?.minutes ?? 15;
  const all = day.data ?? [];
  const roomTimes = (board.data?.rows ?? []).length;
  const roomingId = params.get("view") === "room" ? params.get("appointment") : null;

  const card = (r: Row) => {
    const a = r.appointment;
    const roleAct = (what: string) => can(what as never);
    return (
      <article
        key={a.id}
        className={cn(
          "grid gap-2 bg-surface p-4",
          r.overThreshold && "shadow-[inset_0_0_0_2px_var(--color-ink)]",
        )}
        data-testid={tid(S, "patient-card")}
      >
        <div className="flex items-start justify-between gap-2">
          {isBuilt("chart.summary") || isBuilt("chart.demographics") ? (
            <button
              type="button"
              className="text-left text-h3 text-ink hover:underline"
              onClick={() =>
                navigate(
                  pathTo(isBuilt("chart.summary") ? "chart.summary" : "chart.demographics", {
                    patientId: a.patient.id,
                  }),
                )
              }
              data-testid={tid(S, "card-name")}
            >
              {a.patient.name}
            </button>
          ) : (
            <span className="text-h3 text-ink" data-testid={tid(S, "card-name")}>
              {a.patient.name}
            </span>
          )}
          <span
            className="whitespace-nowrap text-label tabular-nums text-ink"
            data-testid={tid(S, "card-timer")}
          >
            {r.waitMinutes} min
          </span>
        </div>
        <p className="text-small text-ink-2">
          {ageSex(a.patient.birthDate, a.patient.sexForClinicalUse)} · {a.visitType.name} ·{" "}
          {a.practitioner.name}
          {a.room ? ` · ${a.room.name}` : ""}
        </p>
        <div className="flex flex-wrap gap-1">
          {r.overThreshold ? (
            <Tag tone="caution" data-testid={tid(S, "card-over")}>
              Over target by{" "}
              {r.waitMinutes -
                (board.data?.thresholds.find((t) => t.status === r.stage)?.minutes ?? target)}{" "}
              min
            </Tag>
          ) : null}
          {a.modality === "VIDEO" ? <Tag>Video</Tag> : null}
          {a.patient.flags.includes("interpreter") ? <Tag tone="outline">Interpreter</Tag> : null}
        </div>
        <div className="flex items-center gap-2">
          {r.stage === "ARRIVED" && roleAct("roomAppointment") ? (
            <Button
              size="sm"
              variant={r.overThreshold ? "primary" : "secondary"}
              onClick={() => setParams({ view: "room", appointment: a.id })}
              data-testid={tid(S, "card-room")}
            >
              Room
            </Button>
          ) : null}
          {r.stage === "ROOMED" && isBuilt("encounter.rooming") ? (
            <Button
              size="sm"
              data-testid={tid(S, "card-open")}
              onClick={async () => {
                const d = await api("getAppointment", { params: { appointmentId: a.id } });
                if (d.encounterId)
                  navigate(
                    pathTo("encounter.rooming", {
                      patientId: a.patient.id,
                      encounterId: d.encounterId,
                    }),
                  );
              }}
            >
              Open
            </Button>
          ) : null}
          {r.stage === "ROOMED" &&
          roleAct("markReadyForProvider") &&
          !isBuilt("encounter.rooming") ? (
            <Button
              size="sm"
              onClick={() =>
                ready.mutate({
                  params: { appointmentId: a.id },
                  body: { to: "ready-for-provider", version: a.version },
                })
              }
            >
              Ready for provider
            </Button>
          ) : null}
          {(r.stage === "READY_FOR_PROVIDER" || r.stage === "ROOMED") &&
          roleAct("startVisit") &&
          me.user.practitionerId === a.practitioner.id ? (
            <Button
              size="sm"
              onClick={() =>
                start.mutate({
                  params: { appointmentId: a.id },
                  body: { to: "with-provider", version: a.version },
                })
              }
            >
              Start visit
            </Button>
          ) : null}
          {r.stage === "WITH_PROVIDER" && roleAct("endVisit") ? (
            <Button
              size="sm"
              onClick={() =>
                end.mutate({
                  params: { appointmentId: a.id },
                  body: { to: "checkout", version: a.version },
                })
              }
            >
              Done · to checkout
            </Button>
          ) : null}
          {r.stage === "CHECKOUT" && isBuilt("schedule.checkout") && roleAct("getCheckout") ? (
            <Button
              size="sm"
              onClick={() => navigate(pathTo("schedule.checkout", { appointmentId: a.id }))}
              data-testid={tid(S, "card-checkout")}
            >
              Check out
            </Button>
          ) : null}
          {["ARRIVED", "ROOMED", "READY_FOR_PROVIDER"].includes(r.stage) &&
          roleAct("markLeftWithoutBeingSeen") ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="More actions"
                  data-testid={tid(S, "card-menu")}
                >
                  <MoreHorizontal size={18} strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  danger
                  onSelect={() =>
                    lwbs.mutate({
                      params: { appointmentId: a.id },
                      body: { to: "left-without-being-seen", version: a.version },
                    })
                  }
                >
                  Left without being seen
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div className="grid content-start gap-6 p-8">
      <SubNav which="schedule" />
      <PageHeader
        title="Flow board"
        actions={
          <>
            <Select
              aria-label="Provider"
              testId={tid(S, "provider-seg")}
              className="w-48"
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
            {me.user.practitionerId ? (
              <Switch
                checked={mine}
                onCheckedChange={setMine}
                label="My patients only"
                data-testid={tid(S, "my-patients")}
              />
            ) : null}
            <span className="text-small text-ink-2" data-testid={tid(S, "wait-target")}>
              Wait target: {target} min
            </span>
          </>
        }
      />
      <p className="sr-only">
        {formatDayTitle(todayIso())} · {formatTime(new Date().toISOString())}
      </p>
      {board.isLoading ? (
        <LoadingRows />
      ) : board.error ? (
        <ErrorState onRetry={() => void board.refetch()} />
      ) : (
        <div className="grid grid-cols-5 items-start gap-4">
          {COLUMNS.map((c) => {
            const list = rows
              .filter((r) => r.stage === c.status)
              .sort((a, b) => b.waitMinutes - a.waitMinutes);
            return (
              <section
                key={c.status}
                className="grid content-start gap-3 bg-surface-muted p-3"
                data-testid={tid(S, c.id)}
              >
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-h3 text-ink">{status("appointment", c.status)}</h2>
                  <span className="text-label tabular-nums text-ink">{list.length}</span>
                </div>
                {list.map(card)}
                {!list.length ? (
                  <p className="px-1 py-4 text-small text-ink-2">Nobody here</p>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
      <footer
        className="flex flex-wrap items-center gap-6 bg-surface px-6 py-4 text-body"
        data-testid={tid(S, "counts")}
      >
        <span>
          <b className="tabular-nums">{all.filter((a) => a.status === "COMPLETED").length}</b>{" "}
          completed
        </span>
        <span>
          <b className="tabular-nums">{all.filter((a) => a.status === "NO_SHOW").length}</b> no-show
        </span>
        <span>
          <b className="tabular-nums">
            {all.filter((a) => a.status === "LEFT_WITHOUT_BEING_SEEN").length}
          </b>{" "}
          left without being seen
        </span>
        <span>
          <b className="tabular-nums">
            {all.filter((a) => a.status === "BOOKED" || a.status === "CONFIRMED").length}
          </b>{" "}
          still to arrive
        </span>
        <span className="ml-auto text-ink-2" data-testid={tid(S, "avg-room-time")}>
          {roomTimes} in clinic
        </span>
      </footer>
      <RoomDialog
        appointmentId={roomingId}
        rows={board.data?.rows ?? []}
        onClose={() => setParams({})}
      />
    </div>
  );
}

/** schedule.flow-board#room (flow:checkin/03): confirm identity, pick a free room, start intake. */
function RoomDialog({
  appointmentId,
  rows,
  onClose,
}: {
  appointmentId: string | null;
  rows: Row[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const me = useMe();
  const row = rows.find((r) => r.appointment.id === appointmentId);
  const rooms = useApi(
    "listRooms",
    { params: { locationId: row?.appointment.location.id ?? "" } },
    { enabled: !!row },
  );
  const [roomId, setRoomId] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  React.useEffect(() => {
    setRoomId("");
    setConfirmed(false);
  }, [appointmentId]);
  const room = useApiMutation("roomAppointment", {
    invalidates: ["getFlowBoard", "getRoomBoard", "getFrontDeskBoard", "listAppointments"],
    onSuccess: (enc) => {
      toast(`Roomed. Intake is open.`);
      onClose();
      if (isBuilt("encounter.rooming"))
        navigate(pathTo("encounter.rooming", { patientId: enc.patientId, encounterId: enc.id }));
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const a = row?.appointment;
  const free = (rooms.data ?? []).filter((r) => r.active && !r.isVirtual && r.status === "READY");
  return (
    <Dialog open={!!appointmentId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid={`${S}#room`}>
        <DialogHeader>
          <DialogTitle>Room patient</DialogTitle>
        </DialogHeader>
        {a ? (
          <>
            <div className="bg-surface-muted p-4" data-testid={tid(S, "room-confirm-patient")}>
              <p className="text-h3 text-ink">{a.patient.name}</p>
              <p className="text-body tabular-nums text-ink">
                DOB {formatDate(a.patient.birthDate)} · MRN {a.patient.mrn}
              </p>
            </div>
            <Button
              variant={confirmed ? "ghost" : "secondary"}
              className="justify-self-start"
              onClick={() => setConfirmed(true)}
              disabled={confirmed}
            >
              {confirmed
                ? "Name and date of birth confirmed"
                : "Confirm name and date of birth with the patient"}
            </Button>
            {free.length ? (
              <FieldShell label="Room">
                <Select
                  testId={tid(S, "room-select")}
                  value={roomId}
                  onValueChange={setRoomId}
                  placeholder="Choose a free room"
                  options={free.map((r) => ({ value: r.id, label: r.name }))}
                />
              </FieldShell>
            ) : (
              <Alert tone="caution">No room is free. Mark a room ready on the room board.</Alert>
            )}
            <p className="text-small text-ink-2" data-testid={tid(S, "room-ma")}>
              Assigned to you ({me.user.name}).
            </p>
          </>
        ) : (
          <LoadingRows rows={2} />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid={tid(S, "room-cancel")}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!a || !roomId || !confirmed}
            loading={room.isPending}
            onClick={() =>
              a &&
              room.mutate({ params: { appointmentId: a.id }, body: { roomId, version: a.version } })
            }
            data-testid={tid(S, "room-submit")}
          >
            Room & start intake
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
