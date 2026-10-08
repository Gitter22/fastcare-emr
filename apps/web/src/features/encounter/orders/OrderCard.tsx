import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, OctagonAlert, X } from "lucide-react";
import type { Condition, OrderValidation, ServiceRequestView } from "@agile-emr/shared";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import {
  COLLECTION_OPTIONS,
  ORDER_INVALIDATES,
  PRIORITY_OPTIONS,
  ResendButton,
  orderTypeText,
  useLabConnected,
  useRequisition,
} from "./orderParts";

type Issue = OrderValidation["issues"][number];
interface AoeQuestion {
  code: string;
  text: string;
  type: "boolean" | "text" | "choice";
  options?: string[];
  required?: boolean;
}

/** AOE questions of a lab order, from its compendium item. */
function useAoeQuestions(o: ServiceRequestView): AoeQuestion[] {
  const q = useApi(
    "listLabCompendium",
    { query: { q: o.display, limit: 50 } },
    { enabled: o.category === "LAB" && !!o.labCompendiumItemId, staleTime: 300_000 },
  );
  const item = q.data?.data.find((i) => i.id === o.labCompendiumItemId);
  return ((item?.aoeQuestions as { items?: AoeQuestion[] } | null)?.items ?? []) as AoeQuestion[];
}

/**
 * One order in the cart (encounter.orders order-card): linked diagnosis, lab AOE answers, priority, collection,
 * expected-by, and the issues from validateEncounterOrders (missing dx, duplicate, ABN, authorization).
 */
export function OrderCard({
  order: o,
  diagnoses,
  issues,
  acknowledged,
  onAcknowledge,
  onRemove,
  onAddProblem,
  canEdit,
}: {
  order: ServiceRequestView;
  diagnoses: Condition[];
  issues: Issue[];
  acknowledged: Set<string>;
  onAcknowledge: (key: string) => void;
  onRemove: (o: ServiceRequestView) => void;
  onAddProblem: () => void;
  canEdit: boolean;
}) {
  const pended = o.status === "PENDED";
  const editable = pended && canEdit;
  const aoe = useAoeQuestions(o);
  const labConnected = useLabConnected();
  const requisition = useRequisition();
  const update = useApiMutation("updateServiceRequest", {
    invalidates: ORDER_INVALIDATES,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const patch = (body: Record<string, unknown>) =>
    update.mutate({
      params: { serviceRequestId: o.id },
      version: o.version,
      body: body as never,
    });
  const answers = (o.aoeAnswers ?? {}) as Record<string, unknown>;
  const setAnswer = (code: string, v: unknown) => patch({ aoeAnswers: { ...answers, [code]: v } });
  const dxId = o.reasons[0]?.conditionId ?? "";
  const dx = diagnoses.find((d) => d.id === dxId);
  const open = issues.filter((i) => !acknowledged.has(`${o.id}:${i.code}`));
  const errors = issues.filter((i) => i.severity === "error");
  const missingDx = issues.some((i) => i.code === "missing-dx");
  const aoeIssue = issues.some((i) => i.code === "aoe");
  // Missing diagnosis and AOE answers are shown on their fields; the rest need a card-level notice.
  const cardIssues = issues.filter((i) => i.code !== "missing-dx" && i.code !== "aoe");
  const needsAttention = pended && (errors.length > 0 || open.length > 0);
  const lab = o.category === "LAB";

  const summary = [
    dx ? `Dx ${dx.icd10Code ?? dx.display}` : null,
    PRIORITY_OPTIONS.find((p) => p.value === o.priority)?.label,
    lab ? COLLECTION_OPTIONS.find((c) => c.value === o.collectionMode)?.label.toLowerCase() : null,
    o.expectedBy ? `expected by ${formatShortDate(o.expectedBy)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card
      data-testid="order-card"
      data-order-id={o.id}
      className={needsAttention ? "p-0 outline outline-2 outline-ink" : "p-0"}
    >
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <h4 className="text-h3">{o.display}</h4>
        <Tag tone="outline" data-testid="oc-type">
          {orderTypeText(o)}
        </Tag>
        <StatusChip machine="order" value={o.status} testId="oc-status" />
        {!needsAttention ? (
          <span className="min-w-0 truncate text-small text-ink-2">{summary}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {needsAttention ? (
            <span
              className="flex items-center gap-1.5 text-label font-semibold"
              data-testid="oc-attention"
            >
              <OctagonAlert size={16} strokeWidth={1.75} aria-hidden />
              {open.length} {open.length === 1 ? "item" : "items"} to fix
            </span>
          ) : pended ? (
            <span className="text-small text-ink-2">Ready</span>
          ) : null}
          {o.status === "SIGNED" || o.status === "SENT" ? (
            <>
              {lab ? (
                <Button
                  size="sm"
                  disabled={requisition.pending === o.id}
                  onClick={() => void requisition.open(o.id)}
                  data-testid="oc-requisition"
                >
                  Print requisition
                </Button>
              ) : null}
              {lab && (o.status === "SIGNED" || !labConnected) ? <ResendButton order={o} /> : null}
            </>
          ) : null}
          {(pended || o.status === "SIGNED" || o.status === "SENT") && canEdit ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${o.display}`}
              data-testid="oc-remove"
              onClick={() => onRemove(o)}
            >
              <X size={16} strokeWidth={1.75} />
            </Button>
          ) : null}
        </span>
      </div>
      {o.status === "CANCELLED" && o.cancelledReason ? (
        <p className="px-6 pb-4 text-small text-ink-2">Cancelled: {o.cancelledReason}</p>
      ) : null}
      {pended ? (
        <div className="grid gap-4 border-t border-line px-6 py-4 md:grid-cols-2 xl:grid-cols-4">
          <FieldShell
            label="Linked diagnosis"
            required
            error={missingDx ? "Required to send" : undefined}
            hint={
              !diagnoses.length ? (
                <Button size="sm" variant="ghost" onClick={onAddProblem}>
                  + Add problem
                </Button>
              ) : undefined
            }
          >
            <Select
              value={dxId}
              onValueChange={(v) => patch({ reasonConditionIds: [v] })}
              placeholder="Choose a diagnosis…"
              aria-label={`Linked diagnosis for ${o.display}`}
              testId="oc-dx"
              invalid={missingDx}
              disabled={!editable}
              options={diagnoses.map((d) => ({
                value: d.id,
                label: `${d.icd10Code ? `${d.icd10Code} ` : ""}${d.display}`,
              }))}
            />
          </FieldShell>
          {aoe.map((a) => {
            const v = answers[a.code];
            const unanswered = a.required && (v === undefined || v === "" || v === null);
            return (
              <FieldShell
                key={a.code}
                label={a.text}
                required={a.required}
                error={aoeIssue && unanswered ? "Lab question unanswered" : undefined}
              >
                {a.type === "text" ? (
                  <AoeText
                    value={typeof v === "string" ? v : ""}
                    disabled={!editable}
                    label={a.text}
                    invalid={aoeIssue && unanswered}
                    onCommit={(t) => setAnswer(a.code, t)}
                  />
                ) : (
                  <Select
                    value={
                      v === undefined || v === null
                        ? ""
                        : typeof v === "boolean"
                          ? v
                            ? "yes"
                            : "no"
                          : String(v)
                    }
                    onValueChange={(s) => setAnswer(a.code, a.type === "boolean" ? s === "yes" : s)}
                    aria-label={a.text}
                    testId={`oc-aoe-${a.code}`}
                    placeholder="Answer required"
                    disabled={!editable}
                    invalid={aoeIssue && unanswered}
                    options={
                      a.type === "boolean"
                        ? [
                            { value: "yes", label: "Yes" },
                            { value: "no", label: "No" },
                          ]
                        : (a.options ?? []).map((x) => ({ value: x, label: x }))
                    }
                  />
                )}
              </FieldShell>
            );
          })}
          <FieldShell label="Priority">
            <Select
              value={o.priority}
              onValueChange={(v) => patch({ priority: v })}
              options={PRIORITY_OPTIONS}
              aria-label="Priority"
              testId="oc-priority"
              disabled={!editable}
            />
          </FieldShell>
          {lab ? (
            <FieldShell label="Collection">
              <Select
                value={o.collectionMode}
                onValueChange={(v) => patch({ collectionMode: v })}
                options={COLLECTION_OPTIONS.filter((c) => c.value !== "NOT_APPLICABLE")}
                aria-label="Collection"
                testId="oc-collection"
                disabled={!editable}
              />
            </FieldShell>
          ) : null}
          <FieldShell label="Expected result by">
            <DateInput
              value={o.expectedBy}
              onChange={(d) => patch({ expectedBy: d })}
              aria-label="Expected result by"
              testId="oc-expected"
              disabled={!editable}
              fromYear={new Date().getFullYear()}
              toYear={new Date().getFullYear() + 2}
            />
          </FieldShell>
        </div>
      ) : null}
      {pended && cardIssues.length ? (
        <ul className="grid gap-2 px-6 pb-4">
          {cardIssues.map((i) => {
            const done = acknowledged.has(`${o.id}:${i.code}`);
            const ack = i.severity === "warning" && i.code !== "abn" && !done;
            return (
              <li
                key={i.code}
                data-testid={`oc-issue-${i.code}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-body outline-dashed outline-1 outline-line-strong"
              >
                <AlertTriangle size={18} strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1">
                  <b className="font-semibold">
                    {i.code === "duplicate"
                      ? "Possible duplicate."
                      : i.severity === "error"
                        ? "Fix before signing."
                        : "Review."}
                  </b>{" "}
                  {i.text}
                  {done ? " Kept." : ""}
                </span>
                {ack && editable ? (
                  <span className="flex gap-2">
                    <Button size="sm" onClick={() => onAcknowledge(`${o.id}:${i.code}`)}>
                      {i.code === "duplicate" ? "Keep both" : "Acknowledge"}
                    </Button>
                    {i.code === "duplicate" ? (
                      <Button size="sm" variant="primary" onClick={() => onRemove(o)}>
                        Remove this one
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

function AoeText({
  value,
  onCommit,
  ...p
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  label: string;
  invalid?: boolean;
}) {
  const [t, setT] = React.useState(value);
  React.useEffect(() => setT(value), [value]);
  return (
    <Input
      value={t}
      aria-label={p.label}
      disabled={p.disabled}
      aria-invalid={p.invalid || undefined}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => t.trim() !== value && onCommit(t.trim())}
    />
  );
}
