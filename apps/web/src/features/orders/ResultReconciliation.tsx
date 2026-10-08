import * as React from "react";
import { toast } from "sonner";
import type { InboundResult, MatchStatus } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, status, formatDate, formatDateTime, pluralize } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { RadioGroup, Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { InboxLayout } from "@/features/inbox/InboxLayout";
import { Pressable } from "@/components/ui/pressable";

const S = "orders.result-reconciliation";

const STATUS_OPTIONS: Array<{ value: MatchStatus; label: string }> = [
  { value: "UNMATCHED", label: "Unmatched" },
  { value: "MANUALLY_MATCHED", label: "Matched by staff" },
  { value: "AUTO_MATCHED", label: "Matched automatically" },
  { value: "REJECTED", label: "Rejected" },
];

const demo = (r: InboundResult) =>
  (r.demographics && typeof r.demographics === "object" ? r.demographics : {}) as Record<
    string,
    unknown
  >;
const nameOf = (r: InboundResult) => {
  const d = demo(r);
  return String(
    d.name ?? ([d.lastName, d.firstName].filter(Boolean).join(", ") || "Unknown patient"),
  );
};

/** orders.result-reconciliation: lab results that did not match a patient and order (INV-SAFE-03). */
export function ResultReconciliationPage() {
  const v = useView();
  const [matchStatus, setMatchStatus] = React.useState<MatchStatus>("UNMATCHED");
  const q = useApi("listInboundResults", { query: { matchStatus } }, { refetchInterval: 60_000 });
  const rows = q.data?.data ?? [];
  const selected = rows.find((r) => r.id === v.id) ?? rows[0] ?? null;
  return (
    <InboxLayout
      counts={matchStatus === "UNMATCHED" ? { "orders.result-reconciliation": rows.length } : {}}
    >
      <Card className="p-0" data-testid={tid(S, "ur-item")}>
        <h2 className="px-5 pb-2 pt-5 text-h3">{pluralize(rows.length, "inbound result")}</h2>
        <div className="px-5 pb-3">
          <Select
            value={matchStatus}
            onValueChange={setMatchStatus}
            options={STATUS_OPTIONS}
            aria-label="Match status"
          />
        </div>
        {q.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!q.isLoading && !rows.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">Nothing here.</p>
        ) : null}
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              <Pressable
                type="button"
                onClick={() => v.open("result", r.id)}
                className={cn(
                  "grid w-full gap-0.5 px-5 py-3 text-left hover:bg-surface-hover",
                  selected?.id === r.id && "bg-pine-50",
                )}
              >
                <b className="font-semibold">{nameOf(r)}</b>
                <span className="text-small tabular-nums text-ink-2">
                  {demo(r).dob ? `DOB ${formatDate(String(demo(r).dob))} · ` : ""}
                  {r.lab}
                  {r.accessionNumber ? ` · ${r.accessionNumber}` : ""}
                </span>
                <span className="text-small text-ink-2">
                  Received {formatDateTime(r.receivedAt)}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <InboundDetail key={selected.id} id={selected.id} /> : <span />}
    </InboxLayout>
  );
}

function InboundDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useApi("getInboundResult", { params: { inboundResultId: id } });
  const d = q.data;
  const [patientId, setPatientId] = React.useState("");
  const [orderId, setOrderId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const orders = useApi(
    "listPatientServiceRequests",
    { params: { patientId }, query: {} },
    { enabled: !!patientId },
  );
  const done = { invalidates: ["listInboundResults" as const, "getInboxCounts" as const] };
  const match = useApiMutation("matchInboundResult", {
    ...done,
    onSuccess: () => toast("Result filed to the chart. The ordering provider is notified."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reject = useApiMutation("rejectInboundResult", {
    ...done,
    onSuccess: () => (toast("Result rejected back to the lab."), setRejecting(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!d)
    return (
      <Card>
        {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : <LoadingRows rows={6} />}
      </Card>
    );
  const pending = d.matchStatus === "UNMATCHED";
  const fields = Object.entries(demo(d)).filter(([, v]) => v != null && v !== "");
  const suggested = d.candidateMatches.find((c) => c.patient.id === patientId)?.orderId;
  const orderOptions = (orders.data?.data ?? [])
    .filter((o) => o.status === "SENT" || o.status === "COLLECTED" || o.id === suggested)
    .map((o) => ({
      value: o.id,
      label: `${o.display} · ${o.placerOrderNumber ?? "no order number"} · ${status("order", o.status)}`,
    }));
  return (
    <Card data-testid={tid(S, "ur-message")}>
      <CardHeader
        title={`${nameOf(d)} · ${d.lab}`}
        actions={<Tag tone={pending ? "caution" : "outline"}>{enumLabel(d.matchStatus)}</Tag>}
      />
      <div className="grid gap-5">
        <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
          {fields.map(([k, val]) => (
            <React.Fragment key={k}>
              <dt className="text-ink-2">
                {k === "mrn"
                  ? "MRN"
                  : k === "dob"
                    ? "DOB"
                    : enumLabel(k.replace(/([A-Z])/g, "_$1"))}
              </dt>
              <dd className="tabular-nums">{String(val)}</dd>
            </React.Fragment>
          ))}
          {d.accessionNumber ? (
            <>
              <dt className="text-ink-2">Accession</dt>
              <dd className="tabular-nums">{d.accessionNumber}</dd>
            </>
          ) : null}
          {d.placerOrderNumber ? (
            <>
              <dt className="text-ink-2">Order number</dt>
              <dd className="tabular-nums">{d.placerOrderNumber}</dd>
            </>
          ) : null}
        </dl>
        <pre className="max-h-48 overflow-auto bg-surface-muted p-3 text-small">{d.rawPreview}</pre>
        {pending ? (
          <>
            <div className="grid gap-2" data-testid={tid(S, "ur-candidate")}>
              <b className="font-semibold">Possible patients</b>
              {d.candidateMatches.length ? (
                <RadioGroup
                  orientation="vertical"
                  value={patientId}
                  onValueChange={(pid) => {
                    setPatientId(pid);
                    setOrderId(d.candidateMatches.find((c) => c.patient.id === pid)?.orderId ?? "");
                  }}
                  aria-label="Candidate patient"
                  options={d.candidateMatches.map((c) => ({
                    value: c.patient.id,
                    label: (
                      <span className="tabular-nums">
                        {c.patient.name} · DOB {formatDate(c.patient.birthDate)} · MRN{" "}
                        {c.patient.mrn} · score {Math.round(c.score * 100)}%
                      </span>
                    ),
                  }))}
                />
              ) : (
                <p className="text-body text-ink-2">
                  No candidate patients. Reject the result back to the lab.
                </p>
              )}
            </div>
            {patientId ? (
              <FieldShell
                label="Order"
                htmlFor="ur-order"
                hint="Optional. Leave empty to file without an order."
              >
                <Select
                  id="ur-order"
                  value={orderId}
                  onValueChange={setOrderId}
                  options={orderOptions}
                  placeholder={orders.isLoading ? "Loading orders" : "No order selected"}
                />
              </FieldShell>
            ) : null}
            {can("matchInboundResult") ? (
              <FieldShell label="Reason for this match" htmlFor="ur-reason" required>
                <Textarea
                  id="ur-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid={tid(S, "ur-reason")}
                />
              </FieldShell>
            ) : null}
            <div className="flex justify-end gap-2">
              {can("rejectInboundResult") ? (
                <Button
                  onClick={() => (setRejectReason(""), setRejecting(true))}
                  data-testid={tid(S, "ur-reject")}
                >
                  Not our patient · reject to lab
                </Button>
              ) : null}
              {can("matchInboundResult") ? (
                <Button
                  variant="primary"
                  disabled={!patientId || !reason.trim() || match.isPending}
                  onClick={() =>
                    match.mutate({
                      params: { inboundResultId: id },
                      body: {
                        patientId,
                        serviceRequestId: orderId || undefined,
                        reason: reason.trim(),
                      },
                    })
                  }
                  data-testid={tid(S, "ur-match")}
                >
                  Match to patient and order
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-body text-ink-2">
            {enumLabel(d.matchStatus)}
            {d.decidedAt ? ` · ${formatDateTime(d.decidedAt)}` : ""}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this result back to the lab?"
        description="Use this when the result is for a patient this practice doesn't serve."
        action="Reject result"
        danger
        disabled={!rejectReason.trim() || reject.isPending}
        onConfirm={() =>
          reject.mutate({ params: { inboundResultId: id }, body: { reason: rejectReason.trim() } })
        }
      >
        <FieldShell label="Reason" htmlFor="ur-reject-reason">
          <Textarea
            id="ur-reject-reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </FieldShell>
      </ConfirmDialog>
    </Card>
  );
}
