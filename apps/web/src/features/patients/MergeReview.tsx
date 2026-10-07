import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { DuplicateCandidateView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import {
  Alert,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
} from "@/components/ui/layout";
import { RadioGroup, Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tag } from "@/components/ui/tag";
import { SubNav } from "@/shell/patterns";
import { pathTo } from "@/app/routes";

const S = "patients.merge-review";
const FIELD_LABEL: Record<string, string> = {
  firstName: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  suffix: "Suffix",
  preferredName: "Preferred name",
  birthDate: "Date of birth",
  administrativeGender: "Administrative gender",
  sexForClinicalUse: "Sex for clinical use",
  genderIdentity: "Gender identity",
  pronouns: "Pronouns",
  sexualOrientation: "Sexual orientation",
  preferredLanguage: "Language",
  interpreterNeeded: "Interpreter",
  maritalStatus: "Marital status",
  pcpPractitionerId: "PCP",
  preferredPharmacyId: "Pharmacy",
  codeStatus: "Code status",
  ssnLast4: "SSN last 4",
  phone: "Phone",
};

/** patients.merge-review: resolve duplicates with a reversible, audited merge (INV-ID-04). */
export function MergeReviewPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = React.useState<"OPEN" | "MERGED" | "NOT_DUPLICATE" | "UNMERGED">(
    "OPEN",
  );
  const list = useApi("listDuplicateCandidates", { query: { status: [status] } });
  const selected = params.get("pair");
  return (
    <Page>
      <PageHeader
        title="Duplicates"
        crumbs={[{ label: "Patients", to: pathTo("patients.search") }, { label: "Duplicates" }]}
      />
      <SubNav which="patients" />
      <div className="grid grid-cols-[minmax(320px,420px)_minmax(0,1fr)] gap-6">
        <Card>
          <CardHeader
            title="Possible duplicates"
            actions={
              <Select
                aria-label="Status"
                className="h-control-sm w-40"
                value={status}
                onValueChange={(v) => setStatus(v)}
                options={[
                  { value: "OPEN", label: "To review" },
                  { value: "MERGED", label: "Merged" },
                  { value: "NOT_DUPLICATE", label: "Not duplicates" },
                  { value: "UNMERGED", label: "Unmerged" },
                ]}
              />
            }
          />
          {list.isLoading ? (
            <LoadingRows />
          ) : list.error ? (
            <ErrorState onRetry={() => void list.refetch()} />
          ) : !list.data?.data.length ? (
            <EmptyState title="No pairs here" />
          ) : null}
          <ul className="grid">
            {list.data?.data.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid={tid(S, "pair-row")}
                  onClick={() => setParams({ pair: c.id })}
                  className={cn(
                    "grid w-full gap-1 px-3 py-3 text-left hover:bg-surface-hover",
                    selected === c.id && "bg-pine-50",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{c.a.name}</span>
                    <span className="text-small tabular-nums text-ink-2">
                      {Math.round(c.score * 100)}%
                    </span>
                  </span>
                  <span className="text-small text-ink-2">
                    and {c.b.name} · DOB {formatDate(c.a.birthDate)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected ? (
          <Compare id={selected} onDone={() => setParams({})} />
        ) : (
          <Card>
            <EmptyState title="Choose a pair to compare" />
          </Card>
        )}
      </div>
    </Page>
  );
}

function Compare({ id, onDone }: { id: string; onDone: () => void }) {
  const { can } = useAuth();
  const cmp = useApi("getDuplicateComparison", { params: { duplicateCandidateId: id } });
  const [survivor, setSurvivor] = React.useState<"a" | "b">("a");
  const [choices, setChoices] = React.useState<Record<string, "a" | "b">>({});
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "merge" | "dismiss" | "unmerge">(null);
  const [error, setError] = React.useState<string | null>(null);
  const invalidates = ["listDuplicateCandidates", "getDuplicateComparison"] as const;
  const merge = useApiMutation("mergePatients", {
    invalidates: [...invalidates],
    onSuccess: () => (toast("Records merged. You can undo this from Merged."), onDone()),
    onError: (e) => setError(errorMessage(e)),
  });
  const dismiss = useApiMutation("dismissDuplicate", {
    invalidates: [...invalidates],
    onSuccess: () => (toast("Marked as not duplicates."), onDone()),
    onError: (e) => setError(errorMessage(e)),
  });
  const unmerge = useApiMutation("unmergePatients", {
    invalidates: [...invalidates],
    onSuccess: () => (toast("Merge undone."), onDone()),
    onError: (e) => setError(errorMessage(e)),
  });

  React.useEffect(() => {
    setChoices({});
    setSurvivor("a");
    setReason("");
    setError(null);
  }, [id]);

  if (cmp.isLoading)
    return (
      <Card>
        <LoadingRows />
      </Card>
    );
  if (cmp.error || !cmp.data)
    return (
      <Card>
        <ErrorState onRetry={() => void cmp.refetch()} />
      </Card>
    );
  const { candidate: c, fields, recordCounts } = cmp.data;
  const keep = survivor === "a" ? c.a : c.b;
  const other = survivor === "a" ? c.b : c.a;
  const open = c.status === "OPEN" || c.status === "UNMERGED";
  const pick = (field: string) => choices[field] ?? survivor;

  return (
    <Card className="grid content-start gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-h3 text-ink">Compare records</h3>
        <Tag tone={c.status === "OPEN" ? "caution" : "neutral"}>{enumLabel(c.status)}</Tag>
      </div>
      {error ? <Alert tone="caution">{error}</Alert> : null}
      <Table data-testid={tid(S, "compare-table")}>
        <TableHeader>
          <tr>
            <TableHead>Field</TableHead>
            <TableHead>Record A · MRN {c.a.mrn}</TableHead>
            <TableHead>Record B · MRN {c.b.mrn}</TableHead>
            {open ? <TableHead>Keep</TableHead> : null}
          </tr>
        </TableHeader>
        <TableBody>
          {fields
            .filter((f) => f.a !== undefined || f.b !== undefined)
            .map((f) => (
              <TableRow key={f.field}>
                <TableCell compact className="text-ink-2">
                  {FIELD_LABEL[f.field] ?? f.field}
                </TableCell>
                <TableCell compact className={cn(!f.same && "font-semibold")}>
                  {display(f.field, f.a)}
                </TableCell>
                <TableCell compact className={cn(!f.same && "font-semibold")}>
                  {display(f.field, f.b)}
                </TableCell>
                {open ? (
                  <TableCell compact>
                    {!f.same && f.field !== "phone" ? (
                      <RadioGroup<"a" | "b">
                        testId={tid(S, "field-pick")}
                        aria-label={`Keep ${FIELD_LABEL[f.field] ?? f.field} from`}
                        value={pick(f.field)}
                        onValueChange={(v) => setChoices((x) => ({ ...x, [f.field]: v }))}
                        options={[
                          { value: "a", label: "A" },
                          { value: "b", label: "B" },
                        ]}
                      />
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          {recordCounts.map((r) => (
            <TableRow key={r.type}>
              <TableCell compact className="text-ink-2">
                {r.type} records
              </TableCell>
              <TableCell compact numeric className="text-left">
                {r.a}
              </TableCell>
              <TableCell compact numeric className="text-left">
                {r.b}
              </TableCell>
              {open ? <TableCell compact /> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {open ? (
        <>
          <FieldShell label="Record to keep">
            <RadioGroup<"a" | "b">
              testId={tid(S, "survivor-pick")}
              value={survivor}
              onValueChange={(v) => {
                setSurvivor(v);
                setChoices({});
              }}
              options={[
                { value: "a", label: `Keep record A (MRN ${c.a.mrn})` },
                { value: "b", label: `Keep record B (MRN ${c.b.mrn})` },
              ]}
            />
          </FieldShell>
          <FieldShell label="Why are these the same person?" required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: same SSN and address; patient confirmed by phone."
            />
          </FieldShell>
          <div className="flex flex-wrap justify-end gap-2">
            {can("dismissDuplicate") ? (
              <Button
                variant="ghost"
                onClick={() => setConfirm("dismiss")}
                data-testid={tid(S, "not-duplicate")}
              >
                Not duplicates
              </Button>
            ) : null}
            {can("mergePatients") ? (
              <Button
                variant="primary"
                disabled={reason.trim().length < 5}
                loading={merge.isPending}
                onClick={() => setConfirm("merge")}
                data-testid={tid(S, "merge")}
              >
                Merge records
              </Button>
            ) : null}
          </div>
        </>
      ) : c.status === "MERGED" && c.mergeId && can("unmergePatients") ? (
        <div className="flex justify-end">
          <Button
            onClick={() => setConfirm("unmerge")}
            loading={unmerge.isPending}
            data-testid={tid(S, "unmerge")}
          >
            Unmerge
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm === "merge"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Merge these records?"
        description={`Record ${other.mrn} is folded into ${keep.mrn}. Its visits, lists and documents move to the kept record. You can undo this later.`}
        action="Merge"
        onConfirm={async () => {
          // Optimistic concurrency: merge against the survivor version we just read (ETag).
          const current = await api("getPatient", { params: { patientId: keep.id } }).catch(
            (e) => (setError(errorMessage(e)), null),
          );
          if (!current) return;
          merge.mutate({
            params: { duplicateCandidateId: c.id },
            body: {
              survivorId: keep.id,
              mergedId: other.id,
              fieldChoices: Object.entries(choices).map(([field, from]) => ({ field, from })),
              reason: reason.trim(),
              version: current.version,
            },
          });
        }}
      />
      <ConfirmDialog
        open={confirm === "dismiss"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Mark as not duplicates?"
        description="Both records stay as they are and this pair leaves the review list."
        action="Mark as not duplicates"
        onConfirm={() => dismiss.mutate({ params: { duplicateCandidateId: c.id } })}
      />
      <ConfirmDialog
        open={confirm === "unmerge"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Undo this merge?"
        description="Both records are restored and every moved item goes back to its original record."
        action="Undo merge"
        onConfirm={() => unmerge.mutate({ params: { patientMergeId: c.mergeId! } })}
      />
    </Card>
  );
}

function display(field: string, v: string | undefined) {
  if (v === undefined) return "—";
  if (field === "birthDate") return <span className="tabular-nums">{formatDate(v)}</span>;
  if (/^[A-Z_]+$/.test(v)) return enumLabel(v);
  return v;
}

export type { DuplicateCandidateView };
