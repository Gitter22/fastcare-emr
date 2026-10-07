import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { AppointmentDetail } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import {
  ageSex,
  formatDate,
  formatDateTime,
  formatDayTitle,
  formatTime,
  status,
  zonedParts,
} from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Field, LoadingRows } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EligibilityChip } from "@/components/domain/Eligibility";
import { StatusChip } from "@/components/domain/StatusChip";
import { PatientLink } from "@/features/patients/PatientBits";

const S = "schedule.appointment-detail";
const UPCOMING = ["REQUESTED", "BOOKED", "CONFIRMED"];

/** schedule.appointment-detail (drawer): status, reminders, eligibility, notes and history for one appointment. */
export function AppointmentDrawer({
  appointmentId,
  onClose,
}: {
  appointmentId: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!appointmentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="w-[560px]" data-testid={S}>
        {appointmentId ? <Detail appointmentId={appointmentId} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const detail = useApi("getAppointment", { params: { appointmentId } });
  const [comment, setComment] = React.useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inv = [
    "getAppointment",
    "listAppointments",
    "getFrontDeskBoard",
    "getFlowBoard",
    "searchAvailability",
  ] as const;
  const onError = (e: Error) => setError(errorMessage(e));
  const save = useApiMutation("updateAppointment", {
    invalidates: [...inv],
    onSuccess: () => (toast("Note saved."), setComment(null)),
    onError,
  });
  const confirm = useApiMutation("confirmAppointment", {
    invalidates: [...inv],
    onSuccess: () => toast("Appointment confirmed."),
    onError,
  });
  const noShow = useApiMutation("markNoShow", {
    invalidates: [...inv],
    onSuccess: () => toast("Marked as no-show."),
    onError,
  });

  if (detail.isLoading || !detail.data)
    return (
      <SheetBody className="pt-6">
        <LoadingRows />
      </SheetBody>
    );
  const d: AppointmentDetail = detail.data;
  const a = d.appointment;
  const today = zonedParts(a.start).date === zonedParts(new Date().toISOString()).date;
  const allowed = new Set(d.allowedTransitions.map((t) => t.split("->")[1]));
  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          <SheetTitle>
            <PatientLink patient={a.patient} testId={tid(S, "appt-patient")} />
          </SheetTitle>
          <StatusChip machine="appointment" value={a.status} testId={tid(S, "appt-status")} />
        </div>
        <p className="text-small tabular-nums text-ink-2">
          DOB {formatDate(a.patient.birthDate)} ·{" "}
          {ageSex(a.patient.birthDate, a.patient.sexForClinicalUse)} · MRN {a.patient.mrn}
        </p>
      </SheetHeader>
      <SheetBody className="grid content-start gap-6">
        {error ? <Alert tone="caution">{error}</Alert> : null}
        <dl className="grid grid-cols-2 gap-4">
          <Field label="When" className="col-span-2">
            <span data-testid={tid(S, "appt-when")}>
              {formatDayTitle(zonedParts(a.start).date)} · {formatTime(a.start)}–{formatTime(a.end)}{" "}
              · {a.practitioner.name} · {a.modality === "VIDEO" ? "Video" : a.location.name}
              {a.room ? ` · ${a.room.name}` : ""}
            </span>
          </Field>
          <Field label="Visit type">{a.visitType.name}</Field>
          <Field label="Reason">
            <span data-testid={tid(S, "appt-reason")}>{a.reason ?? "—"}</span>
          </Field>
          <Field label="Eligibility">
            <span className="grid gap-0.5" data-testid={tid(S, "appt-eligibility")}>
              <EligibilityChip status={a.eligibility} selfPay={!a.eligibility} />
              {d.eligibility?.respondedAt ? (
                <span className="text-small text-ink-2">
                  Checked {formatDateTime(d.eligibility.respondedAt)}
                </span>
              ) : null}
            </span>
          </Field>
          <Field label="Forms">
            {a.formsOutstanding ? `${a.formsOutstanding} to sign` : "Complete"}
          </Field>
        </dl>
        <FieldShell label="Front-desk note">
          <Textarea
            value={comment ?? ""}
            placeholder="Add a note for the front desk"
            onChange={(e) => setComment(e.target.value)}
            data-testid={tid(S, "appt-notes")}
          />
          {comment !== null ? (
            <Button
              size="sm"
              className="justify-self-start"
              loading={save.isPending}
              onClick={() =>
                save.mutate({ params: { appointmentId }, version: a.version, body: { comment } })
              }
            >
              Save note
            </Button>
          ) : null}
        </FieldShell>
        <section className="grid gap-2">
          <h3 className="text-h3 text-ink">Reminders and replies</h3>
          {d.communications.length ? (
            <ul className="grid gap-1 text-body" data-testid={tid(S, "appt-reminders")}>
              {d.communications.map((c) => (
                <li key={c.id} className="flex justify-between gap-3">
                  <span>
                    {c.purpose.replace(/-/g, " ")} ·{" "}
                    {c.channel === "SMS" ? "text" : c.channel.toLowerCase()}
                  </span>
                  <span className="text-small text-ink-2">
                    {c.status === "FAILED"
                      ? `Not sent${c.error === "no-sms-consent" ? " (no text consent)" : ""}`
                      : formatDateTime(c.sentAt ?? c.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-ink-2">No messages yet.</p>
          )}
        </section>
        <section className="grid gap-2">
          <h3 className="text-h3 text-ink">History</h3>
          <ol className="grid gap-1 text-body" data-testid={tid(S, "appt-history")}>
            {d.statusHistory.map((h) => (
              <li key={h.id} className="flex justify-between gap-3">
                <span>
                  {status("appointment", h.toStatus)}
                  {h.note ? <span className="text-ink-2"> · {h.note}</span> : null}
                </span>
                <span className="text-small tabular-nums text-ink-2">{formatDateTime(h.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      </SheetBody>
      <SheetFooter className="flex-wrap">
        {UPCOMING.includes(a.status) && can("cancelAppointment") ? (
          <Button
            variant="ghost"
            onClick={() => setCancelOpen(true)}
            data-testid={tid(S, "appt-cancel")}
          >
            Cancel appointment
          </Button>
        ) : null}
        {allowed.has("no-show") && new Date(a.start) < new Date() && can("markNoShow") ? (
          <Button
            variant="ghost"
            loading={noShow.isPending}
            onClick={() =>
              noShow.mutate({
                params: { appointmentId },
                body: { to: "no-show", version: a.version },
              })
            }
            data-testid={tid(S, "appt-no-show")}
          >
            Mark no-show
          </Button>
        ) : null}
        {a.modality === "VIDEO" && isBuilt("telehealth.waiting-room") ? (
          <Button
            variant="ghost"
            onClick={() => navigate(pathTo("telehealth.waiting-room"))}
            data-testid={tid(S, "appt-join-video")}
          >
            Video link
          </Button>
        ) : null}
        <span className="flex-1" />
        {UPCOMING.slice(1).includes(a.status) && can("rescheduleAppointment") ? (
          <Button
            onClick={() => navigate(`${pathTo("schedule.booking-drawer")}?reschedule=${a.id}`)}
            data-testid={tid(S, "appt-reschedule")}
          >
            Reschedule
          </Button>
        ) : null}
        {a.status === "BOOKED" && can("confirmAppointment") ? (
          <Button
            loading={confirm.isPending}
            onClick={() =>
              confirm.mutate({
                params: { appointmentId },
                body: { to: "confirmed", version: a.version },
              })
            }
          >
            Mark confirmed
          </Button>
        ) : null}
        {(a.status === "BOOKED" || a.status === "CONFIRMED") &&
        today &&
        can("arriveAppointment") &&
        isBuilt("home.frontdesk-board") ? (
          <Button
            variant="primary"
            onClick={() =>
              navigate(pathTo("home.frontdesk-board", {}, "arrive", { appointment: a.id }))
            }
            data-testid={tid(S, "appt-arrive")}
          >
            Arrive
          </Button>
        ) : null}
      </SheetFooter>
      <CancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        appointmentId={appointmentId}
        version={a.version}
        onDone={onClose}
      />
    </>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  appointmentId,
  version,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  appointmentId: string;
  version: number;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = React.useState<"patient" | "provider" | "weather" | "other">(
    "patient",
  );
  const [reason, setReason] = React.useState("");
  const [waitlist, setWaitlist] = React.useState(true);
  const [notify, setNotify] = React.useState(true);
  const cancel = useApiMutation("cancelAppointment", {
    invalidates: ["getAppointment", "listAppointments", "getFrontDeskBoard", "searchAvailability"],
    onSuccess: () => (toast("Appointment cancelled."), onOpenChange(false), onDone()),
    onError: (e) => toast(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={`${S}#cancel`}>
        <DialogHeader>
          <DialogTitle>Cancel appointment?</DialogTitle>
        </DialogHeader>
        <FieldShell label="Reason">
          <Select
            testId={tid(S, "cancel-reason")}
            value={reasonCode}
            onValueChange={setReasonCode}
            options={[
              { value: "patient", label: "Patient request" },
              { value: "provider", label: "Provider unavailable" },
              { value: "weather", label: "Weather or closure" },
              { value: "other", label: "Other" },
            ]}
          />
        </FieldShell>
        <FieldShell label="Details">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldShell>
        <Checkbox
          checked={waitlist}
          onCheckedChange={(c) => setWaitlist(c === true)}
          label="Offer the slot to the waitlist"
          data-testid={tid(S, "cancel-offer-waitlist")}
        />
        <Checkbox
          checked={notify}
          onCheckedChange={(c) => setNotify(c === true)}
          label="Notify the patient"
          data-testid={tid(S, "cancel-notify")}
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid={tid(S, "cancel-back")}
          >
            Keep appointment
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate({
                params: { appointmentId },
                body: {
                  reasonCode,
                  reason:
                    reason.trim() ||
                    {
                      patient: "Patient request",
                      provider: "Provider unavailable",
                      weather: "Weather or closure",
                      other: "Other",
                    }[reasonCode],
                  notify,
                  offerToWaitlist: waitlist,
                  version,
                },
              })
            }
            data-testid={tid(S, "cancel-confirm")}
          >
            Cancel appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
