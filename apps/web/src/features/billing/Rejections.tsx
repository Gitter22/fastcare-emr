import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { ClaimDetail, RejectionRow } from "@agile-emr/shared";
import { useMe } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, money, pluralize } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/domain/StatusChip";
import { BillingLayout } from "@/features/billing/BillingLayout";
import { ClaimTimeline, DeadlineChip } from "@/features/billing/claimParts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Pressable } from "@/components/ui/pressable";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";

const S = "billing.rejections";

type Changes = {
  placeOfService?: string;
  priorAuthNumber?: string;
  renderingProviderNpi?: string;
  billingProviderNpi?: string;
  coverageId?: string;
};

/** Which correction inputs the rejected field calls for. */
function kindOf(
  field: string | null | undefined,
): "coverage" | "rendering" | "billing" | "pos" | "auth" | "other" {
  const f = (field ?? "").toLowerCase();
  if (/coverage|member|subscriber|payer|insur/.test(f)) return "coverage";
  if (/rendering/.test(f)) return "rendering";
  if (/billing|npi|tin/.test(f)) return "billing";
  if (/place|pos|facility/.test(f)) return "pos";
  if (/auth/.test(f)) return "auth";
  return "other";
}

/** billing.rejections: rejected claims with plain-language reasons and an inline correction (flow rcm/04-05). */
export function RejectionsPage() {
  const v = useView();
  const q = useApi("listRejections", { query: {} }, { refetchInterval: 60_000 });
  const rows = q.data?.data ?? [];
  const selected = rows.find((r) => r.claim.id === v.id) ?? rows[0] ?? null;
  return (
    <BillingLayout
      title="Rejections"
      subtitle={`${pluralize(rows.length, "rejected claim")}, oldest filing deadline first.`}
    >
      {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_520px]">
        <Card className="p-0" data-testid={tid(S, "rj-table")}>
          {q.isLoading ? (
            <div className="p-5">
              <LoadingRows rows={4} />
            </div>
          ) : null}
          {!q.isLoading && !rows.length ? (
            <p className="p-5 text-body text-ink-2">No claims are rejected.</p>
          ) : null}
          <ul>
            {rows.map((r) => (
              <RejectionItem
                key={r.claim.id}
                row={r}
                on={selected?.claim.id === r.claim.id}
                onOpen={() => v.open("detail", r.claim.id)}
              />
            ))}
          </ul>
        </Card>
        {selected ? <RejectionDetail key={selected.claim.id} row={selected} /> : <span />}
      </div>
    </BillingLayout>
  );
}

function RejectionItem({
  row,
  on,
  onOpen,
}: {
  row: RejectionRow;
  on: boolean;
  onOpen: () => void;
}) {
  const c = row.claim;
  return (
    <li className={cn("hover:bg-surface-hover", on && "bg-pine-50")}>
      <Pressable type="button" onClick={onOpen} className="grid w-full gap-0.5 px-5 py-3 text-left">
        <span className="flex items-center justify-between gap-2">
          <b className="font-semibold">{c.patient.name}</b>
          <span className="tabular-nums font-medium">{money(c.billed)}</span>
        </span>
        <span className="text-small tabular-nums text-ink-2">
          {c.number} · {c.payerName} · DOS {formatShortDate(c.dateOfService)}
        </span>
        <span className="text-body">{row.text}</span>
        <span className="flex items-center gap-2 text-small text-ink-2">
          <Tag tone="outline">{row.source}</Tag>
          <DeadlineChip deadline={row.filingDeadline} />
        </span>
      </Pressable>
    </li>
  );
}

function RejectionDetail({ row }: { row: RejectionRow }) {
  const me = useMe();
  const q = useApi("getClaim", { params: { claimId: row.claim.id } });
  const c = q.data;
  if (q.isLoading)
    return (
      <Card>
        <LoadingRows rows={4} />
      </Card>
    );
  if (q.error || !c)
    return (
      <Card>
        <Alert tone="caution">{q.error ? errorMessage(q.error) : "Not found."}</Alert>
      </Card>
    );
  return (
    <DetailBody row={row} c={c} connected={me.connectedGateways.includes("ClearinghouseGateway")} />
  );
}

function DetailBody({
  row,
  c,
  connected,
}: {
  row: RejectionRow;
  c: ClaimDetail;
  connected: boolean;
}) {
  const kind = kindOf(c.rejectionField);
  const [changes, setChanges] = React.useState<Changes>({});
  const [reason, setReason] = React.useState("");
  const [selfPay, setSelfPay] = React.useState(false);
  const [spReason, setSpReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const coverages = useApi("listCoverages", { params: { patientId: c.patientId } });
  const inv = {
    invalidates: [
      "getClaim" as const,
      "listRejections" as const,
      "listClaims" as const,
      "getClaimPipeline" as const,
    ],
  };
  const update = useApiMutation("updateClaim", {
    ...inv,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resubmit = useApiMutation("resubmitClaim", {
    ...inv,
    onSuccess: () => toast("Claim corrected and resubmitted."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const bill = useApiMutation("transferClaimToPatient", {
    ...inv,
    onSuccess: () => (toast("Moved to patient responsibility."), setSelfPay(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const verify = useApiMutation("checkEligibility", {
    onSuccess: (r) => toast(`Eligibility ${r.status.toLowerCase()}.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const covId = changes.coverageId ?? c.coverageId;
  const set = (k: keyof Changes, val: string, orig?: string | null) =>
    setChanges((p) => {
      const n = { ...p };
      if (val === (orig ?? "")) delete n[k];
      else n[k] = val;
      return n;
    });
  const submit = async () => {
    setBusy(true);
    try {
      if (Object.keys(changes).length) {
        await update.mutateAsync({
          params: { claimId: c.id },
          body: { frequencyCode: "1", changes, reason: reason.trim(), version: c.version },
          version: c.version,
        });
      }
      await resubmit.mutateAsync({ params: { claimId: c.id } });
    } catch {
      /* toasts raised by the mutations */
    } finally {
      setBusy(false);
    }
  };
  const resubmitBtn = (
    <Button
      variant="primary"
      disabled={!connected || busy || (Object.keys(changes).length > 0 && !reason.trim())}
      onClick={() => void submit()}
      data-testid={tid(S, "rj-resubmit")}
    >
      Correct &amp; resubmit
    </Button>
  );
  const covOptions = (coverages.data ?? []).map((cv) => ({
    value: cv.id,
    label: `${cv.payer.name} · ${cv.memberId}${cv.periodEnd ? ` · ended ${formatShortDate(cv.periodEnd)}` : ""}`,
  }));
  const text = (label: string, key: keyof Changes, orig?: string | null) => (
    <FieldShell label={label} htmlFor={`rj-${key}`}>
      <Input
        id={`rj-${key}`}
        value={changes[key] ?? orig ?? ""}
        onChange={(e) => set(key, e.target.value, orig)}
      />
    </FieldShell>
  );
  return (
    <Card data-testid={tid(S, "rj-detail")}>
      <div className="grid gap-4">
        <CardHeader
          className="mb-0"
          title={c.claimNumber}
          actions={
            <>
              <StatusChip machine="claim" value={c.status} />
              <DeadlineChip deadline={c.filingDeadline} />
            </>
          }
        />
        <p className="text-body tabular-nums text-ink-2">
          {row.claim.patient.name} · {row.claim.payerName} · DOS{" "}
          {formatShortDate(c.serviceDateFrom)} · {c.lines.map((l) => l.code).join(", ")} ·{" "}
          {money(c.totalBilled)}
        </p>
        <div className="grid gap-2 border-2 border-ink p-4" data-testid={tid(S, "rj-reason")}>
          <b className="text-body-lg font-semibold">{c.rejectionReason ?? row.text}</b>
          <code className="bg-surface-muted px-3 py-2 text-small">
            {row.source} · {row.code} · {row.text}
          </code>
        </div>
        <div className="grid gap-3" data-testid={tid(S, "rj-field")}>
          {kind === "coverage" ? (
            <FieldShell label="Fix: coverage on this claim" htmlFor="rj-coverage">
              <Select
                id="rj-coverage"
                value={covId}
                onValueChange={(val) => set("coverageId", val, c.coverageId)}
                options={covOptions}
              />
            </FieldShell>
          ) : null}
          {kind === "rendering" || kind === "other"
            ? text("Rendering provider NPI", "renderingProviderNpi", c.renderingProviderNpi)
            : null}
          {kind === "billing" || kind === "other"
            ? text("Billing provider NPI", "billingProviderNpi", c.billingProviderNpi)
            : null}
          {kind === "pos" || kind === "other"
            ? text("Place of service", "placeOfService", c.placeOfService)
            : null}
          {kind === "auth" || kind === "other"
            ? text("Prior authorization number", "priorAuthNumber", c.priorAuthNumber)
            : null}
          {c.rejectionField ? (
            <p className="text-small text-ink-2">Rejected field: {c.rejectionField}</p>
          ) : null}
          {Object.keys(changes).length ? (
            <FieldShell label="Reason for the correction" htmlFor="rj-reason-text">
              <Input
                id="rj-reason-text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FieldShell>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={verify.isPending || !covId}
            onClick={() => verify.mutate({ params: { coverageId: covId }, body: {} })}
            data-testid={tid(S, "rj-verify")}
          >
            Verify eligibility
          </Button>
          <Link
            className="text-body underline underline-offset-4 hover:text-pine-700"
            to={pathTo("chart.demographics", { patientId: c.patientId }, "coverage")}
            data-testid={tid(S, "rj-open-coverage")}
          >
            Open patient insurance
          </Link>
        </div>
        <div>
          <h4 className="mb-2 text-label text-ink-2">History</h4>
          <ClaimTimeline events={c.events} testId={tid(S, "rj-history")} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => setSelfPay(true)}
            data-testid={tid(S, "rj-self-pay")}
          >
            Bill patient instead
          </Button>
          {connected ? (
            resubmitBtn
          ) : (
            <Unavailable reason="No clearinghouse is connected. Corrections save once one is.">
              {resubmitBtn}
            </Unavailable>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={selfPay}
        onOpenChange={setSelfPay}
        title={`Bill ${row.claim.patient.name} for ${c.claimNumber}?`}
        description="The balance moves to patient responsibility and the claim stops being worked with the payer."
        action="Bill patient"
        disabled={!spReason.trim() || bill.isPending}
        onConfirm={() =>
          bill.mutate({ params: { claimId: c.id }, body: { reason: spReason.trim() } })
        }
      >
        <FieldShell label="Reason" htmlFor="rj-sp-reason">
          <Textarea
            id="rj-sp-reason"
            value={spReason}
            onChange={(e) => setSpReason(e.target.value)}
          />
        </FieldShell>
      </ConfirmDialog>
    </Card>
  );
}
