import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { Modality, PatientSummary } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDayTitle, formatTime, money, zonedParts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, LoadingRows } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EligibilityChip } from "@/components/domain/Eligibility";
import { PatientIdentity } from "@/features/patients/PatientBits";
import { PatientPicker } from "@/features/patients/PatientPicker";

const S = "schedule.booking-drawer";

/**
 * schedule.booking-drawer (flow:access/02): book in under 60 seconds. Search before create (INV-ID-02 starts at
 * registration), slot finder over the provider templates, insurance check, reminder preview (no clinical detail).
 */
export function BookingDrawer({
  open,
  onClose,
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  defaultDate: string;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="w-[640px]" data-testid={S}>
        {open ? <BookingForm onClose={onClose} defaultDate={defaultDate} /> : null}
      </SheetContent>
    </Sheet>
  );
}

type TimeOfDay = "any" | "morning" | "afternoon";

function BookingForm({ onClose, defaultDate }: { onClose: () => void; defaultDate: string }) {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const visitTypes = useApi("listVisitTypes");
  const practitioners = useApi("listPractitioners", { query: {} });
  const locations = useApi("listLocations");
  const [visitTypeId, setVisitTypeId] = React.useState("");
  const [practitionerId, setPractitionerId] = React.useState(params.get("practitionerId") ?? "");
  const [where, setWhere] = React.useState<string>(me?.activeLocationId ?? "");
  const [reason, setReason] = React.useState("");
  const [timeOfDay, setTimeOfDay] = React.useState<TimeOfDay>("any");
  const [slot, setSlot] = React.useState<{
    start: string;
    practitionerId: string;
    locationId: string;
  } | null>(null);
  const [overbookReason, setOverbookReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Reschedule mode (?reschedule=<appointmentId>): same patient, visit type and provider; moves the booking.
  const rescheduleId = params.get("reschedule");
  const existing = useApi(
    "getAppointment",
    { params: { appointmentId: rescheduleId ?? "" } },
    { enabled: !!rescheduleId },
  );
  React.useEffect(() => {
    const a = existing.data?.appointment;
    if (!a) return;
    setPatient(a.patient);
    setVisitTypeId(a.visitType.id);
    setPractitionerId(a.practitioner.id);
    setReason(a.reason ?? "");
    if (a.modality === "VIDEO") setWhere("video");
    else setWhere(a.location.id);
  }, [existing.data]);
  const reschedule = useApiMutation("rescheduleAppointment", {
    invalidates: ["listAppointments", "getFrontDeskBoard", "searchAvailability", "getAppointment"],
    onSuccess: (a) => {
      toast(
        `Moved to ${formatDayTitle(zonedParts(a.start).date)} ${formatTime(a.start)}. The patient was notified.`,
      );
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  // Preselect from the URL: ?patientId= (from patient search / registration) and ?start= (open slot click).
  React.useEffect(() => {
    const id = params.get("patientId");
    if (id && !patient) {
      api("getPatientBanner", { params: { patientId: id } })
        .then((b) =>
          setPatient({
            id: b.id,
            mrn: b.mrn,
            name: b.name,
            birthDate: b.birthDate,
            flags: b.flags,
            ...(b.sexForClinicalUse ? { sexForClinicalUse: b.sexForClinicalUse } : {}),
          }),
        )
        .catch(() => undefined);
    }
  }, [params, patient]);
  React.useEffect(() => {
    if (!visitTypeId && visitTypes.data?.length)
      setVisitTypeId(
        (visitTypes.data.find((v) => v.name === "Follow-up") ??
          visitTypes.data.find((v) => v.active))!.id,
      );
  }, [visitTypes.data, visitTypeId]);

  const vt = visitTypes.data?.find((v) => v.id === visitTypeId);
  const locs = (locations.data ?? []).filter((l) => l.active);
  const video = where === "video";
  const modality: Modality = video ? "VIDEO" : "IN_PERSON";
  const physicalLoc = video
    ? (locs.find((l) => l.placeOfService === "10") ?? locs[0])
    : locs.find((l) => l.id === where);
  const startParam = params.get("start");
  const fromDate = startParam
    ? zonedParts(startParam.length > 16 ? startParam : `${startParam}:00`).date
    : defaultDate;
  const slots = useApi(
    "searchAvailability",
    {
      query: {
        visitTypeId,
        ...(practitionerId ? { practitionerId } : {}),
        ...(physicalLoc && !video ? { locationId: physicalLoc.id } : {}),
        modality,
        fromDate,
        timeOfDay,
      },
    },
    { enabled: !!visitTypeId },
  );
  React.useEffect(() => {
    if (startParam && slots.data && !slot) {
      const match = slots.data.slots.find(
        (s) => s.start === startParam && (!practitionerId || s.practitionerId === practitionerId),
      );
      if (match)
        setSlot({
          start: match.start,
          practitionerId: match.practitionerId,
          locationId: match.locationId,
        });
    }
  }, [slots.data, startParam, slot, practitionerId]);

  const coverages = useApi(
    "listCoverages",
    { params: { patientId: patient?.id ?? "" } },
    { enabled: !!patient },
  );
  const primary = coverages.data?.find((c) => c.status === "active");
  const elig = useApiMutation("checkEligibility", { invalidates: ["listCoverages"] });
  const book = useApiMutation("bookAppointment", {
    invalidates: ["listAppointments", "getFrontDeskBoard", "searchAvailability", "listWaitlist"],
    onSuccess: (a) => {
      toast(
        `Booked ${a.patient.name} · ${formatDayTitle(zonedParts(a.start).date)} ${formatTime(a.start)}. Confirmation sent.`,
      );
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "slot_unavailable") {
        setError("That time was just taken. Pick another slot.");
        setSlot(null);
        void slots.refetch();
      } else setError(errorMessage(e));
    },
  });
  const addWaitlist = useApiMutation("createWaitlistEntry", {
    invalidates: ["listWaitlist"],
    onSuccess: () => (toast("Added to the waitlist."), onClose()),
  });

  // Group slots by provider, first 8 each.
  const byProvider = React.useMemo(() => {
    const m = new Map<
      string,
      { name: string; slots: Array<{ start: string; practitionerId: string; locationId: string }> }
    >();
    for (const s of slots.data?.slots ?? []) {
      const g = m.get(s.practitionerId) ?? { name: s.practitionerName, slots: [] };
      if (g.slots.length < 8) g.slots.push(s);
      m.set(s.practitionerId, g);
    }
    return [...m.entries()];
  }, [slots.data]);

  const practice = me?.practice.name ?? "Your practice";
  const chosenProvider = practitioners.data?.find((p) => p.id === slot?.practitionerId);
  return (
    <>
      <SheetHeader>
        <SheetTitle data-testid={tid(S, "book-title")}>
          {rescheduleId ? "Reschedule appointment" : "Book appointment"}
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="grid content-start gap-6">
        {error ? <Alert tone="caution">{error}</Alert> : null}
        <section className="grid gap-2">
          <FieldShell label="Patient">
            {patient ? (
              <div
                className="flex items-center justify-between gap-3 p-4 shadow-[inset_0_0_0_1.5px_var(--color-ink)]"
                data-testid={tid(S, "patient-picked")}
              >
                <PatientIdentity p={patient} />
                {rescheduleId ? null : (
                  <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                    Change
                  </Button>
                )}
              </div>
            ) : (
              <PatientPicker
                value={null}
                onChange={setPatient}
                placeholder="Name, DOB, phone or MRN"
                testId={tid(S, "patient-typeahead")}
              />
            )}
          </FieldShell>
          {!patient && isBuilt("patients.registration") && can("createPatient") ? (
            <Button
              variant="link"
              className="justify-self-start"
              onClick={() => navigate(pathTo("patients.registration"))}
              data-testid={tid(S, "register-new")}
            >
              Not found? Register new patient
            </Button>
          ) : null}
        </section>
        <section className="grid grid-cols-3 gap-3">
          <FieldShell label="Visit type">
            <Select
              testId={tid(S, "visit-type")}
              value={visitTypeId}
              onValueChange={(v) => (setVisitTypeId(v), setSlot(null))}
              options={(visitTypes.data ?? [])
                .filter((v) => v.active)
                .map((v) => ({ value: v.id, label: `${v.name} · ${v.durationMinutes} min` }))}
            />
          </FieldShell>
          <FieldShell label="Provider">
            <Select
              testId={tid(S, "provider")}
              value={practitionerId || "ANY"}
              onValueChange={(v) => (setPractitionerId(v === "ANY" ? "" : v), setSlot(null))}
              options={[
                { value: "ANY", label: "Any provider" },
                ...(practitioners.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => ({
                    value: p.id,
                    label: `${p.firstName} ${p.lastName}${p.credential ? `, ${p.credential}` : ""}`,
                  })),
              ]}
            />
          </FieldShell>
          <FieldShell label="Where">
            <Select
              testId={tid(S, "modality")}
              value={where}
              onValueChange={(v) => (setWhere(v), setSlot(null))}
              options={[
                ...locs
                  .filter((l) => l.placeOfService !== "10")
                  .map((l) => ({ value: l.id, label: `${l.name} · in person` })),
                ...(vt?.modalities.includes("VIDEO")
                  ? [{ value: "video", label: "Video visit" }]
                  : []),
              ]}
            />
          </FieldShell>
          <FieldShell label="Reason (shown to clinical staff)" className="col-span-3">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid={tid(S, "reason")}
            />
          </FieldShell>
        </section>
        <section className="grid gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-h3 text-ink">Available times</h3>
            <Tabs value={timeOfDay} onValueChange={(v) => setTimeOfDay(v as TimeOfDay)}>
              <TabsList data-testid={tid(S, "time-of-day")}>
                <TabsTrigger value="any">Any</TabsTrigger>
                <TabsTrigger value="morning">Mornings</TabsTrigger>
                <TabsTrigger value="afternoon">Afternoons</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {slots.isLoading ? <LoadingRows rows={3} /> : null}
          {slots.data && !slots.data.slots.length ? (
            <Alert
              testId={tid(S, "no-slots")}
              action={
                patient && can("createWaitlistEntry") ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      addWaitlist.mutate({
                        body: {
                          patientId: patient.id,
                          visitTypeId,
                          ...(practitionerId ? { practitionerId } : {}),
                        },
                      })
                    }
                    data-testid={tid(S, "add-waitlist")}
                  >
                    Add to waitlist
                  </Button>
                ) : null
              }
            >
              No openings in the next two weeks.
              {slots.data.nextAvailable
                ? ` Earliest: ${formatDayTitle(zonedParts(slots.data.nextAvailable).date)} ${formatTime(slots.data.nextAvailable)}.`
                : ""}
            </Alert>
          ) : null}
          {byProvider.map(([pid, g]) => (
            <div key={pid} className="grid gap-2">
              <span className="text-label text-ink">{g.name}</span>
              <div className="flex flex-wrap gap-2">
                {g.slots.map((s) => {
                  const active =
                    slot?.start === s.start && slot.practitionerId === s.practitionerId;
                  return (
                    <button
                      key={s.start}
                      type="button"
                      data-testid={tid(S, "slot")}
                      aria-pressed={active}
                      onClick={() =>
                        setSlot({
                          start: s.start,
                          practitionerId: s.practitionerId,
                          locationId: s.locationId,
                        })
                      }
                      className={cn(
                        "h-control-md px-3 text-body tabular-nums transition-colors duration-fast",
                        active
                          ? "bg-ink text-on-primary"
                          : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-surface-hover",
                      )}
                    >
                      {formatDayTitle(zonedParts(s.start).date).split(",")[0]}{" "}
                      {zonedParts(s.start).date.slice(8)} · {formatTime(s.start)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {can("bookAppointment") &&
          slot === null &&
          byProvider.length === 0 &&
          !slots.isLoading ? (
            <FieldShell
              label="Overbook reason"
              hint="Booking outside open slots needs a reason (recorded)."
            >
              <Textarea
                value={overbookReason}
                onChange={(e) => setOverbookReason(e.target.value)}
              />
            </FieldShell>
          ) : null}
        </section>
        {patient ? (
          <section className="grid gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-h3 text-ink">Insurance</h3>
              {primary ? (
                <EligibilityChip
                  status={primary.lastEligibility?.status}
                  testId={tid(S, "eligibility")}
                />
              ) : null}
            </div>
            {primary ? (
              <div className="grid gap-1 text-body" data-testid={tid(S, "coverage")}>
                <span>{primary.plan?.name ?? primary.payer.name} · primary</span>
                <span className="text-small text-ink-2">
                  {primary.lastEligibility
                    ? `Checked ${formatDayTitle(primary.lastEligibility.requestedAt.slice(0, 10))}${primary.lastEligibility.copay ? ` · copay ${money(primary.lastEligibility.copay)}` : ""}`
                    : "Not checked yet"}
                </span>
                {can("checkEligibility") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-self-start"
                    loading={elig.isPending}
                    onClick={() => elig.mutate({ params: { coverageId: primary.id }, body: {} })}
                  >
                    Check eligibility now
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-body text-ink-2">
                No insurance on file. Add it at check-in or in the chart.
              </p>
            )}
          </section>
        ) : null}
        <section className="grid gap-2">
          <h3 className="text-h3 text-ink">Reminder preview · 72 h and 24 h before</h3>
          <p
            className="bg-surface-muted p-4 text-body text-ink"
            data-testid={tid(S, "reminder-preview")}
          >
            {practice}: reminder of your appointment on{" "}
            {slot
              ? `${formatDayTitle(zonedParts(slot.start).date)} at ${formatTime(slot.start)}`
              : "[date and time]"}
            . Reply C to confirm or use the portal link to change it.
          </p>
        </section>
      </SheetBody>
      <SheetFooter>
        <span className="mr-auto text-small text-ink" data-testid={tid(S, "book-summary")}>
          {slot ? (
            <>
              <span className="font-semibold">
                {formatDayTitle(zonedParts(slot.start).date)} · {formatTime(slot.start)}
              </span>{" "}
              · {chosenProvider ? `${chosenProvider.firstName} ${chosenProvider.lastName}` : ""} ·{" "}
              {vt?.durationMinutes} min
            </>
          ) : (
            "Choose a time"
          )}
        </span>
        <Button variant="ghost" onClick={onClose} data-testid={tid(S, "book-cancel")}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!patient || !slot || !can("bookAppointment")}
          loading={book.isPending || reschedule.isPending}
          data-testid={tid(S, "book-submit")}
          onClick={() =>
            rescheduleId && existing.data && slot
              ? reschedule.mutate({
                  params: { appointmentId: rescheduleId },
                  body: {
                    start: slot.start,
                    practitionerId: slot.practitionerId,
                    locationId: video ? (physicalLoc?.id ?? slot.locationId) : slot.locationId,
                    modality,
                    notify: true,
                    version: existing.data.appointment.version,
                  },
                })
              : patient &&
                slot &&
                book.mutate({
                  body: {
                    patientId: patient.id,
                    visitTypeId,
                    practitionerId: slot.practitionerId,
                    locationId: video ? (physicalLoc?.id ?? slot.locationId) : slot.locationId,
                    start: slot.start,
                    modality,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                    ...(params.get("waitlistEntryId")
                      ? { waitlistEntryId: params.get("waitlistEntryId")! }
                      : {}),
                    ...(params.get("recallId") ? { recallId: params.get("recallId")! } : {}),
                  },
                  idempotencyKey: `${patient.id}:${slot.start}`,
                })
          }
        >
          {rescheduleId ? "Move appointment" : "Book appointment"}
        </Button>
      </SheetFooter>
    </>
  );
}
