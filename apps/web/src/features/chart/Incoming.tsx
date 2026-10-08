import * as React from "react";
import { toast } from "sonner";
import type { OperationId, ProvenanceSource } from "@agile-emr/shared";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { formatShortDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

/**
 * Incoming items (INV-DATA-01 / ADR-002): patient-entered, outside-record and pharmacy items wait here, with their
 * source, until a staff member accepts, merges or rejects each one. Nothing here feeds alerts or the visit.
 */

export const SOURCE_LABEL: Record<ProvenanceSource, string> = {
  ENTERED: "Entered here",
  PATIENT_REPORTED: "Patient portal",
  OUTSIDE_RECORD: "Outside record",
  DEVICE: "Device",
  AI_DRAFT: "AI draft",
  INTERFACE: "Interface",
  REGISTRY: "Registry",
  PHARMACY: "Pharmacy",
};

export function IncomingCard({
  title,
  action,
  children,
  testId,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="grid gap-4 bg-surface p-6 outline-dashed outline-1 -outline-offset-1 outline-ink"
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 className="text-h3">{title}</h3>
          <p className="text-small text-ink-2">
            Accept, merge or reject each item. Nothing here is used for alerts or the visit until
            accepted.
          </p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type ReconcileOp = Extract<
  OperationId,
  "reconcileCondition" | "reconcileMedicationStatement" | "reconcileAllergy"
>;

export function ReconcileItem({
  op,
  params,
  id,
  source,
  when,
  title,
  detail,
  compare,
  mergeTargets,
  invalidates,
  extraActions,
  duplicateOf,
  testId,
}: {
  op: ReconcileOp;
  params: Record<string, string>;
  id: string;
  source: ProvenanceSource;
  when: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** Duplicate / conflict note shown next to the item. */
  compare?: React.ReactNode;
  mergeTargets: Array<{ id: string; label: string }>;
  invalidates: OperationId[];
  extraActions?: React.ReactNode;
  /** The active item this one probably duplicates: merge goes straight into it. */
  duplicateOf?: string;
  testId?: string;
}) {
  const [mergeInto, setMergeInto] = React.useState("");
  const [merging, setMerging] = React.useState(false);
  const m = useApiMutation(op as "reconcileCondition", {
    invalidates,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const decide = (action: "accept" | "reject" | "merge", into = mergeInto) =>
    m.mutate(
      {
        params: params as { conditionId: string },
        body: {
          items: [{ stagedId: id, action, ...(action === "merge" ? { mergeIntoId: into } : {}) }],
          reviewedComplete: false,
        },
      },
      {
        onSuccess: () =>
          toast(
            action === "accept"
              ? "Added to the chart."
              : action === "merge"
                ? "Merged into the existing item."
                : "Rejected. It stays out of the chart.",
          ),
      },
    );
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto] items-start gap-4 border-b border-line pb-4 last:border-0 last:pb-0"
      data-testid={testId}
    >
      <div className="grid gap-0.5">
        <span className="text-caption font-semibold uppercase tracking-wide text-ink-2">
          {SOURCE_LABEL[source]} · {formatShortDate(when)}
        </span>
        <b className="font-semibold">{title}</b>
        {detail ? <span className="text-small text-ink-2">{detail}</span> : null}
      </div>
      <div className="bg-surface-muted px-3 py-2 text-small">
        {compare ?? "Not on the list yet."}
      </div>
      <div className="grid justify-items-end gap-2">
        {merging ? (
          <div className="flex items-center gap-2">
            <Select
              aria-label="Merge into"
              value={mergeInto}
              onValueChange={setMergeInto}
              placeholder="Merge into…"
              className="w-56"
              options={mergeTargets.map((t) => ({ value: t.id, label: t.label }))}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!mergeInto || m.isPending}
              onClick={() => decide("merge")}
            >
              Merge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMerging(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            {duplicateOf ? (
              <Button
                size="sm"
                disabled={m.isPending}
                onClick={() => decide("merge", duplicateOf)}
                data-testid="rec-merge"
              >
                Merge into existing
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={m.isPending}
              onClick={() => decide("accept")}
              data-testid="rec-accept"
            >
              {duplicateOf ? "Add as separate" : "Accept"}
            </Button>
            {!duplicateOf && mergeTargets.length ? (
              <Button
                size="sm"
                disabled={m.isPending}
                onClick={() => setMerging(true)}
                data-testid="rec-merge"
              >
                Merge into existing
              </Button>
            ) : null}
            {extraActions}
            <Button
              size="sm"
              variant="ghost"
              disabled={m.isPending}
              onClick={() => decide("reject")}
              data-testid="rec-reject"
            >
              Reject
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
