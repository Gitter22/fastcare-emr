import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { ClaimStatus, ClaimSummary } from "@agile-emr/shared";
import { useMe } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, money, pluralize } from "@/lib/format";
import { openBlob } from "@/lib/files";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/domain/StatusChip";
import { BillingLayout } from "@/features/billing/BillingLayout";
import { ClaimTimeline, DeadlineChip } from "@/features/billing/claimParts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Pressable } from "@/components/ui/pressable";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Unavailable } from "@/components/ui/unavailable";

const S = "billing.claims";
const ALL = "__all";
const ORDER: ClaimStatus[] = [
  "READY",
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "PARTIALLY_PAID",
  "DENIED",
  "PAID",
];

type Outcome = { claimId: string; outcome: string; blockers?: unknown; detail?: string };

/** billing.claims: claim pipeline by status, submit ready claims, claim detail pane (flow rcm/03-04). */
export function ClaimsPage() {
  const v = useView();
  const me = useMe();
  const [payer, setPayer] = React.useState(ALL);
  const [status, setStatus] = React.useState<ClaimStatus | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const payerQ = payer === ALL ? undefined : payer;
  const payers = useApi("listPayers");
  const pipe = useApi(
    "getClaimPipeline",
    { query: { payerId: payerQ } },
    { refetchInterval: 60_000 },
  );
  const list = useApi("listClaims", {
    query: { status: status ? [status] : undefined, payerId: payerQ },
  });
  const buckets = new Map((pipe.data?.buckets ?? []).map((b) => [b.status, b]));
  const ready = buckets.get("READY")?.count ?? 0;
  const connected = me.connectedGateways.includes("ClearinghouseGateway");
  const rows = list.data?.data ?? [];
  const submit = useApiMutation("submitClaims", {
    invalidates: ["listClaims", "getClaimPipeline", "getClaim"],
    onSuccess: (job) => {
      setConfirm(false);
      const res = ((job.params as { results?: Outcome[] } | null)?.results ?? []) as Outcome[];
      if (!res.length) return toast("Submission queued.");
      const n = (o: string) => res.filter((r) => r.outcome === o).length;
      const parts = [
        n("submitted") && `${n("submitted")} submitted`,
        n("clean") && `${n("clean")} clean`,
        n("rejected") && `${n("rejected")} rejected`,
        n("blocked") && `${n("blocked")} blocked`,
        n("failed") && `${n("failed")} failed`,
      ].filter(Boolean);
      const bad = n("rejected") + n("blocked") + n("failed");
      (bad ? toast.error : toast)(`Claims: ${parts.join(", ")}.`);
    },
    onError: (e) => (setConfirm(false), toast.error(errorMessage(e))),
  });
  const btn = (
    <Button
      variant="primary"
      disabled={!connected || !ready || submit.isPending}
      onClick={() => setConfirm(true)}
      data-testid={tid(S, "cl-submit-ready")}
    >
      Submit {ready} ready now
    </Button>
  );
  const selected = v.view === "detail" ? v.id : null;
  return (
    <BillingLayout
      title="Claims"
      subtitle={
        <span data-testid={tid(S, "cl-summary")}>{pluralize(rows.length, "claim")} shown</span>
      }
      actions={
        <div className="flex items-center gap-2">
          <Select
            value={payer}
            onValueChange={setPayer}
            aria-label="Payer"
            testId={tid(S, "cl-payer")}
            options={[
              { value: ALL, label: "All payers" },
              ...(payers.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {connected ? (
            btn
          ) : (
            <Unavailable reason="No clearinghouse is connected. Claims stay ready until one is.">
              {btn}
            </Unavailable>
          )}
        </div>
      }
    >
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7"
        data-testid={tid(S, "cl-pipeline")}
      >
        {ORDER.map((s) => {
          const b = buckets.get(s);
          const on = status === s;
          return (
            <Pressable
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => setStatus(on ? null : s)}
              className={cn(
                "grid gap-1 bg-surface p-4 text-left hover:bg-surface-hover",
                on && "shadow-[inset_0_0_0_2px_var(--color-ink)]",
              )}
            >
              <span className="text-body text-ink-2">
                <StatusChip machine="claim" value={s} />
              </span>
              <b className="text-h2 tabular-nums">{b?.count ?? 0}</b>
              <span className="text-body tabular-nums">{money(b?.amount ?? "0")}</span>
            </Pressable>
          );
        })}
      </div>
      <div
        className={cn("grid items-start gap-6", selected && "xl:grid-cols-[minmax(0,1fr)_480px]")}
      >
        <Card data-testid={tid(S, "cl-table")}>
          {list.error ? (
            <div className="p-5">
              <Alert tone="caution">{errorMessage(list.error)}</Alert>
            </div>
          ) : null}
          {list.isLoading ? (
            <div className="p-5">
              <LoadingRows rows={5} />
            </div>
          ) : null}
          {!list.isLoading && !rows.length ? (
            <p className="p-5 text-body text-ink-2">No claims match.</p>
          ) : null}
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim</TableHead>
                  <TableHead>Patient · payer</TableHead>
                  <TableHead>DOS</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Billed</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c: ClaimSummary) => (
                  <TableRow key={c.id} data-state={selected === c.id ? "selected" : undefined}>
                    <TableCell className="tabular-nums">{c.number}</TableCell>
                    <TableCell>
                      <b className="font-semibold">{c.patient.name}</b>
                      <div className="text-small text-ink-2">{c.payerName}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatShortDate(c.dateOfService)}
                    </TableCell>
                    <TableCell>
                      <StatusChip machine="claim" value={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {money(c.billed)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="link"
                        onClick={() => v.open("detail", c.id)}
                        data-testid={tid(S, "cl-open")}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Card>
        {selected ? (
          <ClaimPane key={selected} claimId={selected} onClose={v.close} connected={connected} />
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Submit ${pluralize(ready, "ready claim")}?`}
        description="Claims are scrubbed, then sent to the clearinghouse. Blocked claims stay ready."
        action="Submit claims"
        disabled={submit.isPending}
        onConfirm={() => submit.mutate({ body: { ids: [] } })}
      />
    </BillingLayout>
  );
}

function ClaimPane({
  claimId,
  onClose,
  connected,
}: {
  claimId: string;
  onClose: () => void;
  connected: boolean;
}) {
  const q = useApi("getClaim", { params: { claimId } });
  const [closing, setClosing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const inv = {
    invalidates: ["getClaim" as const, "listClaims" as const, "getClaimPipeline" as const],
  };
  const check = useApiMutation("checkClaimStatus", {
    ...inv,
    onSuccess: () => toast("Status checked with the payer."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = useApiMutation("closeClaim", {
    ...inv,
    onSuccess: () => (toast("Claim closed."), setClosing(false), setReason("")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const c = q.data;
  const x12 = async () => {
    try {
      openBlob((await api("getClaimX12", { params: { claimId } })) as unknown as Blob);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const checkBtn = (
    <Button
      size="sm"
      disabled={!connected || check.isPending}
      onClick={() => check.mutate({ params: { claimId } })}
    >
      Check status
    </Button>
  );
  return (
    <Card data-testid={tid(S, "cl-detail")}>
      {q.isLoading ? <LoadingRows rows={4} /> : null}
      {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : null}
      {c ? (
        <div className="grid gap-4">
          <CardHeader
            className="mb-0"
            title={c.claimNumber}
            actions={
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip machine="claim" value={c.status} testId={tid(S, "cd-status")} />
            <DeadlineChip deadline={c.filingDeadline} testId={tid(S, "cd-deadline")} />
          </div>
          <p className="text-body tabular-nums text-ink-2">
            DOS {formatShortDate(c.serviceDateFrom)} · {money(c.totalBilled)} billed ·{" "}
            {money(c.totalPaid)} paid
          </p>
          {c.rejectionReason ? <Alert tone="caution">{c.rejectionReason}</Alert> : null}
          <div className="flex flex-wrap gap-4 text-body">
            <Link
              className="underline underline-offset-4 hover:text-pine-700"
              to={pathTo("billing.patient-account", { patientId: c.patientId })}
              data-testid={tid(S, "cd-account")}
            >
              Patient account
            </Link>
            {c.status === "REJECTED" ? (
              <Link
                className="underline underline-offset-4 hover:text-pine-700"
                to={pathTo("billing.rejections", {}, "detail", { id: c.id })}
                data-testid={tid(S, "cd-rejection")}
              >
                Fix rejection
              </Link>
            ) : null}
            {c.status === "DENIED" ? (
              <Link
                className="underline underline-offset-4 hover:text-pine-700"
                to={pathTo("billing.denials")}
                data-testid={tid(S, "cd-denial")}
              >
                Work denial
              </Link>
            ) : null}
          </div>
          <div data-testid={tid(S, "cd-lines")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Mod</TableHead>
                  <TableHead>Dx</TableHead>
                  <TableHead className="text-right">Charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-semibold tabular-nums">{l.code}</TableCell>
                    <TableCell>{l.modifiers.join(" ") || "—"}</TableCell>
                    <TableCell>{l.icd10Codes.join(", ") || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.charge)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <h4 className="mb-2 text-label text-ink-2">History</h4>
            <ClaimTimeline events={c.events} testId={tid(S, "cd-history")} />
          </div>
          <div className="flex flex-wrap gap-2">
            {c.status === "SUBMITTED" || c.status === "ACCEPTED" ? (
              connected ? (
                checkBtn
              ) : (
                <Unavailable reason="No clearinghouse is connected.">{checkBtn}</Unavailable>
              )
            ) : null}
            <Button size="sm" onClick={() => void x12()}>
              View X12
            </Button>
            {c.allowedTransitions.includes("CLOSED") ? (
              <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
                Close claim
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title={`Close ${c?.claimNumber ?? "claim"}?`}
        description="A closed claim is no longer worked. This can't be undone."
        action="Close claim"
        danger
        disabled={!reason.trim() || close.isPending}
        onConfirm={() => close.mutate({ params: { claimId }, body: { reason: reason.trim() } })}
      >
        <FieldShell label="Reason" htmlFor="cl-reason">
          <Textarea id="cl-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldShell>
      </ConfirmDialog>
    </Card>
  );
}
