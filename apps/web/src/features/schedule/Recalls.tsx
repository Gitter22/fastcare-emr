import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { CommChannel, RecallView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDate, relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";
import { PatientLink } from "@/features/patients/PatientBits";
import { SubNav } from "@/shell/patterns";

const S = "schedule.recall-list";
type Outcome = "reached" | "left-message" | "no-answer" | "booked" | "declined";

/** schedule.recall-list (flow:quality/02): bring back patients due for follow-up or preventive care. */
export function RecallListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [reason, setReason] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [logging, setLogging] = React.useState<RecallView | null>(null);
  const list = useApi("listRecalls", { query: reason ? { category: reason } : {} });
  const campaign = useApiMutation("sendRecallCampaign", {
    invalidates: ["listRecalls"],
    onSuccess: () => (
      toast(`Booking link sent to ${selected.length} patient${selected.length > 1 ? "s" : ""}.`),
      setSelected([])
    ),
    onError: (e) => toast(errorMessage(e)),
  });
  const rows = list.data?.data ?? [];
  const reasons = [...new Set(rows.map((r) => r.reason))];

  const columns = React.useMemo<Col<RecallView>[]>(
    () => [
      {
        id: "select",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <Checkbox
            aria-label="Select"
            checked={selected.includes(row.original.id)}
            onCheckedChange={(c) =>
              setSelected((s) =>
                c ? [...s, row.original.id] : s.filter((x) => x !== row.original.id),
              )
            }
            data-testid={tid(S, "rc-select")}
          />
        ),
      },
      {
        id: "patient",
        header: "Patient",
        accessorFn: (r) => r.patient.name,
        cell: ({ row }) => (
          <span className="grid">
            <PatientLink patient={row.original.patient} testId={tid(S, "rc-patient")} />
            <span className="text-small tabular-nums text-ink-2">
              DOB {formatDate(row.original.patient.birthDate)}
            </span>
          </span>
        ),
      },
      { id: "reason", header: "Reason", accessorFn: (r) => r.reason },
      {
        id: "due",
        header: "Due",
        accessorFn: (r) => r.dueDate,
        cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.dueDate)}</span>,
      },
      {
        id: "last",
        header: "Last contact",
        accessorFn: (r) => r.lastContactAt ?? "",
        cell: ({ row }) =>
          row.original.lastContactAt
            ? `${relativeTime(row.original.lastContactAt)} · ${row.original.outreach[0] ? enumLabel(row.original.outreach[0].outcome.replace("-", "_")) : ""}`
            : "Not contacted",
      },
      {
        id: "attempts",
        header: "Attempts",
        accessorFn: (r) => r.attempts,
        meta: { numeric: true },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) => (
          <span className="inline-flex gap-1">
            {can("logRecallContact") ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLogging(row.original)}
                data-testid={tid(S, "rc-log-call")}
              >
                Log call
              </Button>
            ) : null}
            {can("bookAppointment") ? (
              <Button
                size="sm"
                onClick={() =>
                  navigate(
                    `${pathTo("schedule.booking-drawer")}?patientId=${row.original.patientId}&recallId=${row.original.id}`,
                  )
                }
                data-testid={tid(S, "rc-book")}
              >
                Book
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [can, navigate, selected],
  );

  return (
    <div className="grid content-start gap-6 p-8">
      <SubNav which="schedule" />
      <PageHeader
        title="Recalls"
        actions={
          <>
            <Select
              aria-label="Reason"
              testId={tid(S, "recall-reason-filter")}
              className="w-56"
              value={reason}
              onValueChange={(v) => setReason(v === "ALL" ? "" : v)}
              placeholder="All reasons"
              options={[
                { value: "ALL", label: "All reasons" },
                ...reasons.map((r) => ({ value: r, label: r })),
              ]}
            />
            {can("sendRecallCampaign") ? (
              <Button
                variant="primary"
                disabled={!selected.length}
                loading={campaign.isPending}
                onClick={() =>
                  campaign.mutate({
                    body: {
                      recallIds: selected,
                      channel: "SMS",
                      templateId: "00000000-0000-0000-0000-000000000000",
                    },
                  })
                }
                data-testid={tid(S, "recall-bulk-message")}
              >
                Send booking link to selected
              </Button>
            ) : null}
          </>
        }
      />
      <Card>
        <DataTable
          columns={columns}
          data={rows}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty="No recalls due"
          getRowId={(r) => r.id}
          testId={tid(S, "recall-table")}
        />
      </Card>
      <LogCallDialog recall={logging} onClose={() => setLogging(null)} />
    </div>
  );
}

function LogCallDialog({ recall, onClose }: { recall: RecallView | null; onClose: () => void }) {
  const [outcome, setOutcome] = React.useState<Outcome>("reached");
  const [note, setNote] = React.useState("");
  const log = useApiMutation("logRecallContact", {
    invalidates: ["listRecalls"],
    onSuccess: () => (toast("Call logged."), setNote(""), onClose()),
    onError: (e) => toast(errorMessage(e)),
  });
  return (
    <Dialog open={!!recall} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log call</DialogTitle>
        </DialogHeader>
        <p className="text-body text-ink">{recall?.patient.name}</p>
        <FieldShell label="Outcome">
          <Select<Outcome>
            value={outcome}
            onValueChange={setOutcome}
            options={[
              { value: "reached", label: "Reached" },
              { value: "left-message", label: "Left a message" },
              { value: "no-answer", label: "No answer" },
              { value: "booked", label: "Booked" },
              { value: "declined", label: "Declined" },
            ]}
          />
        </FieldShell>
        <FieldShell label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </FieldShell>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={log.isPending}
            onClick={() =>
              recall &&
              log.mutate({
                params: { recallId: recall.id },
                body: {
                  at: new Date().toISOString(),
                  channel: "VOICE" as CommChannel,
                  outcome,
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
