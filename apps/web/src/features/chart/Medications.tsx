import * as React from "react";
import { useParams } from "react-router-dom";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import type { MedicationStatementView } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate } from "@/lib/format";
import { useView } from "@/lib/useView";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { DateInput } from "@/components/ui/date";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, LoadingRows, Page, PageHeader } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Unavailable } from "@/components/ui/unavailable";
import { Checkbox, Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { DrugPicker, type DrugChoice } from "@/components/domain/CodePickers";
import { IncomingCard, ReconcileItem, SOURCE_LABEL } from "./Incoming";
import { printList } from "./printList";
import { Pressable } from "@/components/ui/pressable";

const S = "chart.medications";
const INVALIDATES = ["listMedicationStatements", "getPatientSummary", "getRooming"] as const;
type Tab = "active" | "inactive" | "fills";
const ACTIVE = ["ACTIVE", "INTENDED", "ON_HOLD"];
const DC_REASONS = [
  "Course completed",
  "Side effect",
  "Not effective",
  "Patient preference",
  "Duplicate therapy",
  "Changed by outside provider",
  "Other",
];

/** chart.medications (flow:checkin/04): one trusted medication list, with incoming items reconciled first. */
export function MedicationsPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const v = useView();
  const [tab, setTab] = React.useState<Tab>("active");
  const [filter, setFilter] = React.useState("");
  const [stopping, setStopping] = React.useState<MedicationStatementView | null>(null);
  const all = useApi("listMedicationStatements", { params: { patientId }, query: {} });
  const staged = useApi("listMedicationStatements", {
    params: { patientId },
    query: { stagingStatus: "STAGED" },
  });
  const problems = useApi("listConditions", {
    params: { patientId },
    query: { category: "PROBLEM_LIST_ITEM" },
  });
  const patient = useApi("getPatient", { params: { patientId } });
  const banner = useApi("getPatientBanner", { params: { patientId } });
  const erx = me.connectedGateways.includes("ErxGateway");
  const notTaking = useApiMutation("updateMedicationStatement", {
    invalidates: [...INVALIDATES],
    onSuccess: (m) => toast(`${m.display} marked not taking.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reviewed = useApiMutation("recordMedicationReconciliation", {
    invalidates: ["getPatient", ...INVALIDATES],
    onSuccess: () => toast("Medication list marked reconciled."),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const active = (all.data ?? []).filter((m) => ACTIVE.includes(m.status));
  const inactive = (all.data ?? []).filter((m) => !ACTIVE.includes(m.status));
  const rows = (tab === "active" ? active : inactive).filter(
    (m) => !filter || m.display.toLowerCase().includes(filter.toLowerCase()),
  );
  const problemName = (id?: string | null) => problems.data?.find((p) => p.id === id)?.display;
  const editing =
    v.view === "edit" && v.id
      ? (all.data?.find((m) => m.id === v.id) ?? staged.data?.find((m) => m.id === v.id) ?? null)
      : null;

  const columns = React.useMemo<Col<MedicationStatementView>[]>(
    () => [
      {
        id: "drug",
        header: "Medication",
        accessorFn: (m) => m.display,
        cell: ({ row }) => (
          <span className="grid">
            <b className="font-semibold">{row.original.display}</b>
            {problemName(row.original.reasonConditionId) ? (
              <span className="text-small text-ink-2">
                for {problemName(row.original.reasonConditionId)}
              </span>
            ) : null}
            {!row.original.rxnormCode ? (
              <span className="text-small text-ink-2">Uncoded</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "sig",
        header: "How taken",
        accessorFn: (m) => m.dosageText ?? "",
        cell: ({ row }) => row.original.dosageText ?? "—",
      },
      {
        id: "source",
        header: "Source",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="grid justify-items-start gap-0.5" data-testid={tid(S, "med-source")}>
            <Tag tone={row.original.prescriptionId ? "neutral" : "outline"}>
              {row.original.prescriptionId ? "Prescribed here" : SOURCE_LABEL[row.original.source]}
            </Tag>
            {row.original.source !== "ENTERED" && !row.original.prescriptionId ? (
              <span className="text-small text-ink-2">
                accepted {formatShortDate(row.original.updatedAt)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "fill",
        header: "Last fill",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.lastFillDate ? formatShortDate(row.original.lastFillDate) : "—"}
          </span>
        ),
      },
      ...(tab === "inactive"
        ? [
            {
              id: "why",
              header: "Stopped",
              enableSorting: false,
              cell: ({ row }: { row: { original: MedicationStatementView } }) => (
                <span className="grid">
                  <span>
                    {row.original.statusReason ??
                      row.original.status.toLowerCase().replace(/_/g, " ")}
                  </span>
                  <span className="text-small tabular-nums text-ink-2">
                    {formatShortDate(row.original.effectiveEnd)}
                  </span>
                </span>
              ),
            } as Col<MedicationStatementView>,
          ]
        : []),
      {
        id: "menu",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) =>
          tab === "active" && can("updateMedicationStatement") ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${row.original.display}`}
                  data-testid={tid(S, "med-menu")}
                >
                  <MoreHorizontal size={18} strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => v.open("edit", row.original.id)}>
                  Change dose or directions
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    notTaking.mutate({
                      params: { medicationStatementId: row.original.id },
                      version: row.original.version,
                      body: { status: "NOT_TAKEN", statusReason: "Patient not taking" },
                    })
                  }
                >
                  Mark not taking
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setStopping(row.original)}>
                  Discontinue…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, can, problems.data],
  );

  const reconciledAt = patient.data?.medsReconciledAt;
  return (
    <Page>
      <PageHeader
        title="Medications"
        actions={
          <>
            <Button
              onClick={() =>
                banner.data &&
                printList(
                  banner.data,
                  "Medication list",
                  active.map((m) => [m.display, m.dosageText ?? ""]),
                )
              }
              data-testid={tid(S, "print-list")}
              disabled={!active.length}
            >
              Print list
            </Button>
            {can("createMedicationStatement") ? (
              <Button
                variant="primary"
                onClick={() => v.open("edit")}
                data-testid={tid(S, "add-patient-reported")}
              >
                <Plus size={18} strokeWidth={1.75} />
                Patient-reported medication
              </Button>
            ) : null}
          </>
        }
      />
      <p className="-mt-3 text-body text-ink-2" data-testid={tid(S, "last-reconciled")}>
        {reconciledAt ? `Last reconciled ${formatShortDate(reconciledAt)}` : "Not reconciled yet"}
        {erx ? " · fill history from pharmacy network" : ""}
      </p>
      {staged.data?.length ? (
        <IncomingCard
          title="Incoming · not in the chart yet"
          testId={tid(S, "incoming")}
          action={
            <Unavailable reason="Accept, merge or reject each incoming item first.">
              <Button data-testid={tid(S, "mark-all-reviewed")} disabled>
                Mark all reviewed
              </Button>
            </Unavailable>
          }
        >
          {staged.data.map((m) => {
            const dup = active.find((a) => a.id === m.possibleDuplicateOf);
            return (
              <ReconcileItem
                key={m.id}
                testId={tid(S, "incoming-item")}
                op="reconcileMedicationStatement"
                params={{ medicationStatementId: m.id }}
                id={m.id}
                source={m.source}
                when={m.createdAt}
                title={m.display}
                detail={m.dosageText ? `“${m.dosageText}”` : undefined}
                compare={
                  dup ? (
                    <span data-testid={tid(S, "inc-compare")}>
                      <Tag tone="outline" className="mb-1 outline-dashed">
                        Possible duplicate
                      </Tag>
                      <br />
                      Same drug as <b>{dup.display}</b> already on the list.
                    </span>
                  ) : (
                    <span data-testid={tid(S, "inc-compare")}>Not on our list.</span>
                  )
                }
                mergeTargets={active.map((a) => ({ id: a.id, label: a.display }))}
                duplicateOf={dup?.id}
                invalidates={[...INVALIDATES]}
                extraActions={
                  dup ? null : (
                    <Button
                      size="sm"
                      onClick={() => v.open("edit", m.id)}
                      data-testid={tid(S, "inc-edit-accept")}
                    >
                      Edit & accept
                    </Button>
                  )
                }
              />
            );
          })}
        </IncomingCard>
      ) : staged.isLoading ? (
        <LoadingRows rows={2} />
      ) : staged.error ? (
        <Alert tone="caution">
          Incoming medications couldn't be loaded. {errorMessage(staged.error)}
        </Alert>
      ) : (
        <div className="flex items-center justify-between gap-4 bg-surface px-6 py-4">
          <span className="text-body text-ink-2">
            No incoming medications. Confirm the list with the patient, then mark it reconciled.
          </span>
          {can("recordMedicationReconciliation") ? (
            <Button
              onClick={() => reviewed.mutate({ params: { patientId } })}
              disabled={reviewed.isPending}
              data-testid={tid(S, "mark-all-reviewed")}
            >
              Mark reconciled
            </Button>
          ) : null}
        </div>
      )}
      <Card>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div
            role="tablist"
            aria-label="Medication lists"
            className="flex gap-1"
            data-testid={tid(S, "med-tabs")}
          >
            <TabButton active={tab === "active"} onClick={() => setTab("active")}>
              Active ({active.length})
            </TabButton>
            <TabButton active={tab === "inactive"} onClick={() => setTab("inactive")}>
              Inactive ({inactive.length})
            </TabButton>
            {erx ? (
              <TabButton active={tab === "fills"} onClick={() => setTab("fills")}>
                Fill history
              </TabButton>
            ) : (
              <Unavailable reason="Fill history arrives through e-prescribing, which isn't connected yet.">
                <TabButton disabled>Fill history</TabButton>
              </Unavailable>
            )}
          </div>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter medications"
            aria-label="Filter medications"
            className="w-72"
            data-testid={tid(S, "med-filter")}
          />
        </div>
        <DataTable
          columns={columns}
          data={rows}
          loading={all.isLoading}
          error={all.error}
          onRetry={() => void all.refetch()}
          empty={tab === "active" ? "No active medications" : "No inactive medications"}
          getRowId={(m) => m.id}
          testId={tid(S, "med-table")}
        />
      </Card>
      <MedicationDrawer
        patientId={patientId}
        open={v.view === "edit"}
        med={editing}
        problems={(problems.data ?? []).map((p) => ({ value: p.id, label: p.display }))}
        onClose={v.close}
      />
      <DiscontinueDialog med={stopping} erx={erx} onClose={() => setStopping(null)} />
    </Page>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      type="button"
      role="tab"
      aria-selected={!!active}
      disabled={disabled}
      onClick={onClick}
      className={
        "h-control-md px-4 text-body transition-colors duration-fast " +
        (active
          ? "font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]"
          : "text-ink-2 hover:bg-surface-hover disabled:text-ink-3 disabled:hover:bg-transparent")
      }
    >
      {children}
    </Pressable>
  );
}

function MedicationDrawer({
  patientId,
  open,
  med,
  problems,
  onClose,
}: {
  patientId: string;
  open: boolean;
  med: MedicationStatementView | null;
  problems: Array<{ value: string; label: string }>;
  onClose: () => void;
}) {
  const staged = med?.stagingStatus === "STAGED";
  const [drug, setDrug] = React.useState<DrugChoice | null>(null);
  const [sig, setSig] = React.useState("");
  const [start, setStart] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<"PATIENT_REPORTED" | "OUTSIDE_RECORD" | "ENTERED">(
    "PATIENT_REPORTED",
  );
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setDrug(med ? { rxcui: med.rxnormCode ?? null, name: med.display } : null);
    setSig(med?.dosageText ?? "");
    setStart(med?.effectiveStart ?? null);
    setReason(med?.reasonConditionId ?? "");
    setError(null);
    setTouched(false);
  }, [open, med]);
  const reconcile = useApiMutation("reconcileMedicationStatement", {
    invalidates: [...INVALIDATES],
  });
  const finish = (name: string) => (toast(`${name} saved.`), onClose());
  const create = useApiMutation("createMedicationStatement", {
    invalidates: [...INVALIDATES],
    onSuccess: (m) => finish(m.display),
    onError: (e) => setError(errorMessage(e)),
  });
  const update = useApiMutation("updateMedicationStatement", {
    invalidates: [...INVALIDATES],
    onSuccess: (m) =>
      staged
        ? reconcile.mutate(
            {
              params: { medicationStatementId: m.id },
              body: { items: [{ stagedId: m.id, action: "accept" }], reviewedComplete: false },
            },
            { onSuccess: () => finish(m.display), onError: (e) => setError(errorMessage(e)) },
          )
        : finish(m.display),
    onError: (e) => setError(errorMessage(e)),
  });
  const save = () => {
    setTouched(true);
    if (!drug) return;
    const fields = {
      display: drug.name,
      rxnormCode: drug.rxcui,
      dosageText: sig.trim() || null,
      effectiveStart: start,
      reasonConditionId: reason || null,
    };
    if (med)
      update.mutate({
        params: { medicationStatementId: med.id },
        version: med.version,
        body: fields,
      });
    else
      create.mutate({ params: { patientId }, body: { patientId, ...fields, reportedBy: source } });
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            {staged
              ? "Edit & accept medication"
              : med
                ? "Change medication"
                : "Add patient-reported medication"}
          </SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          <FieldShell
            label="Medication"
            required
            error={touched && !drug ? "Choose a medication." : undefined}
            hint="RxNorm search; supplements can be used as typed."
          >
            <DrugPicker
              value={drug}
              onChange={setDrug}
              testId={tid(S, "me-drug")}
              invalid={touched && !drug}
            />
          </FieldShell>
          <FieldShell label="How taken" htmlFor="me-sig">
            <Input
              id="me-sig"
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              placeholder="1 tab by mouth daily"
              data-testid={tid(S, "me-sig")}
            />
          </FieldShell>
          <FieldShell label="Started">
            <DateInput
              value={start}
              onChange={setStart}
              aria-label="Started"
              testId={tid(S, "me-start")}
            />
          </FieldShell>
          {!med ? (
            <FieldShell label="Source">
              <Select
                value={source}
                onValueChange={setSource}
                aria-label="Source"
                testId={tid(S, "me-source")}
                options={[
                  { value: "PATIENT_REPORTED", label: "Patient-reported" },
                  { value: "OUTSIDE_RECORD", label: "Outside prescriber" },
                  { value: "ENTERED", label: "Entered by staff" },
                ]}
              />
            </FieldShell>
          ) : null}
          <FieldShell label="For problem">
            <Select
              value={reason}
              onValueChange={(v) => setReason(v === "NONE" ? "" : v)}
              aria-label="For problem"
              placeholder="Not linked"
              options={[{ value: "NONE", label: "Not linked" }, ...problems]}
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
            disabled={create.isPending || update.isPending || reconcile.isPending}
            data-testid={tid(S, "me-save")}
          >
            {staged ? "Save & accept" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DiscontinueDialog({
  med,
  erx,
  onClose,
}: {
  med: MedicationStatementView | null;
  erx: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [cancelRx, setCancelRx] = React.useState(false);
  React.useEffect(() => (setReason(""), setCancelRx(false)), [med]);
  const stop = useApiMutation("discontinueMedication", {
    invalidates: [...INVALIDATES],
    onSuccess: (m) => (toast(`${m.display} discontinued.`), onClose()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open={!!med}
      onOpenChange={(o) => !o && onClose()}
      title={`Discontinue ${med?.display ?? "medication"}?`}
      description="It moves to inactive medications with the reason you choose."
      action="Discontinue"
      testId={tid(S, "discontinue")}
      disabled={!reason || stop.isPending}
      onConfirm={() => {
        if (!med) return;
        stop.mutate({
          params: { medicationStatementId: med.id },
          body: { reason, cancelAtPharmacy: cancelRx },
        });
      }}
    >
      <div className="grid gap-4 py-2">
        <FieldShell label="Reason" required>
          <Select
            value={reason}
            onValueChange={setReason}
            aria-label="Reason"
            testId={tid(S, "dc-reason")}
            options={DC_REASONS.map((r) => ({ value: r, label: r }))}
          />
        </FieldShell>
        {med?.activeRequest ? (
          erx ? (
            <Checkbox
              checked={cancelRx}
              onCheckedChange={(v) => setCancelRx(v === true)}
              label="Send cancel to pharmacy"
            />
          ) : (
            <span className="grid gap-1">
              <Checkbox checked={false} disabled label="Send cancel to pharmacy" />
              <span className="text-small text-ink-2">
                Available once e-prescribing is connected. Call the pharmacy to cancel.
              </span>
            </span>
          )
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
