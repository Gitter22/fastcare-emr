import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type {
  AuditAction,
  AuditEventEntry,
  BreakGlassOutcome,
  EmergencyAccessGrant,
  PatientSummary,
} from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDateTime, formatShortDate, formatTime, relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, Field, LoadingRows, PageHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { SettingsLayout } from "@/shell/patterns";
import { PatientPicker } from "@/features/patients/PatientPicker";

const S = "admin.audit-log";
const ACTION_TEXT: Record<string, string> = {
  READ: "Viewed",
  CREATE: "Created",
  UPDATE: "Changed",
  DELETE: "Deleted",
  SIGN: "Signed",
  PRINT: "Printed",
  EXPORT: "Exported",
  LOGIN: "Signed in",
  LOGOUT: "Signed out",
  LOGIN_FAILED: "Sign-in failed",
  MFA: "Two-step check",
  BREAK_GLASS: "Emergency access",
  DISCLOSE: "Disclosed",
  QUERY: "Searched",
  MERGE: "Merged",
  PERMISSION_CHANGE: "Access changed",
};
const WHEN = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

/** admin.audit-log: who saw what, when (INV-SEC-01), plus break-the-glass review (INV-SEC-03). */
export function AuditLogPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const [userId, setUserId] = React.useState("");
  const [action, setAction] = React.useState<AuditAction | "">(
    params.get("view") === "break-glass" ? "BREAK_GLASS" : "",
  );
  const [days, setDays] = React.useState("7");
  const from = React.useMemo(
    () => new Date(Date.now() - Number(days) * 86_400_000).toISOString(),
    [days],
  );
  const query = {
    from,
    ...(patient ? { patientId: patient.id } : {}),
    ...(userId ? { userId } : {}),
    ...(action ? { action } : {}),
    limit: 200,
  };
  const events = useApi("listAuditEvents", { query });
  const pending = useApi("listEmergencyAccessGrants", {
    query: { reviewOutcome: "PENDING_REVIEW" },
  });
  const users = useApi("listUsers", { query: {} });
  const selected = params.get("event");
  const pendingGrants = pending.data?.data ?? [];

  const exportCsv = useApiMutation("exportAuditEvents", {
    onSuccess: async (job) => {
      const fileId = job.resultFileIds[0];
      if (!fileId) return;
      const blob = (await api("downloadFile", { params: { fileId } })) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Audit export downloaded. The export itself was logged.");
    },
    onError: (e) => toast(errorMessage(e)),
  });

  const columns = React.useMemo<Col<AuditEventEntry>[]>(
    () => [
      {
        id: "time",
        header: "Time",
        accessorFn: (e) => e.at,
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatShortDate(row.original.at)} · {formatTime(row.original.at)}
          </span>
        ),
      },
      {
        id: "user",
        header: "User",
        accessorFn: (e) => e.actor.name ?? "",
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {row.original.actor.name ?? (row.original.actor.userId ? "Staff user" : "System")}
          </span>
        ),
      },
      {
        id: "patient",
        header: "Patient",
        accessorFn: (e) => e.patientName ?? "",
        cell: ({ row }) =>
          row.original.patientName ? (
            <span className="grid">
              <span>{row.original.patientName}</span>
              <span className="text-small tabular-nums text-ink-2">
                MRN {row.original.patientMrn}
              </span>
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "action",
        header: "Action",
        accessorFn: (e) => e.action,
        cell: ({ row }) => {
          const e = row.original;
          if (e.action === "BREAK_GLASS" || e.emergencyAccessGrantId)
            return <Tag tone="caution">Emergency access</Tag>;
          if (e.outcome !== "SUCCESS")
            return (
              <Tag tone="caution">
                {ACTION_TEXT[e.action] ?? e.action} · {enumLabel(e.outcome)}
              </Tag>
            );
          return ACTION_TEXT[e.action] ?? enumLabel(e.action);
        },
      },
      {
        id: "what",
        header: "What",
        enableSorting: false,
        cell: ({ row }) => <span className="text-ink-2">{describe(row.original)}</span>,
      },
      {
        id: "from",
        header: "From",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-small tabular-nums text-ink-2">
            {row.original.ipAddress ?? "—"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <SettingsLayout>
      <PageHeader
        title="Audit log"
        actions={
          can("exportAuditEvents") ? (
            <Button
              loading={exportCsv.isPending}
              data-testid={tid(S, "au-export")}
              onClick={() =>
                exportCsv.mutate({
                  body: {
                    from,
                    to: new Date().toISOString(),
                    ...(patient ? { patientId: patient.id } : {}),
                    ...(userId ? { userId } : {}),
                    ...(action ? { actions: [action] } : {}),
                    format: "csv",
                    reason: "Audit review from the audit log screen",
                  },
                })
              }
            >
              Export results (CSV)
            </Button>
          ) : null
        }
      />
      {pendingGrants.length ? (
        <Alert
          tone="caution"
          testId={tid(S, "au-btg-banner")}
          title={`${pendingGrants.length} emergency access ${pendingGrants.length === 1 ? "event" : "events"} waiting for review`}
          action={
            <Button size="sm" onClick={() => setParams({ grant: pendingGrants[0]!.id })}>
              Review
            </Button>
          }
        >
          · oldest {relativeTime(pendingGrants[pendingGrants.length - 1]!.grantedAt)}
        </Alert>
      ) : null}
      <div
        className={
          selected || params.get("grant")
            ? "grid grid-cols-[minmax(0,1fr)_400px] items-start gap-6"
            : "grid"
        }
      >
        <Card className="grid gap-4">
          <div className="grid grid-cols-4 gap-3">
            <FieldShell label="Patient">
              <PatientPicker value={patient} onChange={setPatient} testId={tid(S, "au-patient")} />
            </FieldShell>
            <FieldShell label="User">
              <Select
                testId={tid(S, "au-user")}
                aria-label="User"
                value={userId}
                onValueChange={(v) => setUserId(v === "ALL" ? "" : v)}
                placeholder="Any user"
                options={[
                  { value: "ALL", label: "Any user" },
                  ...(users.data?.data ?? []).map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
            </FieldShell>
            <FieldShell label="Action">
              <Select
                testId={tid(S, "au-action")}
                aria-label="Action"
                value={action}
                onValueChange={(v) => setAction(v === "ALL" ? "" : (v as AuditAction))}
                placeholder="All actions"
                options={[
                  { value: "ALL", label: "All actions" },
                  ...Object.entries(ACTION_TEXT).map(([value, label]) => ({ value, label })),
                ]}
              />
            </FieldShell>
            <FieldShell label="When">
              <Select
                testId={tid(S, "au-when")}
                aria-label="When"
                value={days}
                onValueChange={setDays}
                options={WHEN}
              />
            </FieldShell>
          </div>
          <DataTable
            columns={columns}
            data={events.data?.data}
            loading={events.isLoading}
            error={events.error}
            onRetry={() => void events.refetch()}
            empty="No activity matches"
            getRowId={(e) => e.id}
            selectedId={selected}
            onRowClick={(e) =>
              setParams(
                e.emergencyAccessGrantId
                  ? { event: e.id, grant: e.emergencyAccessGrantId }
                  : { event: e.id },
              )
            }
            testId={tid(S, "au-table")}
            compact
          />
          {events.data?.hasMore ? (
            <p className="text-small text-ink-2">
              Showing the latest 200. Narrow the search or export for the full list.
            </p>
          ) : null}
        </Card>
        {params.get("grant") ? (
          <GrantReview
            grantId={params.get("grant")!}
            users={users.data?.data ?? []}
            onDone={() => setParams({})}
            onUserDay={(uid) => (setUserId(uid), setDays("1"), setParams({}))}
          />
        ) : selected ? (
          <EventDetail
            event={events.data?.data.find((e) => e.id === selected)}
            onUserDay={(uid) => (setUserId(uid), setDays("1"), setParams({}))}
          />
        ) : null}
      </div>
    </SettingsLayout>
  );
}

function describe(e: AuditEventEntry): string {
  const what = e.entityType ? e.entityType.replace(/([a-z])([A-Z])/g, "$1 $2") : "";
  const op = e.operation ? e.operation.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "";
  return [what, op].filter(Boolean).join(" · ") || "—";
}

function EventDetail({
  event,
  onUserDay,
}: {
  event: AuditEventEntry | undefined;
  onUserDay: (userId: string) => void;
}) {
  if (!event) return null;
  return (
    <Card className="grid content-start gap-4" data-testid={tid(S, "ev-detail")}>
      <h3 className="text-h3 text-ink">{ACTION_TEXT[event.action] ?? event.action}</h3>
      <dl className="grid gap-3">
        <Field label="When">{formatDateTime(event.at)}</Field>
        <Field label="User">
          {event.actor.name ?? "System"}
          {event.actor.role ? ` · ${enumLabel(event.actor.role)}` : ""}
        </Field>
        <Field label="Patient">
          {event.patientName ? `${event.patientName} · MRN ${event.patientMrn}` : "—"}
        </Field>
        <Field label="Record">{describe(event)}</Field>
        <Field label="Outcome">{enumLabel(event.outcome)}</Field>
        <Field label="From">{event.ipAddress ?? "—"}</Field>
        {event.reason ? <Field label="Purpose">{event.reason}</Field> : null}
      </dl>
      {event.actor.userId ? (
        <Button
          variant="ghost"
          className="justify-self-start"
          onClick={() => onUserDay(event.actor.userId!)}
          data-testid={tid(S, "ev-user-day")}
        >
          See everything this user did that day
        </Button>
      ) : null}
    </Card>
  );
}

function GrantReview({
  grantId,
  users,
  onDone,
  onUserDay,
}: {
  grantId: string;
  users: Array<{ id: string; name: string; roles: string[] }>;
  onDone: () => void;
  onUserDay: (userId: string) => void;
}) {
  const all = useApi("listEmergencyAccessGrants", { query: { limit: 200 } });
  const grant: EmergencyAccessGrant | undefined = all.data?.data.find((g) => g.id === grantId);
  const banner = useApi(
    "getPatientBanner",
    { params: { patientId: grant?.patientId ?? "" } },
    { enabled: !!grant },
  );
  const { me } = useAuth();
  const [outcome, setOutcome] = React.useState<BreakGlassOutcome | "">("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const review = useApiMutation("reviewEmergencyAccess", {
    invalidates: ["listEmergencyAccessGrants", "listAuditEvents"],
    onSuccess: () => (toast("Review saved."), onDone()),
    onError: (e) => setError(errorMessage(e)),
  });
  if (all.isLoading)
    return (
      <Card>
        <LoadingRows />
      </Card>
    );
  if (!grant) return null;
  const user = users.find((u) => u.id === grant.userId);
  const ended = new Date(grant.expiresAt) < new Date();
  const own = grant.userId === me?.user.id;
  return (
    <Card className="grid content-start gap-4" data-testid={tid(S, "ev-detail")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-h3 text-ink">Emergency access</h3>
        <Tag tone={grant.reviewOutcome === "PENDING_REVIEW" ? "caution" : "neutral"}>
          {grant.reviewOutcome === "PENDING_REVIEW"
            ? "Needs review"
            : enumLabel(grant.reviewOutcome)}
        </Tag>
      </div>
      {error ? <Alert tone="caution">{error}</Alert> : null}
      <dl className="grid gap-3">
        <Field label="User">{user ? user.name : "Staff user"}</Field>
        <Field label="Patient">
          {banner.data ? `${banner.data.name} · MRN ${banner.data.mrn}` : "…"}
        </Field>
        <Field label="Opened">
          {formatDateTime(grant.grantedAt)} · {ended ? "access ended" : "access ends"}{" "}
          {formatTime(grant.expiresAt)}
        </Field>
        <Field label="Records unlocked">{grant.scope.join(", ")}</Field>
        <Field label="Reason given">
          <span className="block bg-surface-muted p-3">"{grant.reasonText}"</span>
        </Field>
      </dl>
      {grant.reviewOutcome === "PENDING_REVIEW" ? (
        own ? (
          <Alert>Someone else must review your own emergency access.</Alert>
        ) : (
          <>
            <FieldShell label="Review outcome">
              <Select
                testId={tid(S, "ev-outcome")}
                value={outcome}
                onValueChange={setOutcome}
                placeholder="Choose…"
                options={[
                  { value: "APPROPRIATE", label: "Appropriate" },
                  { value: "FOLLOW_UP", label: "Follow up with the user" },
                  { value: "POSSIBLE_INCIDENT", label: "Possible privacy incident" },
                ]}
              />
            </FieldShell>
            <FieldShell label="Note" required>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid={tid(S, "ev-note")}
              />
            </FieldShell>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => onUserDay(grant.userId)}
                data-testid={tid(S, "ev-user-day")}
              >
                See everything this user did that day
              </Button>
              <Button
                variant="primary"
                disabled={!outcome || !note.trim()}
                loading={review.isPending}
                onClick={() =>
                  review.mutate({
                    params: { emergencyAccessGrantId: grant.id },
                    body: { outcome: outcome as BreakGlassOutcome, note: note.trim() },
                  })
                }
                data-testid={tid(S, "ev-save")}
              >
                Save review
              </Button>
            </div>
          </>
        )
      ) : (
        <Field label="Review note">{grant.reviewNote}</Field>
      )}
    </Card>
  );
}
