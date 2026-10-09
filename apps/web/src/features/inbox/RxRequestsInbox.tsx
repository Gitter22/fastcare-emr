import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { DurAlert, RxRequestView } from "@agile-emr/shared";
import { useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDate, formatDateTime, formatShortDate, pluralize } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/domain/StatusChip";
import { DurAlertDialog } from "@/features/encounter/rx/DurAlertDialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";
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
import { Pressable } from "@/components/ui/pressable";
import { InboxLayout } from "./InboxLayout";

const S = "inbox.rx-requests";

const TYPE_LABEL: Record<string, string> = {
  RENEWAL: "Renewal",
  CHANGE: "Change",
  CANCEL_RESPONSE: "Cancel response",
  PORTAL_REFILL: "Portal refill",
};

const DENY_REASONS = [
  "Patient needs an appointment",
  "Medication discontinued",
  "Prescribed by another provider",
  "New prescription to follow",
];
const OTHER = "__other";

const FILTERS = [
  { value: "open", label: "Open" },
  { value: "pended-to-provider", label: "Pended to provider" },
  { value: "completed", label: "Completed" },
];

const asText = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

type Blocker = { code?: string; text?: string; message?: string };
const blockerText = (e: unknown): string | null => {
  if (!(e instanceof ApiError)) return null;
  const bl = (e.problem.blockers ?? []) as Blocker[];
  return bl.length ? bl.map((b) => b.text ?? b.message ?? b.code).join(" ") : null;
};

/** Protocol result chip: pass/fail with the reason on hover-free text beside it. */
function ProtocolTag({ r }: { r: RxRequestView }) {
  if (r.protocolMet === undefined) return <Tag tone="outline">Not run</Tag>;
  return r.protocolMet ? (
    <Tag tone="active">Protocol met</Tag>
  ) : (
    <Tag tone="caution">Protocol not met</Tag>
  );
}

/** inbox.rx-requests: pharmacy renewal/change requests and portal refills (flow refills 03-04). */
export function RxRequestsInboxPage() {
  const v = useView();
  const [filter, setFilter] = React.useState("open");
  const list = useApi(
    "listRxRequests",
    { query: { status: [filter] } },
    {
      refetchInterval: 60_000,
    },
  );
  const items = list.data?.data ?? [];
  const selected = items.find((i) => i.id === v.id) ?? items[0] ?? null;
  return (
    <InboxLayout>
      <Card className="p-0" data-testid={tid(S, "rr-type")}>
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-5">
          <h2 className="text-h3">{pluralize(items.length, "request")}</h2>
        </div>
        <div className="px-5 pb-3">
          <Select
            value={filter}
            onValueChange={setFilter}
            options={FILTERS}
            aria-label="Request status"
          />
        </div>
        {list.error ? (
          <div className="px-5 pb-3">
            <Alert tone="caution">{errorMessage(list.error)}</Alert>
          </div>
        ) : null}
        {list.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!list.isLoading && !items.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">No refill requests waiting.</p>
        ) : null}
        <ul>
          {items.map((r) => (
            <li
              key={r.id}
              className={cn("hover:bg-surface-hover", selected?.id === r.id && "bg-pine-50")}
            >
              <Pressable
                type="button"
                onClick={() => v.open("request", r.id)}
                className="grid w-full min-w-0 gap-0.5 px-5 py-3 text-left"
                data-testid={tid(S, "rr-row")}
              >
                <span className="flex items-center justify-between gap-2">
                  <b className="truncate font-semibold">{r.patient.name}</b>
                  <span data-testid={tid(S, "rr-status")}>
                    <StatusChip machine="task" value={r.taskStatus} />
                  </span>
                </span>
                <span className="text-small text-ink-2">
                  <span data-testid={tid(S, "rr-type")}>
                    {TYPE_LABEL[r.type] ?? enumLabel(r.type)}
                  </span>
                  {" · "}
                  {r.medication?.display ?? asText(r.requestedChange?.description) ?? "Medication"}
                  {" · "}
                  {formatShortDate(r.receivedAt)}
                </span>
                <span
                  className="flex items-center gap-2 text-small text-ink-2"
                  data-testid={tid(S, "rr-protocol")}
                >
                  <ProtocolTag r={r} />
                  {r.protocolMet === false && r.protocolNotes[0] ? (
                    <span className="truncate">{r.protocolNotes[0]}</span>
                  ) : null}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <RequestDetail key={selected.id} summary={selected} /> : <span />}
    </InboxLayout>
  );
}

function RequestDetail({ summary }: { summary: RxRequestView }) {
  const me = useMe();
  const navigate = useNavigate();
  const q = useApi("getRxRequest", { params: { rxRequestId: summary.id } });
  const r = q.data ?? summary;
  const canSign = !!me.canSign?.prescriptions;
  const erx = me.connectedGateways.includes("ErxGateway");
  const fills = useApi(
    "getMedicationFillHistory",
    { params: { patientId: r.patientId } },
    { enabled: erx },
  );
  const done = r.taskStatus === "COMPLETED" || !!r.responseStatus;
  const canPend =
    me.role === "ma" &&
    !done &&
    r.allowedTransitions.some(
      (t) => t === "task:open->pended-to-provider" || t === "task:in-progress->pended-to-provider",
    );
  const invalidates = ["listRxRequests", "getRxRequest", "getInboxCounts"] as const;

  const [pendOpen, setPendOpen] = React.useState(false);
  const [pendNote, setPendNote] = React.useState("");
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyPick, setDenyPick] = React.useState(DENY_REASONS[0]!);
  const [denyText, setDenyText] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const d = r.draft;
  const rc = r.requestedChange ?? {};
  const [qty, setQty] = React.useState("");
  const [refills, setRefills] = React.useState("");
  const [days, setDays] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [controlled, setControlled] = React.useState(false);
  const [dur, setDur] = React.useState<DurAlert | null>(null);
  const [passive, setPassive] = React.useState<DurAlert[] | null>(null);
  const [acked, setAcked] = React.useState<Set<string>>(new Set());
  const [approveOpen, setApproveOpen] = React.useState(false);

  const startEdit = () => {
    setQty(d?.quantity ?? asText(rc.quantity) ?? "");
    setRefills(String(d?.refills ?? rc.refills ?? ""));
    setDays(String(d?.daysSupply ?? rc.daysSupply ?? ""));
    setEditing(true);
  };

  const pend = useApiMutation("pendRxRequest", {
    invalidates: [...invalidates],
    onSuccess: () => (toast("Pended to the provider."), setPendOpen(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const deny = useApiMutation("denyRxRequest", {
    invalidates: [...invalidates],
    onSuccess: () => (toast("Request denied."), setDenyOpen(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const check = useApiMutation("checkPrescription");
  const approve = useApiMutation("approveRxRequest", {
    invalidates: [...invalidates],
    onSuccess: () => {
      toast("Approved and sent to the pharmacy.");
      setEditing(false);
      setPassive(null);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "controlled_renewal") {
        setControlled(true);
        setError(e.message);
      } else if (e instanceof ApiError && e.code === "invariant_blocked") {
        setError(blockerText(e) ?? e.message);
      } else if (e instanceof ApiError && e.code === "gateway_unavailable") {
        setError("The e-prescribing network isn't reachable. Nothing was sent. Try again shortly.");
      } else if (e instanceof ApiError && e.code === "invalid_transition") {
        setError("This request has already been handled. Refresh to see its current state.");
      } else setError(errorMessage(e));
    },
  });

  const send = (ackIds: string[]) => {
    setError(null);
    const changed = editing && !!d;
    approve.mutate({
      params: { rxRequestId: r.id },
      body: {
        decision: changed ? "change" : "approve",
        ...(changed
          ? {
              quantity: qty ? Number(qty) : undefined,
              refills: refills !== "" ? Number(refills) : undefined,
              daysSupply: days ? Number(days) : undefined,
            }
          : {}),
        ...(ackIds.length ? { acknowledgedAlertIds: ackIds } : {}),
      },
    });
  };

  /** INV-SAFE-06: re-check the draft; resolve interruptive alerts first, then passive acknowledgements, then send. */
  const runApprove = async () => {
    setError(null);
    if (!d) return send([]);
    let res;
    try {
      res = await check.mutateAsync({ params: { medicationRequestId: d.id } });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    const pending = res.alerts.filter((a) => a.outcome === "pending");
    const hard = pending.find((a) => a.severity === "INTERRUPTIVE" || a.severity === "HARD_STOP");
    if (hard) return setDur(hard);
    const soft = pending.filter((a) => a.severity === "PASSIVE");
    if (soft.length) {
      setAcked(new Set());
      return setPassive(soft);
    }
    send([]);
  };

  const sentence = (m: {
    display: string;
    sigText: string;
    quantity: string;
    quantityUnit: string;
    refills: number;
    daysSupply?: number | null;
  }) =>
    `${m.display} · ${m.sigText} · qty ${m.quantity} ${m.quantityUnit} · ${m.refills} refills${m.daysSupply ? ` · ${m.daysSupply} days` : ""}`;

  const denyReason = denyPick === OTHER ? denyText.trim() : denyPick;
  const bookable = !done && r.protocolMet === false;

  return (
    <Card data-testid={tid(S, "rq-med")}>
      <CardHeader
        title={`${r.patient.name} · ${TYPE_LABEL[r.type] ?? enumLabel(r.type)}`}
        actions={<StatusChip machine="task" value={r.taskStatus} />}
      />
      <p className="mb-4 text-small tabular-nums text-ink-2">
        DOB {formatDate(r.patient.birthDate)} · MRN {r.patient.mrn} · received{" "}
        {formatDateTime(r.receivedAt)}
        {r.pharmacy ? ` · ${r.pharmacy.name}` : ""}
      </p>
      {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : null}
      <div className="grid gap-5">
        <section className="grid gap-1">
          <h3 className="text-label text-ink">Original prescription</h3>
          <p className="text-body">{r.medication ? sentence(r.medication) : "Not on file."}</p>
          <h3 className="mt-2 text-label text-ink">Requested</h3>
          <p className="text-body">
            {[
              asText(rc.description),
              rc.quantity != null ? `qty ${rc.quantity}` : null,
              rc.daysSupply != null ? `${rc.daysSupply} days` : null,
              rc.refills != null ? `${rc.refills} refills` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Same as original."}
          </p>
          {asText(rc.reason) ? <p className="text-body text-ink-2">{asText(rc.reason)}</p> : null}
        </section>

        <section className="grid gap-2" data-testid={tid(S, "rq-context")}>
          <h3 className="text-label text-ink">Context</h3>
          <p className="text-body">
            Last visit: {r.lastVisit ? formatDate(r.lastVisit) : "none on record"}
          </p>
          <p className="flex items-center gap-2 text-body">
            <ProtocolTag r={r} />
          </p>
          {r.protocolNotes.length ? (
            <ul className="list-disc pl-5 text-body text-ink-2">
              {r.protocolNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {!erx ? (
            <Unavailable reason="Fill history needs e-prescribing, which isn't connected.">
              <Button size="sm" disabled>
                Fill history
              </Button>
            </Unavailable>
          ) : fills.isLoading ? (
            <LoadingRows rows={2} />
          ) : fills.error ? (
            <Alert tone="caution">{errorMessage(fills.error)}</Alert>
          ) : (fills.data ?? []).length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filled</TableHead>
                  <TableHead>Pharmacy</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Prescriber</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(fills.data ?? []).map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="tabular-nums">{formatShortDate(f.filledAt)}</TableCell>
                    <TableCell>{f.pharmacy}</TableCell>
                    <TableCell className="tabular-nums">{f.quantity}</TableCell>
                    <TableCell className="tabular-nums">{f.daysSupply}</TableCell>
                    <TableCell>{f.prescriber ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-body text-ink-2">No fills on record.</p>
          )}
        </section>

        {done ? (
          <Alert tone="neutral" title={`Response: ${enumLabel(r.responseStatus ?? "completed")}`}>
            {r.responseReason ?? "No reason recorded."}
          </Alert>
        ) : null}

        {error ? (
          <Alert
            tone="critical"
            testId={tid(S, "rq-error")}
            action={
              controlled && canSign ? (
                <Button size="sm" onClick={() => setDenyOpen(true)}>
                  Deny with reason
                </Button>
              ) : null
            }
          >
            {error}
          </Alert>
        ) : null}

        {editing && !done && canSign ? (
          <div className="grid grid-cols-3 gap-3" data-testid={tid(S, "rq-modify")}>
            <FieldShell label="Quantity" htmlFor="rq-qty">
              <Input
                id="rq-qty"
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </FieldShell>
            <FieldShell label="Refills" htmlFor="rq-refills">
              <Input
                id="rq-refills"
                type="number"
                min={0}
                value={refills}
                onChange={(e) => setRefills(e.target.value)}
              />
            </FieldShell>
            <FieldShell label="Days supply" htmlFor="rq-days">
              <Input
                id="rq-days"
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </FieldShell>
          </div>
        ) : null}

        {!done ? (
          <div className="flex flex-wrap justify-end gap-2">
            {canPend ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setPendOpen(true)}
                data-testid={tid(S, "rq-pend")}
              >
                Pend to provider
              </Button>
            ) : null}
            {bookable ? (
              isBuilt("schedule.booking-drawer") ? (
                <Button
                  size="sm"
                  onClick={() =>
                    navigate(
                      pathTo("schedule.booking-drawer", {}, undefined, { patientId: r.patientId }),
                    )
                  }
                  data-testid={tid(S, "rq-book")}
                >
                  Book visit + short supply
                </Button>
              ) : (
                <Unavailable reason="Booking isn't available yet.">
                  <Button size="sm" disabled data-testid={tid(S, "rq-book")}>
                    Book visit + short supply
                  </Button>
                </Unavailable>
              )
            ) : null}
            {canSign ? (
              <>
                <Button
                  size="sm"
                  onClick={() => (editing ? setEditing(false) : startEdit())}
                  disabled={!d}
                  data-testid={tid(S, "rq-modify-btn")}
                >
                  {editing ? "Discard changes" : "Modify"}
                </Button>
                <Button size="sm" onClick={() => setDenyOpen(true)} data-testid={tid(S, "rq-deny")}>
                  Deny with reason
                </Button>
                <Button
                  size="sm"
                  variant={canPend ? "secondary" : "primary"}
                  disabled={approve.isPending || check.isPending}
                  onClick={() => setApproveOpen(true)}
                  data-testid={tid(S, "rq-approve")}
                >
                  Approve & send
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendOpen}
        onOpenChange={setPendOpen}
        title="Pend to provider?"
        description="The provider will see this request in their inbox with your note."
        action="Pend"
        disabled={pend.isPending}
        onConfirm={() =>
          pend.mutate({
            params: { rxRequestId: r.id },
            body: { comment: pendNote.trim() },
          })
        }
        testId={tid(S, "pend-dialog")}
      >
        <FieldShell label="Note for the provider" htmlFor="rq-pend-note">
          <Textarea
            id="rq-pend-note"
            value={pendNote}
            onChange={(e) => setPendNote(e.target.value)}
          />
        </FieldShell>
      </ConfirmDialog>

      <ConfirmDialog
        open={denyOpen}
        onOpenChange={setDenyOpen}
        title="Deny this request?"
        description="The pharmacy is told the request was denied, with your reason."
        action="Deny"
        danger
        disabled={!denyReason || deny.isPending}
        onConfirm={() =>
          deny.mutate({ params: { rxRequestId: r.id }, body: { reason: denyReason } })
        }
        testId={tid(S, "deny-dialog")}
      >
        <div className="grid gap-3">
          <FieldShell label="Reason" htmlFor="rq-deny-reason">
            <Select
              id="rq-deny-reason"
              value={denyPick}
              onValueChange={setDenyPick}
              options={[
                ...DENY_REASONS.map((x) => ({ value: x, label: x })),
                { value: OTHER, label: "Other (write a reason)" },
              ]}
            />
          </FieldShell>
          {denyPick === OTHER ? (
            <FieldShell label="Reason in your words" htmlFor="rq-deny-text">
              <Textarea
                id="rq-deny-text"
                value={denyText}
                onChange={(e) => setDenyText(e.target.value)}
              />
            </FieldShell>
          ) : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title={`Approve ${r.medication?.display ?? "this request"}?`}
        description={
          editing
            ? "Sends your modified quantity, refills and days supply to the pharmacy."
            : "Sends the approval to the pharmacy."
        }
        action="Approve & send"
        onConfirm={() => void runApprove()}
        testId={tid(S, "approve-dialog")}
      />

      <ConfirmDialog
        open={!!passive}
        onOpenChange={(o) => !o && setPassive(null)}
        title="Review before sending"
        description="Acknowledge each notice to send this approval."
        action="Approve & send"
        disabled={!passive || passive.some((a) => !acked.has(a.id)) || approve.isPending}
        onConfirm={() => send([...acked])}
        testId={tid(S, "passive-dialog")}
      >
        <div className="grid gap-2">
          {(passive ?? []).map((a) => (
            <Checkbox
              key={a.id}
              checked={acked.has(a.id)}
              onCheckedChange={(c) =>
                setAcked((s) => {
                  const n = new Set(s);
                  if (c === true) n.add(a.id);
                  else n.delete(a.id);
                  return n;
                })
              }
              label={`Review: ${a.message}`}
            />
          ))}
        </div>
      </ConfirmDialog>

      <DurAlertDialog
        alert={dur}
        invalidates={["listRxRequests", "getRxRequest"]}
        onDecided={(outcome) => {
          setDur(null);
          if (outcome === "removed") {
            toast("The draft prescription was cancelled. Deny the request or book a visit.");
            setError(
              "The draft prescription was cancelled because of a safety alert. Deny this request to close it.",
            );
            setControlled(true);
            return;
          }
          void runApprove();
        }}
      />
    </Card>
  );
}
