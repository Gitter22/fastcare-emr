import * as React from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { CodeHit, Condition } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDate, formatShortDate } from "@/lib/format";
import { useView } from "@/lib/useView";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { DateInput } from "@/components/ui/date";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, Page, PageHeader } from "@/components/ui/layout";
import { Select, Switch } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { Icd10Picker } from "@/components/domain/CodePickers";
import { IncomingCard, ReconcileItem } from "./Incoming";

const S = "chart.problems";
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  RECURRENCE: "Recurrence",
  RELAPSE: "Relapse",
  INACTIVE: "Inactive",
  REMISSION: "Remission",
  RESOLVED: "Resolved",
};
const INVALIDATES = ["listConditions", "getPatientSummary"] as const;

/** chart.problems: maintain active and resolved problems; outside/portal problems are reconciled first (INV-DATA-01). */
export function ProblemsPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const v = useView();
  const [showResolved, setShowResolved] = React.useState(false);
  const [resolving, setResolving] = React.useState<Condition | null>(null);
  const list = useApi("listConditions", {
    params: { patientId },
    query: { category: "PROBLEM_LIST_ITEM", includeResolved: showResolved },
  });
  const staged = useApi("listConditions", {
    params: { patientId },
    query: { stagingStatus: "STAGED", includeResolved: true },
  });
  const resolve = useApiMutation("updateCondition", {
    invalidates: [...INVALIDATES],
    onSuccess: (c) => (toast(`${c.display} marked resolved.`), setResolving(null)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const editing = v.view === "edit" ? (list.data?.find((c) => c.id === v.id) ?? null) : null;

  const columns = React.useMemo<Col<Condition>[]>(
    () => [
      {
        id: "name",
        header: "Problem",
        accessorFn: (c) => c.display,
        cell: ({ row }) => (
          <span className="grid">
            <b className="font-semibold">{row.original.display}</b>
            {row.original.note ? (
              <span className="text-small text-ink-2">{row.original.note}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "code",
        header: "ICD-10",
        accessorFn: (c) => c.icd10Code ?? "",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.icd10Code ?? "Uncoded"}</span>
        ),
      },
      {
        id: "onset",
        header: "Onset",
        accessorFn: (c) => c.onsetDate ?? "",
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.onsetDate)}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (c) => c.clinicalStatus,
        cell: ({ row }) =>
          row.original.clinicalStatus === "ACTIVE" ? (
            <span>Active</span>
          ) : (
            <Tag tone="outline">{STATUS_LABEL[row.original.clinicalStatus]}</Tag>
          ),
      },
      {
        id: "addressed",
        header: "Last addressed",
        accessorFn: (c) => c.lastAddressedAt ?? "",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.lastAddressedAt ? formatShortDate(row.original.lastAddressedAt) : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) =>
          can("updateCondition") ? (
            <span className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => v.open("edit", row.original.id)}
                data-testid={tid(S, "pr-edit")}
              >
                Edit
              </Button>
              {row.original.clinicalStatus !== "RESOLVED" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResolving(row.original)}
                  data-testid={tid(S, "pr-resolve")}
                >
                  Resolve
                </Button>
              ) : null}
            </span>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can],
  );

  return (
    <Page>
      <PageHeader
        title="Problems"
        actions={
          <>
            <Switch
              checked={showResolved}
              onCheckedChange={setShowResolved}
              label="Show resolved"
              data-testid={tid(S, "show-resolved")}
            />
            {can("createCondition") ? (
              <Button
                variant="primary"
                onClick={() => v.open("edit")}
                data-testid={tid(S, "add-problem")}
              >
                <Plus size={18} strokeWidth={1.75} />
                Add problem
              </Button>
            ) : null}
          </>
        }
      />
      {staged.data?.length ? (
        <IncomingCard
          testId={tid(S, "incoming")}
          title={`Incoming · ${staged.data.length} not in the chart yet`}
          action={
            <Button onClick={() => v.open("reconcile")} data-testid={tid(S, "open-reconcile")}>
              Review
            </Button>
          }
        />
      ) : null}
      <Card>
        <DataTable
          columns={columns}
          data={list.data ?? []}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={showResolved ? "No problems recorded" : "No active problems"}
          getRowId={(c) => c.id}
          testId={tid(S, "problem-table")}
        />
      </Card>
      <ProblemDrawer
        patientId={patientId}
        open={v.view === "edit"}
        problem={editing}
        onClose={v.close}
      />
      <Sheet open={v.view === "reconcile"} onOpenChange={(o) => !o && v.close()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Reconcile problems</SheetTitle>
          </SheetHeader>
          <SheetBody className="grid content-start gap-4">
            {(staged.data ?? []).map((c) => (
              <ReconcileItem
                key={c.id}
                testId={tid(S, "rec-item")}
                op="reconcileCondition"
                params={{ conditionId: c.id }}
                id={c.id}
                source={c.source}
                when={c.createdAt}
                title={c.display}
                detail={c.icd10Code ?? "Uncoded"}
                mergeTargets={(list.data ?? []).map((p) => ({ id: p.id, label: p.display }))}
                invalidates={[...INVALIDATES]}
              />
            ))}
            {!staged.data?.length ? (
              <p className="text-body text-ink-2">Nothing left to reconcile.</p>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={!!resolving}
        onOpenChange={(o) => !o && setResolving(null)}
        title={`Resolve ${resolving?.display ?? "problem"}?`}
        description="It moves to resolved problems with today's date. You can reopen it from Show resolved."
        action="Resolve"
        testId={tid(S, "resolve-confirm")}
        onConfirm={() =>
          resolving &&
          resolve.mutate({
            params: { conditionId: resolving.id },
            version: resolving.version,
            body: { clinicalStatus: "RESOLVED" },
          })
        }
      />
    </Page>
  );
}

function ProblemDrawer({
  patientId,
  open,
  problem,
  onClose,
}: {
  patientId: string;
  open: boolean;
  problem: Condition | null;
  onClose: () => void;
}) {
  const [code, setCode] = React.useState<CodeHit | null>(null);
  const [onset, setOnset] = React.useState<string | null>(null);
  const [statusValue, setStatus] = React.useState<string>("ACTIVE");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setCode(
      problem?.icd10Code
        ? { system: "ICD10CM", code: problem.icd10Code, display: problem.display }
        : null,
    );
    setOnset(problem?.onsetDate ?? null);
    setStatus(problem?.clinicalStatus ?? "ACTIVE");
    setNote(problem?.note ?? "");
    setError(null);
    setTouched(false);
  }, [open, problem]);
  const done = (c: Condition) => (toast(`${c.display} saved.`), onClose());
  const create = useApiMutation("createCondition", {
    invalidates: [...INVALIDATES],
    onSuccess: done,
    onError: (e) => setError(errorMessage(e)),
  });
  const update = useApiMutation("updateCondition", {
    invalidates: [...INVALIDATES],
    onSuccess: done,
    onError: (e) => setError(errorMessage(e)),
  });
  const save = () => {
    setTouched(true);
    if (!code) return;
    const fields = {
      icd10Code: code.code,
      display: code.display,
      onsetDate: onset,
      clinicalStatus: statusValue as Condition["clinicalStatus"],
      note: note.trim() || null,
    };
    if (problem)
      update.mutate({
        params: { conditionId: problem.id },
        version: problem.version,
        body: fields,
      });
    else
      create.mutate({
        params: { patientId },
        body: { patientId, category: "PROBLEM_LIST_ITEM", ...fields },
      });
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{problem ? "Edit problem" : "Add problem"}</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          <FieldShell
            label="Problem"
            required
            error={touched && !code ? "Choose a problem." : undefined}
            hint="Plain language or ICD-10-CM code."
          >
            <Icd10Picker
              value={code}
              onChange={setCode}
              testId={tid(S, "pr-search")}
              invalid={touched && !code}
              autoFocus
            />
          </FieldShell>
          <FieldShell label="Onset">
            <DateInput
              value={onset}
              onChange={setOnset}
              testId={tid(S, "pr-onset")}
              aria-label="Onset"
            />
          </FieldShell>
          <FieldShell label="Status">
            <Select
              value={statusValue}
              onValueChange={setStatus}
              testId={tid(S, "pr-status")}
              aria-label="Status"
              options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </FieldShell>
          <FieldShell label="Comment" htmlFor="pr-note">
            <Textarea
              id="pr-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid={tid(S, "pr-note")}
            />
          </FieldShell>
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={create.isPending || update.isPending}
            data-testid={tid(S, "pr-save")}
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
