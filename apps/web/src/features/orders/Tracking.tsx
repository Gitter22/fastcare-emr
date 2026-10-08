import * as React from "react";
import { toast } from "sonner";
import type { OverdueOrderRow } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDate, formatShortDate, pluralize, todayIso } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/domain/StatusChip";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { InboxLayout } from "@/features/inbox/InboxLayout";
import { Pressable } from "@/components/ui/pressable";

const S = "orders.tracking";

/** orders.tracking: orders past their expected date without a result (INV-SAFE-07, flow:results/06). */
export function TrackingPage() {
  const v = useView();
  const q = useApi("listOverdueOrders", { query: {} }, { refetchInterval: 60_000 });
  const rows = q.data?.data ?? [];
  const selected = rows.find((r) => r.serviceRequest.id === v.id) ?? rows[0] ?? null;
  return (
    <InboxLayout counts={{ "orders.tracking": rows.length }}>
      <Card className="p-0" data-testid={tid(S, "ot-item")}>
        <h2 className="px-5 pb-2 pt-5 text-h3">{pluralize(rows.length, "overdue order")}</h2>
        {q.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!q.isLoading && !rows.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">No orders are overdue.</p>
        ) : null}
        <ul>
          {rows.map((r) => (
            <li key={r.serviceRequest.id}>
              <Pressable
                type="button"
                onClick={() => v.open("order", r.serviceRequest.id)}
                className={cn(
                  "grid w-full gap-0.5 px-5 py-3 text-left hover:bg-surface-hover",
                  selected?.serviceRequest.id === r.serviceRequest.id && "bg-pine-50",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <b className="font-semibold">{r.patient.name}</b>
                  <Tag tone="caution">{r.daysOverdue} d overdue</Tag>
                </span>
                <span className="text-small tabular-nums text-ink-2">
                  DOB {formatDate(r.patient.birthDate)} · MRN {r.patient.mrn}
                </span>
                <span className="text-small text-ink-2">{r.serviceRequest.display}</span>
              </Pressable>
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <TrackingDetail key={selected.serviceRequest.id} row={selected} /> : <span />}
    </InboxLayout>
  );
}

function TrackingDetail({ row }: { row: OverdueOrderRow }) {
  const { can } = useAuth();
  const me = useMe();
  const sr = row.serviceRequest;
  const [extend, setExtend] = React.useState(false);
  const [cancel, setCancel] = React.useState(false);
  const [date, setDate] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const done = { invalidates: ["listOverdueOrders" as const] };
  const ext = useApiMutation("extendExpectedDate", {
    ...done,
    onSuccess: () => (toast("Expected date extended."), setExtend(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const can_ = useApiMutation("cancelServiceRequest", {
    ...done,
    onSuccess: () => (toast("Order cancelled."), setCancel(false), setReason("")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const check = useApiMutation("checkOrderStatusWithLab", {
    onSuccess: () => toast("Checked with the lab."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const labConnected = me.connectedGateways.includes("LabGateway");
  const checkBtn = (
    <Button
      size="sm"
      disabled={!labConnected || check.isPending}
      onClick={() => check.mutate({ params: { serviceRequestId: sr.id } })}
      data-testid={tid(S, "ot-check-lab")}
    >
      Check status with lab
    </Button>
  );
  const p = row.patient;
  return (
    <Card data-testid={tid(S, "ot-order")}>
      <CardHeader
        title={`${p.name} · ${sr.display}`}
        actions={
          <>
            {can("checkOrderStatusWithLab") ? (
              labConnected ? (
                checkBtn
              ) : (
                <Unavailable reason="No lab interface is connected. Call the lab.">
                  {checkBtn}
                </Unavailable>
              )
            ) : null}
            {can("extendExpectedDate") ? (
              <Button
                size="sm"
                onClick={() => (setDate(null), setExtend(true))}
                data-testid={tid(S, "ot-extend")}
              >
                Extend expected date
              </Button>
            ) : null}
            {can("cancelServiceRequest") ? (
              <Button size="sm" onClick={() => setCancel(true)} data-testid={tid(S, "ot-cancel")}>
                Cancel order
              </Button>
            ) : null}
          </>
        }
      />
      <p className="mb-4 text-small tabular-nums text-ink-2">
        DOB {formatDate(p.birthDate)} · MRN {p.mrn}
      </p>
      <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
        <dt className="text-ink-2">Status</dt>
        <dd>
          <StatusChip machine="order" value={sr.status} />
        </dd>
        <dt className="text-ink-2">Lab</dt>
        <dd>{sr.performerLab ?? "—"}</dd>
        <dt className="text-ink-2">Order number</dt>
        <dd className="tabular-nums">{sr.placerOrderNumber ?? "—"}</dd>
        <dt className="text-ink-2">Sent</dt>
        <dd>{sr.sentAt ? formatShortDate(sr.sentAt) : "—"}</dd>
        <dt className="text-ink-2">Expected by</dt>
        <dd className="tabular-nums">
          {sr.expectedBy ? formatShortDate(sr.expectedBy) : "—"} · {row.daysOverdue} days overdue
        </dd>
        {row.lastOutreach ? (
          <>
            <dt className="text-ink-2">Last outreach</dt>
            <dd>
              {formatShortDate(row.lastOutreach.at)} · {row.lastOutreach.outcome}
            </dd>
          </>
        ) : null}
      </dl>
      <Dialog open={extend} onOpenChange={setExtend}>
        <DialogContent className="w-dialog-sm">
          <DialogHeader>
            <DialogTitle>Extend expected date</DialogTitle>
          </DialogHeader>
          <FieldShell label="New expected date" htmlFor="ot-date">
            <DateInput id="ot-date" value={date} onChange={setDate} fromYear={2020} />
          </FieldShell>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExtend(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!date || date < todayIso() || ext.isPending}
              onClick={() =>
                date &&
                ext.mutate({ params: { serviceRequestId: sr.id }, body: { expectedBy: date } })
              }
              data-testid={tid(S, "ot-extend-save")}
            >
              Extend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={cancel}
        onOpenChange={setCancel}
        title={`Cancel ${sr.display} for ${p.name}?`}
        description="The lab is told not to run it. This can't be undone."
        action="Cancel order"
        danger
        disabled={!reason.trim() || can_.isPending}
        onConfirm={() =>
          can_.mutate({ params: { serviceRequestId: sr.id }, body: { reason: reason.trim() } })
        }
      >
        <FieldShell label="Reason" htmlFor="ot-reason">
          <Textarea id="ot-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldShell>
      </ConfirmDialog>
    </Card>
  );
}
