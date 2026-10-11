import * as React from "react";
import { toast } from "sonner";
import {
  formatMoney,
  fromCents,
  toCents,
  type DenialAction,
  type OperationId,
} from "@agile-emr/shared";
import { useMe } from "@/app/auth";
import { tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { BillingLayout } from "@/features/billing/BillingLayout";
import { StatusChip } from "@/components/domain/StatusChip";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, LoadingRows } from "@/components/ui/layout";
import { Pressable } from "@/components/ui/pressable";
import { Checkbox, RadioGroup, Select } from "@/components/ui/select";
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
import { deadlineChip } from "./denialDeadline";

const S = "billing.denials";
const REFRESH: OperationId[] = [
  "listDenials",
  "getDenial",
  "getDenialGroups",
  "listClaims",
  "getClaim",
];
const WRITE_OFF_LIMIT = 10_000; // cents; the API enforces it, this only warns up front.

const SORTS = [
  { value: "deadline", label: "Sort: deadline" },
  { value: "amount", label: "Sort: amount" },
  { value: "age", label: "Sort: age" },
];
const VIA = [
  { value: "portal", label: "Payer portal" },
  { value: "fax", label: "Fax" },
  { value: "mail", label: "Mail" },
  { value: "edi", label: "EDI" },
];
const ACTIONS: { value: DenialAction; label: string; hint: string }[] = [
  {
    value: "APPEAL",
    label: "Appeal",
    hint: "When you believe the denial is wrong.",
  },
  {
    value: "CORRECTED_CLAIM",
    label: "Corrected claim",
    hint: "If a code, modifier or place of service was wrong.",
  },
  {
    value: "WRITE_OFF",
    label: "Write off",
    hint: "Needs manager approval over $100.",
  },
];

const carcCode = (c: string) => c.replace(/^[A-Z]{2}-/, "");

function DeadlineChip({ iso }: { iso?: string | null }) {
  const c = deadlineChip(iso);
  return (
    <Tag tone={c.tone} data-testid={tid(S, "dn-deadline")}>
      {c.label}
    </Tag>
  );
}

function WorkPane({ id, onClose }: { id: string; onClose: () => void }) {
  const { role } = useMe();
  const q = useApi("getDenial", { params: { denialId: id } });
  const d = q.data;
  const reason = useApi(
    "searchAdjustmentCodes",
    { query: { q: d ? carcCode(d.carc) : "", system: "CARC" } },
    { enabled: !!d },
  );
  const [action, setAction] = React.useState<DenialAction | null>(null);
  const [letter, setLetter] = React.useState("");
  const [attachments, setAttachments] = React.useState<string[]>([]);
  const [via, setVia] = React.useState<"portal" | "fax" | "mail" | "edi">("portal");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [why, setWhy] = React.useState("");
  const [confirm, setConfirm] = React.useState<
    null | "appeal" | "corrected" | "writeoff" | "snooze"
  >(null);
  const [approval, setApproval] = React.useState(false);

  React.useEffect(() => {
    if (!d) return;
    setAction((a) => a ?? d.suggestedAction ?? "APPEAL");
    setAmount((a) => a || d.amount);
  }, [d]);

  const done = (msg: string) => {
    toast(msg);
    setConfirm(null);
    onClose();
  };
  const opts = { invalidates: REFRESH };
  const draft = useApiMutation("draftAppealLetter", {
    onSuccess: (r) => (setLetter(r.text), setAttachments(r.attachmentsSuggested)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const appeal = useApiMutation("submitAppeal", {
    ...opts,
    onSuccess: () => done("Appeal sent."),
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(e));
    },
  });
  const update = useApiMutation("updateClaim");
  const resubmit = useApiMutation("resubmitClaim", {
    ...opts,
    onSuccess: () => done("Corrected claim submitted."),
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(e));
    },
  });
  const writeOff = useApiMutation("writeOffDenial", {
    ...opts,
    onSuccess: () => done("Denial written off."),
    onError: (e) => {
      setConfirm(null);
      if (e instanceof ApiError && e.code === "write_off_needs_approval") setApproval(true);
      else toast.error(errorMessage(e));
    },
  });
  const snooze = useApiMutation("snoozeDenial", {
    ...opts,
    onSuccess: () => done("Denial snoozed for 7 days."),
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(e));
    },
  });

  if (q.isLoading)
    return (
      <Card>
        <LoadingRows rows={6} />
      </Card>
    );
  if (q.error || !d)
    return (
      <Card>
        <Alert tone="caution">{q.error ? errorMessage(q.error) : "Denial not found."}</Alert>
      </Card>
    );

  const hit = reason.data?.find((h) => h.code === carcCode(d.carc)) ?? reason.data?.[0];
  const cents = toCents(amount);
  const needsApproval = approval || (role !== "manager" && cents > WRITE_OFF_LIMIT);
  const claim = d.claim;
  const open = d.status === "OPEN";
  const submitCorrected = async () => {
    try {
      await update.mutateAsync({
        params: { claimId: claim.id },
        version: claim.version,
        body: {
          frequencyCode: "7",
          changes: {},
          reason: why.trim(),
          version: claim.version,
        },
      });
      resubmit.mutate({ params: { claimId: claim.id } });
    } catch (e) {
      setConfirm(null);
      toast.error(errorMessage(e));
    }
  };

  return (
    <Card className="grid content-start gap-4" data-testid={tid(S, "work")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-h3">Claim {claim.claimNumber}</h3>
        <StatusChip machine="claim" value={claim.status} />
      </div>
      <p className="text-body" data-testid={tid(S, "wk-reason")}>
        {hit ? hit.display : "Reason not available."}{" "}
        <span className="text-ink-2">
          {d.carc}
          {d.rarc.length ? ` · RARC ${d.rarc.join(", ")}` : ""}
        </span>
      </p>
      <div className="flex items-center gap-2 text-body">
        <DeadlineChip iso={d.appealDeadline} />
        <span className="text-ink-2">Appeal by {formatShortDate(d.appealDeadline)}</span>
      </div>

      {!open ? <Alert>This denial is {d.status.toLowerCase().replace("_", " ")}.</Alert> : null}

      <RadioGroup
        orientation="vertical"
        aria-label="Action"
        testId={tid(S, "wk-action")}
        value={action ?? undefined}
        onValueChange={setAction}
        options={ACTIONS.map((a) => ({
          value: a.value,
          label: (
            <span className="grid">
              <b className="font-semibold">{a.label}</b>
              <span className="text-small text-ink-2">{a.hint}</span>
            </span>
          ),
        }))}
      />

      {action === "APPEAL" ? (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-label">Appeal letter</span>
            <Button
              size="sm"
              loading={draft.isPending}
              onClick={() =>
                draft.mutate({
                  params: { denialId: id },
                  body: { denialId: id, level: 1 },
                })
              }
            >
              {letter ? "Redraft letter" : "Draft letter"}
            </Button>
          </div>
          <Textarea
            aria-label="Appeal letter"
            rows={10}
            value={letter}
            onChange={(e) => setLetter(e.target.value)}
            placeholder="Draft the letter from the payer template, then edit it here."
            data-testid={tid(S, "wk-letter")}
          />
          <div className="grid gap-2" data-testid={tid(S, "wk-attach")}>
            <span className="text-label">Attach</span>
            {(attachments.length
              ? attachments
              : ["Visit summary", "Eligibility response", "Full visit note"]
            ).map((a) => (
              <Unavailable
                key={a}
                reason={
                  /note/i.test(a)
                    ? "File attachments arrive with documents in a later release, and the full note also needs provider release."
                    : "File attachments arrive with documents in a later release."
                }
              >
                <Checkbox disabled label={a} />
              </Unavailable>
            ))}
          </div>
          <Select
            value={via}
            onValueChange={(x) => setVia(x as typeof via)}
            options={VIA}
            aria-label="Send via"
          />
        </div>
      ) : null}

      {action === "CORRECTED_CLAIM" ? (
        <div className="grid gap-2">
          <span className="text-label">What was corrected</span>
          <Textarea
            aria-label="Reason for correction"
            rows={3}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Example: place of service changed to 11."
          />
          <p className="text-small text-ink-2">
            Sends a replacement claim (frequency 7). Edit codes or modifiers on the claim before
            submitting.
          </p>
        </div>
      ) : null}

      {action === "WRITE_OFF" ? (
        <div className="grid gap-2">
          <span className="text-label">Amount to write off</span>
          <Input
            aria-label="Write-off amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Input
            aria-label="Note"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {needsApproval ? (
            <Alert
              tone="caution"
              title="Needs manager approval."
              testId={tid(S, "wk-writeoff-approval")}
            >
              Write-offs over $100 must be approved by a manager.
            </Alert>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          disabled={!open}
          onClick={() => setConfirm("snooze")}
          data-testid={tid(S, "wk-snooze")}
        >
          Snooze 7 days
        </Button>
        {action === "APPEAL" ? (
          <Button
            variant="primary"
            disabled={!open || !letter.trim()}
            onClick={() => setConfirm("appeal")}
            data-testid={tid(S, "wk-send")}
          >
            Send appeal
          </Button>
        ) : action === "CORRECTED_CLAIM" ? (
          <Button
            variant="primary"
            disabled={!open || !why.trim()}
            onClick={() => setConfirm("corrected")}
            data-testid={tid(S, "wk-corrected")}
          >
            Submit corrected claim
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!open || cents <= 0 || needsApproval}
            onClick={() => setConfirm("writeoff")}
          >
            Write off
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "appeal"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Send appeal?"
        description={`The letter goes to the payer via ${VIA.find((v) => v.value === via)?.label.toLowerCase()}.`}
        action="Send appeal"
        onConfirm={() =>
          appeal.mutate({
            params: { denialId: id },
            body: {
              level: 1,
              letter,
              attachmentFileIds: [],
              submittedVia: via,
            },
          })
        }
      />
      <ConfirmDialog
        open={confirm === "corrected"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Submit corrected claim?"
        description={`A replacement for ${claim.claimNumber} goes to the payer.`}
        action="Submit corrected claim"
        onConfirm={() => void submitCorrected()}
      />
      <ConfirmDialog
        open={confirm === "writeoff"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Write off this denial?"
        description={`${formatMoney(fromCents(cents))} is removed from the claim balance and cannot be billed again.`}
        action="Write off"
        danger
        onConfirm={() =>
          writeOff.mutate({
            params: { denialId: id },
            body: {
              amount: fromCents(cents),
              reasonCode: carcCode(d.carc),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          })
        }
      />
      <ConfirmDialog
        open={confirm === "snooze"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Snooze this denial?"
        description="It leaves the open list for 7 days. The appeal deadline does not change."
        action="Snooze"
        onConfirm={() =>
          snooze.mutate({
            params: { denialId: id },
            body: {
              until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            },
          })
        }
      />
    </Card>
  );
}

/** billing.denials: root-cause groups, worklist with appeal-deadline chips, and the work pane (flow rcm/07). */
export function DenialsPage() {
  const v = useView();
  const [cause, setCause] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<"deadline" | "amount" | "age">("deadline");
  const all = useApi("listDenials", { query: {} });
  const groups = useApi("getDenialGroups");
  const list = useApi("listDenials", {
    query: { sort, ...(cause ? { rootCause: cause } : {}) },
  });
  const rows = list.data?.data ?? [];
  const everything = all.data?.data ?? [];
  const risk = everything.reduce((s, r) => s + toCents(r.amount), 0);
  const near = everything.filter((r) => (deadlineChip(r.appealDeadline).days ?? 99) < 30).length;
  const workId = v.view === "work" ? v.id : null;
  return (
    <BillingLayout
      title="Denials & underpayments"
      subtitle={`${everything.length} open · ${formatMoney(fromCents(risk))} at risk · ${near} with deadline under 30 days`}
      actions={
        <Select
          value={sort}
          onValueChange={(x) => setSort(x as typeof sort)}
          options={SORTS}
          aria-label="Sort"
          testId={tid(S, "dn-sort")}
          className="w-48"
        />
      }
    >
      {list.error ? <Alert tone="caution">{errorMessage(list.error)}</Alert> : null}
      <div className="flex flex-wrap gap-3">
        {(groups.data ?? [])
          .filter((g) => g.count > 0)
          .map((g) => (
            <Pressable
              key={g.key}
              type="button"
              onClick={() => setCause(cause === g.key ? null : g.key)}
              aria-pressed={cause === g.key}
              data-testid={tid(S, "dn-cause")}
              className={cn(
                "grid min-w-48 gap-1 bg-surface p-4 text-left hover:bg-surface-hover",
                cause === g.key && "shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
              )}
            >
              <span className="text-small text-ink-2">{g.label}</span>
              <b className="text-h3 tabular-nums">
                {g.count} · {formatMoney(g.amount)}
              </b>
            </Pressable>
          ))}
      </div>
      <div className={cn("grid items-start gap-6", workId && "xl:grid-cols-[1fr_440px]")}>
        <Card className="p-0">
          {list.isLoading ? (
            <div className="p-6">
              <LoadingRows rows={5} />
            </div>
          ) : null}
          {!list.isLoading && !rows.length ? (
            <p className="p-6 text-body text-ink-2">No open denials.</p>
          ) : null}
          {rows.length ? (
            <Table data-testid={tid(S, "dn-table")}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Patient · claim</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead>DOS</TableHead>
                  <TableHead numeric>Amount</TableHead>
                  <TableHead>Appeal by</TableHead>
                  <TableHead className="pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.denial.id}
                    data-state={workId === r.denial.id ? "selected" : undefined}
                  >
                    <TableCell className="pl-6">
                      <b className="font-semibold">{r.claim.patient.name}</b>
                      <div className="text-small text-ink-2">
                        {r.claim.number} · {r.carc}
                      </div>
                    </TableCell>
                    <TableCell>{r.claim.payerName}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatShortDate(r.claim.dateOfService)}
                    </TableCell>
                    <TableCell numeric>{formatMoney(r.amount)}</TableCell>
                    <TableCell>
                      <DeadlineChip iso={r.appealDeadline ?? r.denial.appealDeadline} />
                    </TableCell>
                    <TableCell className="pr-6">
                      <Button
                        size="sm"
                        onClick={() => v.open("work", r.denial.id)}
                        data-testid={tid(S, "dn-open")}
                      >
                        Work
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Card>
        {workId ? <WorkPane id={workId} key={workId} onClose={v.close} /> : null}
      </div>
    </BillingLayout>
  );
}
