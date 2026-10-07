import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import type { PatientSummary, WaitlistView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import {
  formatDate,
  formatDayTitle,
  formatTime,
  relativeTime,
  todayIso,
  zonedParts,
} from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { DateInput } from "@/components/ui/date";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Card, PageHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { PatientLink } from "@/features/patients/PatientBits";
import { PatientPicker } from "@/features/patients/PatientPicker";
import { SubNav } from "@/shell/patterns";

const S = "schedule.waitlist";

/** schedule.waitlist: fill cancelled slots; offers go out by text with an accept link (no clinical detail). */
export function WaitlistPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const list = useApi("listWaitlist", { query: {} });
  const remove = useApiMutation("removeWaitlistEntry", {
    invalidates: ["listWaitlist"],
    onSuccess: () => toast("Removed from the waitlist."),
    onError: (e) => toast(errorMessage(e)),
  });
  const [offering, setOffering] = React.useState<WaitlistView | null>(null);

  const columns = React.useMemo<Col<WaitlistView>[]>(
    () => [
      {
        id: "patient",
        header: "Patient",
        accessorFn: (w) => w.patient.name,
        cell: ({ row }) => (
          <span className="grid">
            <PatientLink patient={row.original.patient} testId={tid(S, "wl-patient")} />
            <span className="text-small tabular-nums text-ink-2">
              DOB {formatDate(row.original.patient.birthDate)}
            </span>
          </span>
        ),
      },
      {
        id: "type",
        header: "Visit type",
        accessorFn: (w) => w.visitType?.name ?? "",
        cell: ({ row }) => row.original.visitType?.name ?? "—",
      },
      {
        id: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => row.original.practitionerName ?? "Any",
      },
      {
        id: "window",
        header: "Available",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.earliest || row.original.latest
            ? `${row.original.earliest ? formatDate(row.original.earliest.slice(0, 10)) : "now"} – ${row.original.latest ? formatDate(row.original.latest.slice(0, 10)) : "any time"}`
            : "Any time",
      },
      {
        id: "added",
        header: "Added",
        accessorFn: (w) => w.createdAt,
        cell: ({ row }) => relativeTime(row.original.createdAt),
      },
      {
        id: "status",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === "OFFERED" ? (
            <Tag tone="active" data-testid={tid(S, "wl-match")}>
              Offered{" "}
              {row.original.offeredSlotStart ? formatTime(row.original.offeredSlotStart) : ""}
            </Tag>
          ) : null,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) => (
          <span className="inline-flex gap-1">
            {can("offerWaitlistSlot") ? (
              <Button
                size="sm"
                onClick={() => setOffering(row.original)}
                data-testid={tid(S, "wl-offer")}
              >
                Offer slot
              </Button>
            ) : null}
            {can("bookAppointment") ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  navigate(
                    `${pathTo("schedule.booking-drawer")}?patientId=${row.original.patientId}&waitlistEntryId=${row.original.id}`,
                  )
                }
                data-testid={tid(S, "wl-book")}
              >
                Book
              </Button>
            ) : null}
            {can("removeWaitlistEntry") ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove"
                onClick={() => remove.mutate({ params: { waitlistEntryId: row.original.id } })}
                data-testid={tid(S, "wl-remove")}
              >
                <X size={16} strokeWidth={1.75} />
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [can, navigate, remove],
  );

  return (
    <div className="grid content-start gap-6 p-8">
      <SubNav which="schedule" />
      <PageHeader
        title="Waitlist"
        actions={
          can("createWaitlistEntry") ? (
            <Button
              variant="primary"
              onClick={() => setParams({ view: "add" })}
              data-testid={tid(S, "wl-add")}
            >
              <Plus size={18} strokeWidth={1.75} />
              Add to waitlist
            </Button>
          ) : null
        }
      />
      <Card>
        <DataTable
          columns={columns}
          data={list.data?.data}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty="Nobody is waiting"
          getRowId={(w) => w.id}
          testId={tid(S, "waitlist-table")}
        />
      </Card>
      <AddDrawer open={params.get("view") === "add"} onClose={() => setParams({})} />
      <OfferDialog entry={offering} onClose={() => setOffering(null)} />
    </div>
  );
}

function AddDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const visitTypes = useApi("listVisitTypes", undefined, { enabled: open });
  const practitioners = useApi("listPractitioners", { query: {} }, { enabled: open });
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const [visitTypeId, setVisitTypeId] = React.useState("");
  const [practitionerId, setPractitionerId] = React.useState("");
  const [earliest, setEarliest] = React.useState<string | null>(todayIso());
  const [latest, setLatest] = React.useState<string | null>(null);
  const add = useApiMutation("createWaitlistEntry", {
    invalidates: ["listWaitlist"],
    onSuccess: () => (toast("Added to the waitlist."), onClose()),
    onError: (e) => toast(errorMessage(e)),
  });
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid={`${S}#add`}>
        <SheetHeader>
          <SheetTitle>Add to waitlist</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          <FieldShell label="Patient">
            <PatientPicker
              value={patient}
              onChange={setPatient}
              placeholder="Name, DOB, phone or MRN"
              testId={tid(S, "wl-form-patient")}
            />
          </FieldShell>
          <FieldShell label="Visit type">
            <Select
              testId={tid(S, "wl-form-type")}
              value={visitTypeId}
              onValueChange={setVisitTypeId}
              options={(visitTypes.data ?? [])
                .filter((v) => v.active)
                .map((v) => ({ value: v.id, label: v.name }))}
            />
          </FieldShell>
          <FieldShell label="Provider preference">
            <Select
              testId={tid(S, "wl-form-provider")}
              value={practitionerId || "ANY"}
              onValueChange={(v) => setPractitionerId(v === "ANY" ? "" : v)}
              options={[
                { value: "ANY", label: "Any provider" },
                ...(practitioners.data ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.firstName} ${p.lastName}`,
                })),
              ]}
            />
          </FieldShell>
          <div className="grid grid-cols-2 gap-3" data-testid={tid(S, "wl-form-window")}>
            <FieldShell label="Available from">
              <DateInput value={earliest} onChange={setEarliest} />
            </FieldShell>
            <FieldShell label="Until">
              <DateInput value={latest} onChange={setLatest} />
            </FieldShell>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose} data-testid={tid(S, "wl-form-cancel")}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!patient || !visitTypeId}
            loading={add.isPending}
            onClick={() =>
              patient &&
              add.mutate({
                body: {
                  patientId: patient.id,
                  visitTypeId,
                  ...(practitionerId ? { practitionerId } : {}),
                  ...(earliest ? { earliest: `${earliest}T00:00:00Z` } : {}),
                  ...(latest ? { latest: `${latest}T23:59:00Z` } : {}),
                },
              })
            }
            data-testid={tid(S, "wl-form-save")}
          >
            Add
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Offer an open slot: the server sends a text with an accept link and holds the offer until it expires. */
function OfferDialog({ entry, onClose }: { entry: WaitlistView | null; onClose: () => void }) {
  const slots = useApi(
    "searchAvailability",
    {
      query: {
        visitTypeId: entry?.visitTypeId ?? "",
        ...(entry?.practitionerId ? { practitionerId: entry.practitionerId } : {}),
      },
    },
    { enabled: !!entry },
  );
  const [pick, setPick] = React.useState("");
  const offer = useApiMutation("offerWaitlistSlot", {
    invalidates: ["listWaitlist"],
    onSuccess: () => (toast("Offer sent. It expires in 2 hours."), onClose()),
    onError: (e) => toast(errorMessage(e)),
  });
  const options = (slots.data?.slots ?? []).slice(0, 30);
  const chosen = options.find((s) => `${s.start}|${s.practitionerId}` === pick);
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offer a slot</DialogTitle>
        </DialogHeader>
        <p className="text-body text-ink">
          {entry?.patient.name} gets a text with a link to accept. The message has no clinical
          detail.
        </p>
        <FieldShell label="Open slot">
          <Select
            value={pick}
            onValueChange={setPick}
            placeholder={
              slots.isLoading ? "Loading…" : options.length ? "Choose a time" : "No open slots"
            }
            options={options.map((s) => ({
              value: `${s.start}|${s.practitionerId}`,
              label: `${formatDayTitle(zonedParts(s.start).date)} ${formatTime(s.start)} · ${s.practitionerName}`,
            }))}
          />
        </FieldShell>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen || !entry}
            loading={offer.isPending}
            onClick={() =>
              entry &&
              chosen &&
              offer.mutate({
                params: { waitlistEntryId: entry.id },
                body: {
                  start: chosen.start,
                  practitionerId: chosen.practitionerId,
                  locationId: chosen.locationId,
                  visitTypeId: entry.visitTypeId,
                  channel: "SMS",
                  expiresInMinutes: 120,
                },
              })
            }
          >
            Send offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
