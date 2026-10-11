import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { formatMoney, fromCents, type RemittanceDetail } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, pluralize } from "@/lib/format";
import { openBlob } from "@/lib/files";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { BillingLayout } from "@/features/billing/BillingLayout";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { eraSummary, eraStatusTag, linePresentation, plbClaimGuess, remitTotals } from "./eraMath";

const S = "billing.era-posting";
const INVALIDATES = ["listRemittances", "getRemittance", "listClaims"] as const;

type Line = RemittanceDetail["claimPayments"][number];
type Plb = RemittanceDetail["providerLevelAdjustments"][number];

/** Claims from this payer that can still receive a payment (match target / recoupment target). */
function useOpenClaims(payerId: string) {
  return useApi("listClaims", {
    query: {
      payerId,
      status: ["SUBMITTED", "ACCEPTED", "APPEALED"],
      limit: 200,
    },
  });
}

function ClaimPickDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  payerId,
  initial,
  busy,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  action: string;
  payerId: string;
  initial?: (claims: { id: string; number: string }[]) => string | undefined;
  busy?: boolean;
  onConfirm: (claimId: string) => void;
  testId?: string;
}) {
  const claims = useOpenClaims(payerId);
  const list = React.useMemo(() => claims.data?.data ?? [], [claims.data]);
  const [claimId, setClaimId] = React.useState("");
  React.useEffect(() => {
    if (open) setClaimId(initial?.(list) ?? "");
  }, [open, list]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {claims.error ? <Alert tone="caution">{errorMessage(claims.error)}</Alert> : null}
        <Select
          value={claimId}
          onValueChange={setClaimId}
          aria-label="Claim"
          placeholder={claims.isLoading ? "Loading claims" : "Choose a claim"}
          options={list.map((c) => ({
            value: c.id,
            label: `${c.number} · ${c.patient.name} · ${formatMoney(c.billed)}`,
          }))}
        />
        {!claims.isLoading && !list.length ? (
          <p className="text-small text-ink-2">No open claims from this payer.</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!claimId} loading={busy} onClick={() => onConfirm(claimId)}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  note,
  emphasis,
}: {
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid content-start gap-1 bg-surface-muted p-4",
        emphasis && "shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
      )}
    >
      <span className="text-label text-ink-2">{label}</span>
      <b className="text-h2 tabular-nums">{value}</b>
      {note ? <span className="text-body text-ink">{note}</span> : null}
    </div>
  );
}

function RemitPane({ id }: { id: string }) {
  const q = useApi("getRemittance", { params: { remittanceId: id } });
  const r = q.data;
  const summary = useApi("listRemittances", { query: {} });
  const payerName = summary.data?.data.find((s) => s.id === id)?.payerName ?? "Payer";
  const [matching, setMatching] = React.useState<Line | null>(null);
  const [posting, setPosting] = React.useState<Plb | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  const [finishError, setFinishError] = React.useState<string | null>(null);
  const opts = { invalidates: [...INVALIDATES] };
  const match = useApiMutation("matchRemittanceClaimPayment", {
    ...opts,
    onSuccess: () => (toast("Payment matched to claim."), setMatching(null)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const postPlb = useApiMutation("postProviderAdjustment", {
    ...opts,
    onSuccess: () => (toast("Recoupment posted."), setPosting(null)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const finish = useApiMutation("postRemittance", {
    ...opts,
    onSuccess: () => (toast("Remittance posted."), setFinishing(false), setFinishError(null)),
    onError: (e) => (setFinishing(false), setFinishError(errorMessage(e))),
  });
  const view835 = async () => {
    try {
      openBlob(
        (await api("getRemittanceX12", {
          params: { remittanceId: id },
        })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (q.isLoading)
    return (
      <Card>
        <LoadingRows rows={6} />
      </Card>
    );
  if (q.error || !r)
    return (
      <Card>
        <Alert tone="caution">{q.error ? errorMessage(q.error) : "Remittance not found."}</Alert>
      </Card>
    );

  const t = remitTotals(r);
  const posted = r.status === "POSTED";
  const plbs = r.providerLevelAdjustments.filter((p) => !p.postedToClaimId);
  const finishReason = posted
    ? "Already posted"
    : t.unmatched
      ? "Match every payment to a claim first"
      : !t.balanced
        ? "Balance first"
        : null;
  return (
    <Card data-testid={tid(S, "rm-header")} className="grid content-start gap-4">
      <CardHeader
        title={`${payerName} · EFT ${r.eftTraceNumber} · received ${formatShortDate(r.receivedAt)}`}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void view835()}
              data-testid={tid(S, "rm-view-835")}
            >
              View 835
            </Button>
            <Tag tone="outline">Deposit not matched</Tag>
          </>
        }
        className="mb-0"
      />
      <div className="grid gap-3 sm:grid-cols-3" data-testid={tid(S, "rm-balance")}>
        <Stat label="Payment" value={formatMoney(r.paymentAmount)} />
        <Stat label="Posted to claims" value={formatMoney(fromCents(t.postedCents))} />
        <Stat
          label="Difference"
          value={formatMoney(fromCents(t.diffCents))}
          note={t.balanced ? "Balanced" : plbs.length ? "Provider-level adjustment" : undefined}
          emphasis={!t.balanced}
        />
      </div>

      {plbs.map((p) => (
        <Alert
          key={p.id}
          tone="caution"
          testId={tid(S, "rm-plb")}
          title={`${payerName} took back ${formatMoney(p.amount)}${p.reasonCode === "WO" ? " for an earlier overpayment" : ""}.`}
          action={
            <Button onClick={() => setPosting(p)} data-testid={tid(S, "rm-post-plb")}>
              Post recoupment
            </Button>
          }
        >
          <span className="text-small">
            (PLB · {p.reasonCode}
            {p.reference ? ` · claim ${p.reference}` : ""}). Post it to that claim to balance.
          </span>
        </Alert>
      ))}

      <Table data-testid={tid(S, "rm-lines")}>
        <TableHeader>
          <TableRow>
            <TableHead>Claim</TableHead>
            <TableHead>Patient</TableHead>
            <TableHead numeric>Billed</TableHead>
            <TableHead numeric>Allowed</TableHead>
            <TableHead numeric>Paid</TableHead>
            <TableHead numeric>Contract adj.</TableHead>
            <TableHead numeric>Patient owes</TableHead>
            <TableHead numeric>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {r.claimPayments.map((l) => {
            const p = linePresentation(l);
            return (
              <TableRow key={l.payment.id} data-testid={tid(S, "rm-line")}>
                <TableCell>
                  {l.claim ? (
                    <Link
                      className="underline underline-offset-4 hover:text-pine-700"
                      to={pathTo("billing.claims", {}, "detail", {
                        id: l.claim.id,
                      })}
                      data-testid={tid(S, "rml-claim")}
                    >
                      {l.claim.number}
                    </Link>
                  ) : (
                    <span className="tabular-nums">{l.payment.patientControlNumber}</span>
                  )}
                </TableCell>
                <TableCell>{l.claim?.patient.name ?? "—"}</TableCell>
                <TableCell numeric>{formatMoney(l.payment.billed)}</TableCell>
                <TableCell numeric>
                  {l.payment.allowed ? formatMoney(l.payment.allowed) : "—"}
                </TableCell>
                <TableCell numeric>{formatMoney(l.payment.paid)}</TableCell>
                <TableCell numeric>
                  {p.contractCents ? formatMoney(fromCents(p.contractCents)) : "—"}
                  {p.contractCodes ? (
                    <span className="ml-1 text-small font-normal text-ink-2">
                      {p.contractCodes}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell numeric>
                  {p.patientCents ? formatMoney(fromCents(p.patientCents)) : "—"}
                  {p.patientCodes ? (
                    <span className="ml-1 text-small font-normal text-ink-2">{p.patientCodes}</span>
                  ) : null}
                </TableCell>
                <TableCell numeric>
                  <div className="grid justify-items-end gap-1">
                    {p.kind === "denied" ? (
                      <Tag tone="caution" data-testid={tid(S, "rml-denied")}>
                        Denied
                      </Tag>
                    ) : p.kind === "underpaid" ? (
                      <Tag tone="caution" data-testid={tid(S, "rml-underpaid")}>
                        Underpaid
                      </Tag>
                    ) : p.kind === "unmatched" ? (
                      <Tag tone="caution">Unmatched</Tag>
                    ) : (
                      <Tag tone="neutral">{l.payment.posted ? "Posted" : "Not posted"}</Tag>
                    )}
                    {p.note ? (
                      <span className="text-small font-normal text-ink-2">{p.note}</span>
                    ) : null}
                    {p.kind === "unmatched" && !posted ? (
                      <Button size="sm" onClick={() => setMatching(l)}>
                        Match to claim
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {finishError ? <Alert tone="caution">{finishError}</Alert> : null}
      <div className="flex items-center justify-between gap-4">
        <p className="text-small text-ink-2">
          Denied and underpaid lines go to the denials worklist when you finish.
        </p>
        {finishReason ? (
          <Unavailable reason={finishReason} testId={tid(S, "rm-finish")}>
            <Button disabled>
              Finish remit
              {posted
                ? ""
                : ` · ${finishReason.toLowerCase().startsWith("match") ? "match first" : "balance first"}`}
            </Button>
          </Unavailable>
        ) : (
          <Button
            variant="primary"
            onClick={() => setFinishing(true)}
            data-testid={tid(S, "rm-finish")}
          >
            Finish remit
          </Button>
        )}
      </div>

      <ClaimPickDialog
        open={!!matching}
        onOpenChange={(o) => !o && setMatching(null)}
        title="Match to claim"
        description={`Choose the claim that payment ${matching?.payment.patientControlNumber ?? ""} belongs to.`}
        action="Match"
        payerId={r.payerId}
        busy={match.isPending}
        onConfirm={(claimId) =>
          matching &&
          match.mutate({
            params: { remittanceClaimPaymentId: matching.payment.id },
            body: { claimId },
          })
        }
      />
      <ClaimPickDialog
        open={!!posting}
        onOpenChange={(o) => !o && setPosting(null)}
        title="Post recoupment"
        description={`Post the ${formatMoney(posting?.amount)} recoupment to the claim it was taken back from${posting?.reference ? ` (${posting.reference})` : ""}.`}
        action="Post recoupment"
        payerId={r.payerId}
        initial={(cs) => plbClaimGuess(cs, posting?.reference)}
        busy={postPlb.isPending}
        testId={tid(S, "rm-post-plb-dialog")}
        onConfirm={(claimId) =>
          posting &&
          postPlb.mutate({
            params: { providerLevelAdjustmentId: posting.id },
            body: { claimId },
          })
        }
      />
      <ConfirmDialog
        open={finishing}
        onOpenChange={setFinishing}
        title={`Finish ${payerName} remit?`}
        description="Payments post to claim ledgers and denied or underpaid lines go to the denials worklist."
        action="Finish remit"
        onConfirm={() => finish.mutate({ params: { remittanceId: id } })}
      />
    </Card>
  );
}

/** billing.era-posting: remittance list and the balance-and-post pane (flow rcm/06). */
export function EraPostingPage() {
  const v = useView();
  const list = useApi("listRemittances", { query: {} }, { refetchInterval: 60_000 });
  const items = list.data?.data ?? [];
  const selectedId =
    v.view === "remit" ? v.id : (items.find((i) => i.status === "EXCEPTION") ?? items[0])?.id;
  return (
    <BillingLayout title="ERA posting" subtitle={eraSummary(items)}>
      {list.error ? <Alert tone="caution">{errorMessage(list.error)}</Alert> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="p-0" data-testid={tid(S, "era-list")}>
          <h2 className="px-4 pb-2 pt-4 text-h3">{pluralize(items.length, "remittance")}</h2>
          {list.isLoading ? (
            <div className="p-4">
              <LoadingRows rows={4} />
            </div>
          ) : null}
          {!list.isLoading && !items.length ? (
            <p className="px-4 pb-4 text-body text-ink-2">No remittances yet.</p>
          ) : null}
          <ul>
            {items.map((r) => {
              const tag = eraStatusTag(r);
              return (
                <li
                  key={r.id}
                  className={cn("hover:bg-surface-hover", selectedId === r.id && "bg-pine-50")}
                >
                  <Pressable
                    type="button"
                    onClick={() => v.open("remit", r.id)}
                    className="grid w-full gap-0.5 px-4 py-3 text-left"
                    data-testid={tid(S, "era-row")}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <b className="truncate font-semibold">{r.payerName}</b>
                      <Tag tone={tag.tone}>{tag.label}</Tag>
                    </span>
                    <span className="text-small text-ink-2">
                      EFT {r.checkNumber} · {formatMoney(r.amount)}
                    </span>
                    <span className="text-small text-ink-2">
                      {pluralize(r.claims, "claim")}
                      {r.exceptions ? ` · ${r.exceptions} need review` : ""}
                    </span>
                  </Pressable>
                </li>
              );
            })}
          </ul>
        </Card>
        {selectedId ? (
          <RemitPane id={selectedId} key={selectedId} />
        ) : (
          <Card>
            <p className="text-body text-ink-2">Choose a remittance.</p>
          </Card>
        )}
      </div>
    </BillingLayout>
  );
}
