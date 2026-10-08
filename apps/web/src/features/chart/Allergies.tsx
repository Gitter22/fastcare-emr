import * as React from "react";
import { useParams } from "react-router-dom";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import type { AllergyIntolerance } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate } from "@/lib/format";
import { useView } from "@/lib/useView";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { FieldShell } from "@/components/ui/form";
import { Alert, Card, Page, PageHeader } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
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
import { Unavailable } from "@/components/ui/unavailable";
import { AllergenPicker, type AllergenChoice } from "@/components/domain/CodePickers";
import { IncomingCard, ReconcileItem } from "./Incoming";

const S = "chart.allergies";
const INVALIDATES = [
  "listAllergies",
  "getPatientBanner",
  "getPatientSummary",
  "getRooming",
  "getPatient",
] as const;
const REACTIONS = [
  "Hives",
  "Rash",
  "Itching",
  "Swelling",
  "Anaphylaxis",
  "Shortness of breath",
  "Wheezing",
  "Nausea or vomiting",
  "Diarrhea",
  "Other",
];
const SEVERITY = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];
const CATEGORY_LABEL: Record<string, string> = {
  MEDICATION: "Drug",
  FOOD: "Food",
  ENVIRONMENT: "Environmental",
  BIOLOGIC: "Biologic",
};

type Reaction = { manifestation: string; severity?: string };
export const reactionsOf = (a: Pick<AllergyIntolerance, "reactions">): Reaction[] =>
  ((a.reactions as { items?: Reaction[] } | null)?.items ?? []) as Reaction[];

/** chart.allergies: allergies and intolerances with reaction and severity; the banner shows the active list. */
export function AllergiesPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const v = useView();
  const list = useApi("listAllergies", { params: { patientId }, query: {} });
  const staged = useApi("listAllergies", {
    params: { patientId },
    query: { stagingStatus: "STAGED" },
  });
  const patient = useApi("getPatient", { params: { patientId } });
  const review = useApiMutation("recordAllergyReview", {
    invalidates: [...INVALIDATES],
    onSuccess: (_, a) =>
      toast(
        (a.body as { noKnownAllergies?: boolean }).noKnownAllergies
          ? "Recorded: no known allergies."
          : "Allergy review recorded.",
      ),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const update = useApiMutation("updateAllergy", {
    invalidates: [...INVALIDATES],
    onSuccess: (a) => toast(`${a.substanceDisplay} updated.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const active = (list.data ?? []).filter((a) => a.clinicalStatus === "ACTIVE");
  const editing =
    v.view === "edit" && v.id ? (list.data?.find((a) => a.id === v.id) ?? null) : null;
  const p = patient.data;

  const columns = React.useMemo<Col<AllergyIntolerance>[]>(
    () => [
      {
        id: "substance",
        header: "Substance",
        accessorFn: (a) => a.substanceDisplay,
        cell: ({ row }) => (
          <span className="grid">
            <b className="font-semibold">{row.original.substanceDisplay}</b>
            <span className="text-small text-ink-2">{CATEGORY_LABEL[row.original.category]}</span>
          </span>
        ),
      },
      {
        id: "reaction",
        header: "Reaction",
        enableSorting: false,
        cell: ({ row }) =>
          reactionsOf(row.original)
            .map((r) => r.manifestation)
            .join(", ") || "Not recorded",
      },
      {
        id: "severity",
        header: "Severity",
        enableSorting: false,
        cell: ({ row }) => {
          const sev = reactionsOf(row.original).find((r) => r.severity)?.severity;
          return (
            <span className="flex items-center gap-2">
              {sev ? <span className="capitalize">{sev}</span> : "—"}
              {row.original.criticality === "HIGH" ? <Tag tone="critical">High risk</Tag> : null}
            </span>
          );
        },
      },
      {
        id: "verified",
        header: "Status",
        accessorFn: (a) => a.clinicalStatus,
        cell: ({ row }) =>
          row.original.clinicalStatus !== "ACTIVE" ? (
            <Tag tone="outline">Inactive</Tag>
          ) : row.original.verificationStatus === "CONFIRMED" ? (
            "Confirmed"
          ) : (
            <span className="capitalize">{row.original.verificationStatus.toLowerCase()}</span>
          ),
      },
      {
        id: "recorded",
        header: "Recorded",
        accessorFn: (a) => a.createdAt,
        cell: ({ row }) => (
          <span className="tabular-nums">{formatShortDate(row.original.createdAt)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) =>
          can("updateAllergy") ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${row.original.substanceDisplay}`}
                  data-testid={tid(S, "al-menu")}
                >
                  <MoreHorizontal size={18} strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => v.open("edit", row.original.id)}
                  data-testid={tid(S, "al-edit")}
                >
                  Edit
                </DropdownMenuItem>
                {row.original.clinicalStatus === "ACTIVE" ? (
                  <DropdownMenuItem
                    data-testid={tid(S, "al-inactivate")}
                    onSelect={() =>
                      update.mutate({
                        params: { allergyId: row.original.id },
                        version: row.original.version,
                        body: { clinicalStatus: "INACTIVE" },
                      })
                    }
                  >
                    Mark inactive
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onSelect={() =>
                    update.mutate({
                      params: { allergyId: row.original.id },
                      version: row.original.version,
                      body: { verificationStatus: "ENTERED_IN_ERROR" },
                    })
                  }
                >
                  Entered in error
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can],
  );

  const nka = (
    <Button
      onClick={() =>
        review.mutate({
          params: { patientId },
          body: { noKnownAllergies: true, reviewedAt: new Date().toISOString() },
        })
      }
      disabled={!!active.length || review.isPending}
      data-testid={tid(S, "nkda")}
    >
      Mark no known allergies
    </Button>
  );
  return (
    <Page>
      <PageHeader
        title="Allergies"
        actions={
          can("recordAllergyReview") ? (
            <>
              {active.length ? (
                <Unavailable reason="Mark the listed allergies inactive first if they no longer apply.">
                  {nka}
                </Unavailable>
              ) : (
                nka
              )}
              {can("createAllergy") ? (
                <Button
                  variant="primary"
                  onClick={() => v.open("edit")}
                  data-testid={tid(S, "add-allergy")}
                >
                  <Plus size={18} strokeWidth={1.75} />
                  Add allergy
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="-mt-3 flex items-center justify-between gap-4 bg-surface px-6 py-4">
        <span className="text-body" data-testid={tid(S, "review-status")}>
          {p?.noKnownAllergies && !active.length ? <b>No known allergies</b> : null}
          {p?.noKnownAllergies && !active.length ? " · " : null}
          <span className="text-ink-2">
            {p?.allergiesReviewedAt
              ? `Reviewed with patient ${formatShortDate(p.allergiesReviewedAt)}`
              : "Not reviewed with the patient yet"}
          </span>
        </span>
        {can("recordAllergyReview") ? (
          <Button
            onClick={() =>
              review.mutate({
                params: { patientId },
                body: { reviewedAt: new Date().toISOString() },
              })
            }
            disabled={review.isPending}
            data-testid={tid(S, "reviewed-today")}
          >
            Reviewed, no changes
          </Button>
        ) : null}
      </div>
      {staged.data?.length ? (
        <IncomingCard title="Incoming · not in the chart yet" testId={tid(S, "incoming")}>
          {staged.data.map((a) => (
            <ReconcileItem
              key={a.id}
              op="reconcileAllergy"
              params={{ allergyId: a.id }}
              id={a.id}
              source={a.source}
              when={a.createdAt}
              title={a.substanceDisplay}
              detail={reactionsOf(a)
                .map((r) => r.manifestation)
                .join(", ")}
              compare={
                active.some((x) => x.substanceCode === a.substanceCode)
                  ? "Already on the allergy list."
                  : "Not on our list."
              }
              mergeTargets={active.map((x) => ({ id: x.id, label: x.substanceDisplay }))}
              invalidates={[...INVALIDATES]}
            />
          ))}
        </IncomingCard>
      ) : null}
      <Card>
        <DataTable
          columns={columns}
          data={list.data ?? []}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={p?.noKnownAllergies ? "No known allergies" : "No allergies recorded"}
          getRowId={(a) => a.id}
          testId={tid(S, "allergy-table")}
        />
      </Card>
      <AllergyDrawer
        patientId={patientId}
        open={v.view === "edit"}
        allergy={editing}
        onClose={v.close}
      />
    </Page>
  );
}

function AllergyDrawer({
  patientId,
  open,
  allergy,
  onClose,
}: {
  patientId: string;
  open: boolean;
  allergy: AllergyIntolerance | null;
  onClose: () => void;
}) {
  const [substance, setSubstance] = React.useState<AllergenChoice | null>(null);
  const [reaction, setReaction] = React.useState("");
  const [severity, setSeverity] = React.useState("");
  const [criticality, setCriticality] = React.useState<"LOW" | "HIGH" | "UNABLE_TO_ASSESS">("LOW");
  const [verification, setVerification] = React.useState<"CONFIRMED" | "UNCONFIRMED">("CONFIRMED");
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setSubstance(
      allergy
        ? {
            system: allergy.substanceSystem as "RXNORM" | "SNOMEDCT",
            code: allergy.substanceCode,
            display: allergy.substanceDisplay,
            category: allergy.category,
          }
        : null,
    );
    const r = allergy ? reactionsOf(allergy)[0] : undefined;
    setReaction(r?.manifestation ?? "");
    setSeverity(r?.severity ?? "");
    setCriticality(allergy?.criticality ?? "LOW");
    setVerification(allergy?.verificationStatus === "UNCONFIRMED" ? "UNCONFIRMED" : "CONFIRMED");
    setError(null);
    setTouched(false);
  }, [open, allergy]);
  const done = (a: AllergyIntolerance) => (
    toast(`${a.substanceDisplay} saved. The banner is updated.`),
    onClose()
  );
  const create = useApiMutation("createAllergy", {
    invalidates: [...INVALIDATES],
    onSuccess: done,
    onError: (e) => setError(errorMessage(e)),
  });
  const update = useApiMutation("updateAllergy", {
    invalidates: [...INVALIDATES],
    onSuccess: done,
    onError: (e) => setError(errorMessage(e)),
  });
  const save = () => {
    setTouched(true);
    if (!substance || !reaction || !severity) return;
    const fields = {
      substanceSystem: substance.system,
      substanceCode: substance.code,
      substanceDisplay: substance.display,
      category: substance.category,
      criticality,
      verificationStatus: verification,
      reactions: { items: [{ manifestation: reaction, severity }] },
    };
    if (allergy)
      update.mutate({ params: { allergyId: allergy.id }, version: allergy.version, body: fields });
    else create.mutate({ params: { patientId }, body: { patientId, ...fields } });
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{allergy ? "Edit allergy" : "Add allergy"}</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          <FieldShell
            label="Substance"
            required
            error={touched && !substance ? "Choose the substance." : undefined}
          >
            <AllergenPicker
              value={substance}
              onChange={setSubstance}
              testId={tid(S, "al-substance")}
              invalid={touched && !substance}
            />
          </FieldShell>
          <FieldShell
            label="Reaction"
            required
            error={touched && !reaction ? "Choose the reaction." : undefined}
          >
            <Select
              value={reaction}
              onValueChange={setReaction}
              aria-label="Reaction"
              testId={tid(S, "al-reaction")}
              invalid={touched && !reaction}
              options={REACTIONS.map((r) => ({ value: r, label: r }))}
            />
          </FieldShell>
          <FieldShell
            label="Severity"
            required
            error={touched && !severity ? "Choose the severity." : undefined}
          >
            <Select
              value={severity}
              onValueChange={setSeverity}
              aria-label="Severity"
              testId={tid(S, "al-severity")}
              invalid={touched && !severity}
              options={SEVERITY}
            />
          </FieldShell>
          <FieldShell label="Risk of severe reaction">
            <Select
              value={criticality}
              onValueChange={setCriticality}
              aria-label="Risk of severe reaction"
              options={[
                { value: "LOW", label: "Low" },
                { value: "HIGH", label: "High" },
                { value: "UNABLE_TO_ASSESS", label: "Unable to assess" },
              ]}
            />
          </FieldShell>
          <FieldShell label="Verification status">
            <Select
              value={verification}
              onValueChange={setVerification}
              aria-label="Verification status"
              testId={tid(S, "al-verification")}
              options={[
                { value: "CONFIRMED", label: "Confirmed" },
                { value: "UNCONFIRMED", label: "Unconfirmed (reported)" },
              ]}
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
            data-testid={tid(S, "al-save")}
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
