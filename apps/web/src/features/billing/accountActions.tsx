import * as React from "react";
import { toast } from "sonner";
import {
  fromCents,
  toCents,
  type OperationId,
  type PatientAccount,
  type Payment,
  type PaymentPlan,
} from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { addDaysIso, formatDate, money, todayIso } from "@/lib/format";
import { api } from "@/lib/api/client";
import { openBlob } from "@/lib/files";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader } from "@/components/ui/layout";
import { Checkbox, RadioGroup, Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";

const S = "billing.patient-account";
const INVALIDATE: OperationId[] = ["getPatientAccount", "getPatientBanner", "getDayClose"];

const valid = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim()) && toCents(s) > 0;
const cardLabel = (m: { brand: string; last4: string; expMonth: number; expYear: number }) =>
  `${m.brand} ending ${m.last4} · ${String(m.expMonth).padStart(2, "0")}/${String(m.expYear).slice(-2)}`;

/** pa-send-statement: outbound, so it confirms and names the channel. */
export function SendStatement({ patientId, due }: { patientId: string; due: string }) {
  const me = useMe();
  const sms = me.connectedGateways.includes("MessagingGateway:sms");
  const email = me.connectedGateways.includes("MessagingGateway:email");
  const [open, setOpen] = React.useState(false);
  const [channel, setChannel] = React.useState<"SMS" | "EMAIL">(sms ? "SMS" : "EMAIL");
  const send = useApiMutation("sendStatementNow", {
    invalidates: ["getPatientAccount", "listStatements", "getStatementCycle"],
    onSuccess: () => (toast("Statement sent."), setOpen(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!sms && !email)
    return (
      <Unavailable
        reason="Text and email messaging are not connected, so a statement cannot be delivered."
        testId={tid(S, "pa-send-statement")}
      >
        <Button disabled>Send statement now</Button>
      </Unavailable>
    );
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={toCents(due) <= 0}
        data-testid={tid(S, "pa-send-statement")}
      >
        Send statement now
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send statement now?"
        description={`The patient gets a statement for ${money(due)} with a secure link. No visit detail is in the message.`}
        action="Send statement"
        disabled={send.isPending}
        onConfirm={() => send.mutate({ params: { patientId }, body: { channel } })}
      >
        <RadioGroup
          aria-label="Channel"
          value={channel}
          onValueChange={setChannel}
          options={[
            {
              value: "SMS",
              label: sms ? "Text message" : "Text message (not connected)",
              disabled: !sms,
            },
            { value: "EMAIL", label: email ? "Email" : "Email (not connected)", disabled: !email },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}

/** pa-mode: Take payment / Payment plan side panel. */
export function AccountActions({ account }: { account: PatientAccount }) {
  const { can } = useAuth();
  const [mode, setMode] = React.useState("pay");
  const due = account.balance.patientDue;
  const plan = account.paymentPlans.find((p) => p.status === "ACTIVE");
  return (
    <Card data-testid={tid(S, "pa-mode")}>
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList className="mb-4">
          <TabsTrigger value="pay" data-testid={tid(S, "pa-mode-pay")}>
            Take payment
          </TabsTrigger>
          {can("createPaymentPlan") ? (
            <TabsTrigger value="plan" data-testid={tid(S, "pa-mode-plan")}>
              Payment plan
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="pay">
          <TakePayment account={account} due={due} />
        </TabsContent>
        <TabsContent value="plan">
          <PlanPanel account={account} due={due} active={plan} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}

type PayMethod = "CASH" | "CHECK" | "CARD";

function TakePayment({ account, due }: { account: PatientAccount; due: string }) {
  const me = useMe();
  const { can } = useAuth();
  const gateway = me.connectedGateways.includes("PaymentGateway");
  const cards = account.paymentMethods.filter((m) => m);
  const [method, setMethod] = React.useState<PayMethod>("CASH");
  const [amount, setAmount] = React.useState(due);
  const [cardId, setCardId] = React.useState(cards[0]?.id ?? "");
  const [check, setCheck] = React.useState("");
  const key = React.useRef(crypto.randomUUID());
  React.useEffect(() => setAmount(due), [due]);
  React.useEffect(() => setCardId((c) => c || cards[0]?.id || ""), [cards]);
  const pay = useApiMutation("createPayment", {
    invalidates: INVALIDATE,
    onSuccess: (p) => {
      toast(`Payment of ${money(p.amount)} taken.`);
      key.current = crypto.randomUUID();
      setCheck("");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!can("createPayment")) return null;
  const cardOk = gateway && cards.length > 0;
  const needsCheck = method === "CHECK" && !check.trim();
  const ready = valid(amount) && !needsCheck && (method !== "CARD" || (cardOk && !!cardId));
  return (
    <div className="grid gap-4" data-testid={tid(S, "pa-take-payment")}>
      <h4 className="text-h3">Take payment</h4>
      <RadioGroup<PayMethod>
        aria-label="Payment method"
        orientation="vertical"
        value={method}
        onValueChange={setMethod}
        options={[
          { value: "CASH", label: "Cash" },
          { value: "CHECK", label: "Check" },
          {
            value: "CARD",
            label: cardOk
              ? "Card on file"
              : !gateway
                ? "Card on file · available once the card processor is connected"
                : "Card on file · no card saved for this patient",
            disabled: !cardOk,
          },
        ]}
      />
      <FieldShell label="Amount" htmlFor="pay-amount">
        <Input
          id="pay-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="max-w-48 tabular-nums"
          aria-invalid={!valid(amount) || undefined}
        />
      </FieldShell>
      {method === "CHECK" ? (
        <FieldShell label="Check number" htmlFor="pay-check" required>
          <Input
            id="pay-check"
            value={check}
            onChange={(e) => setCheck(e.target.value)}
            className="max-w-48 tabular-nums"
          />
        </FieldShell>
      ) : null}
      {method === "CARD" && cardOk ? (
        <FieldShell label="Card">
          <Select
            aria-label="Card"
            value={cardId}
            onValueChange={setCardId}
            options={cards.map((m) => ({ value: m.id, label: cardLabel(m) }))}
          />
        </FieldShell>
      ) : null}
      <div>
        <Button
          variant="primary"
          disabled={!ready || pay.isPending}
          loading={pay.isPending}
          data-testid={tid(S, "pa-take-payment-submit")}
          onClick={() =>
            pay.mutate({
              body: {
                patientId: account.patient.id,
                amount: fromCents(toCents(amount)),
                method,
                ...(method === "CARD" ? { paymentMethodId: cardId } : {}),
                ...(method === "CHECK" ? { checkNumber: check.trim() } : {}),
                idempotencyKey: key.current,
              },
            })
          }
        >
          Take {valid(amount) ? money(fromCents(toCents(amount))) : "payment"}
        </Button>
      </div>
    </div>
  );
}

function PlanPanel({
  account,
  due,
  active,
}: {
  account: PatientAccount;
  due: string;
  active: PaymentPlan | undefined;
}) {
  const me = useMe();
  const sms = me.connectedGateways.includes("MessagingGateway:sms");
  const cards = account.paymentMethods;
  const [total, setTotal] = React.useState(due);
  const [months, setMonths] = React.useState("3");
  const [start, setStart] = React.useState<string | null>(addDaysIso(todayIso(), 7));
  const [cardId, setCardId] = React.useState(cards[0]?.id ?? "");
  const [cancelling, setCancelling] = React.useState<PaymentPlan | null>(null);
  const [reason, setReason] = React.useState("");
  React.useEffect(() => setTotal(due), [due]);
  React.useEffect(() => setCardId((c) => c || cards[0]?.id || ""), [cards]);
  const create = useApiMutation("createPaymentPlan", {
    invalidates: [...INVALIDATE, "listPaymentPlans", "listStatements"],
    onSuccess: (p) =>
      toast(`Plan created: ${money(p.monthlyAmount)} a month for ${p.months} months.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useApiMutation("cancelPaymentPlan", {
    invalidates: [...INVALIDATE, "listPaymentPlans"],
    onSuccess: () => (toast("Payment plan cancelled."), setCancelling(null), setReason("")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const { can } = useAuth();
  const n = Number(months);
  const totalCents = valid(total) ? toCents(total) : 0;
  const preview = totalCents ? Math.round(totalCents / n) : 0;
  const startOk = !!start && start >= todayIso();
  const noCard = cards.length === 0;
  const ready = totalCents > 0 && startOk && !!cardId;
  return (
    <div className="grid gap-4" data-testid={tid(S, "pa-plan")}>
      {active ? (
        <Alert tone="neutral" testId={tid(S, "pa-plan-active")}>
          <span className="grid gap-2">
            <span>
              Active plan: <b className="tabular-nums">{money(active.monthlyAmount)}</b> a month for{" "}
              {active.months} months from {formatDate(active.firstPaymentOn)}. Statements are paused
              while the plan is current.
            </span>
            {can("cancelPaymentPlan") ? (
              <span>
                <Button
                  size="sm"
                  onClick={() => setCancelling(active)}
                  data-testid={tid(S, "pa-plan-cancel")}
                >
                  Cancel plan
                </Button>
              </span>
            ) : null}
          </span>
        </Alert>
      ) : (
        <>
          <h4 className="text-h3">
            Set up payment plan · <span className="tabular-nums">{money(due)}</span>
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <FieldShell label="Plan total" htmlFor="plan-total">
              <Input
                id="plan-total"
                inputMode="decimal"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="tabular-nums"
                data-testid={tid(S, "pa-plan-total")}
              />
            </FieldShell>
            <FieldShell label="Months">
              <Select
                aria-label="Months"
                value={months}
                onValueChange={setMonths}
                testId={tid(S, "pa-plan-months")}
                options={Array.from({ length: 11 }, (_, i) => ({
                  value: String(i + 2),
                  label: `${i + 2} months`,
                }))}
              />
            </FieldShell>
            <FieldShell label="Monthly" hint="Final amount is set when the plan is created.">
              <div
                className="flex h-control-md items-center bg-surface-muted px-3 text-body tabular-nums"
                data-testid={tid(S, "pa-plan-amount")}
              >
                {totalCents ? `About ${money(fromCents(preview))}` : "—"}
              </div>
            </FieldShell>
            <FieldShell
              label="First payment"
              error={!startOk ? "Pick today or a later date." : undefined}
            >
              <DateInput
                aria-label="First payment"
                value={start}
                onChange={setStart}
                fromYear={new Date().getFullYear()}
                toYear={new Date().getFullYear() + 2}
                testId={tid(S, "pa-plan-start")}
              />
            </FieldShell>
          </div>
          <FieldShell label="Autopay card">
            {noCard ? (
              <Unavailable reason="This patient has no card on file. Save a card first; autopay needs one.">
                <Select
                  aria-label="Autopay card"
                  value=""
                  onValueChange={() => {}}
                  disabled
                  options={[]}
                  placeholder="No card on file"
                />
              </Unavailable>
            ) : (
              <Select
                aria-label="Autopay card"
                value={cardId}
                onValueChange={setCardId}
                testId={tid(S, "pa-plan-card")}
                options={cards.map((m) => ({ value: m.id, label: cardLabel(m) }))}
              />
            )}
          </FieldShell>
          <p className="text-body text-ink-2">
            Statements pause while the plan is current. A missed payment retries once, then notifies
            the patient.
            {sms ? "" : " Text messaging is not connected, so the patient will not be texted."}
          </p>
          <div>
            <Button
              variant="primary"
              disabled={!ready || create.isPending}
              loading={create.isPending}
              data-testid={tid(S, "pa-plan-create")}
              onClick={() =>
                create.mutate({
                  params: { patientId: account.patient.id },
                  body: {
                    totalAmount: fromCents(totalCents),
                    months: n,
                    firstPaymentOn: start!,
                    paymentMethodId: cardId,
                  },
                })
              }
            >
              {sms ? "Create plan & text patient" : "Create plan"}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel payment plan?"
        description="Autopay stops and statements resume on the next cycle."
        action="Cancel plan"
        danger
        disabled={!reason.trim() || cancel.isPending}
        onConfirm={() =>
          cancelling &&
          cancel.mutate({
            params: { paymentPlanId: cancelling.id },
            body: { reason: reason.trim() },
          })
        }
      >
        <FieldShell label="Reason" htmlFor="plan-cancel-reason" required>
          <Textarea
            id="plan-cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </FieldShell>
      </ConfirmDialog>
    </div>
  );
}

/** Payments with receipts and (when there is credit) pc-refund. Refund needs step-up; the API client prompts for it. */
export function PaymentsCard({ account }: { account: PatientAccount }) {
  const { can } = useAuth();
  const credit = toCents(account.balance.credit);
  const refundable = account.payments.filter((p) => p.status === "SUCCEEDED" && !p.refundOfId);
  const [open, setOpen] = React.useState(false);
  const [paymentId, setPaymentId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [original, setOriginal] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const chosen = refundable.find((p) => p.id === paymentId);
  const refund = useApiMutation("refundPayment", {
    invalidates: INVALIDATE,
    onSuccess: () => (toast("Refund issued."), setOpen(false)),
    onError: (e) => setErr(errorMessage(e)),
  });
  const receipt = async (p: Payment) => {
    try {
      openBlob(
        (await api("getPaymentReceipt", { params: { paymentId: p.id } })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const startRefund = () => {
    const p = refundable[0];
    setPaymentId(p?.id ?? "");
    setAmount(fromCents(Math.min(credit, p ? toCents(p.amount) : credit)));
    setReason("");
    setOriginal(p?.method === "CARD");
    setErr(null);
    setOpen(true);
  };
  const payments = [...account.payments]
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt))
    .slice(0, 8);
  return (
    <Card data-testid={tid(S, "pa-payments")}>
      <CardHeader
        title="Payments"
        actions={
          credit > 0 && can("refundPayment") && refundable.length ? (
            <Button size="sm" onClick={startRefund} data-testid={tid(S, "pc-refund")}>
              Refund credit
            </Button>
          ) : null
        }
      />
      {payments.length === 0 ? (
        <p className="text-body text-ink-2">No payments yet.</p>
      ) : (
        <ul className="grid">
          {payments.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 border-b border-line py-2 last:border-b-0"
            >
              <span className="grid flex-1">
                <span className="tabular-nums">
                  {p.refundOfId ? "-" : ""}
                  {money(p.amount)} ·{" "}
                  {p.method === "CARD" ? "Card" : p.method === "CASH" ? "Cash" : "Check"}
                </span>
                <span className="text-small text-ink-2 tabular-nums">{formatDate(p.takenAt)}</span>
              </span>
              {p.status !== "SUCCEEDED" ? <Tag tone="caution">{p.status.toLowerCase()}</Tag> : null}
              {p.refundOfId ? <Tag>Refund</Tag> : null}
              {can("getPaymentReceipt") && p.status === "SUCCEEDED" ? (
                <Button size="sm" variant="ghost" onClick={() => void receipt(p)}>
                  Receipt
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Refund credit?"
        description={`The patient has a credit of ${money(account.balance.credit)}. Refunds need you to confirm your identity.`}
        action="Refund"
        testId={tid(S, "pc-refund-dialog")}
        disabled={refund.isPending || !valid(amount) || !reason.trim() || !chosen}
        onConfirm={() =>
          refund.mutate({
            params: { paymentId },
            body: {
              amount: fromCents(toCents(amount)),
              reason: reason.trim(),
              toOriginalMethod: original,
            },
          })
        }
      >
        <div className="grid gap-3">
          <FieldShell label="Payment to refund">
            <Select
              aria-label="Payment to refund"
              value={paymentId}
              onValueChange={(v) => {
                setPaymentId(v);
                const p = refundable.find((x) => x.id === v);
                setOriginal(p?.method === "CARD");
              }}
              options={refundable.map((p) => ({
                value: p.id,
                label: `${formatDate(p.takenAt)} · ${money(p.amount)} · ${p.method.toLowerCase()}`,
              }))}
            />
          </FieldShell>
          <FieldShell label="Amount" htmlFor="refund-amount">
            <Input
              id="refund-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="max-w-48 tabular-nums"
            />
          </FieldShell>
          <FieldShell label="Reason" htmlFor="refund-reason" required>
            <Textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FieldShell>
          {chosen?.method === "CARD" ? (
            <Checkbox
              checked={original}
              onCheckedChange={(c) => setOriginal(c === true)}
              label="Refund to the original card"
            />
          ) : (
            <p className="text-small text-ink-2">
              Cash and check refunds are paid from the drawer.
            </p>
          )}
          {err ? <Alert tone="critical">{err}</Alert> : null}
        </div>
      </ConfirmDialog>
    </Card>
  );
}
