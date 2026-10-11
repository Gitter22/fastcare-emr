import * as React from "react";
import { toast } from "sonner";
import { fromCents, toCents, type DepositBatchView, type Payment } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDate, formatTime, money, todayIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { DateInput } from "@/components/ui/date";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, ErrorState, LoadingRows } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { BillingLayout } from "@/features/billing/BillingLayout";

const S = "billing.day-close";

interface Expected {
  byUser: Array<{ userId: string | null; name: string; cash: string; check: string; card: string }>;
  cash: string;
  check: string;
  card: string;
}
interface Counted {
  cash: string;
  checks: string;
  cardTerminal?: string | null;
}

const okMoney = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());
const norm = (s: string) => fromCents(toCents(s));

/** billing.day-close (flow:rcm/09): count the drawer against posted payments, explain any variance, lock the batch. */
export function DayClosePage() {
  const { can } = useAuth();
  const locations = useApi("listLocations");
  const [locationId, setLocationId] = React.useState("");
  const [date, setDate] = React.useState<string | null>(todayIso());
  React.useEffect(() => {
    if (!locationId && locations.data?.length)
      setLocationId(locations.data.find((l) => l.active)?.id ?? locations.data[0]!.id);
  }, [locations.data, locationId]);
  const day = useApi(
    "getDayClose",
    { query: { locationId, ...(date ? { date } : {}) } },
    { enabled: !!locationId && !!date },
  );
  const v = day.data;
  return (
    <BillingLayout
      title="Day close"
      actions={
        <div className="flex items-end gap-3">
          {locations.data && locations.data.length > 1 ? (
            <Select
              aria-label="Location"
              value={locationId}
              onValueChange={setLocationId}
              options={locations.data.map((l) => ({ value: l.id, label: l.name }))}
              className="w-56"
            />
          ) : null}
          <DateInput
            aria-label="Business date"
            value={date}
            onChange={setDate}
            fromYear={2024}
            toYear={new Date().getFullYear()}
            testId={tid(S, "dc-date")}
          />
        </div>
      }
    >
      {day.error ? (
        <ErrorState message={errorMessage(day.error)} onRetry={() => void day.refetch()} />
      ) : !v ? (
        <LoadingRows rows={6} />
      ) : (
        <Batch key={v.id} v={v} canClose={can("closeDepositBatch")} />
      )}
    </BillingLayout>
  );
}

function Batch({ v, canClose }: { v: DepositBatchView; canClose: boolean }) {
  const expected = v.expected as Expected;
  const closed = v.status === "CLOSED";
  const counted = v.counted as Counted | null | undefined;
  const [cash, setCash] = React.useState(counted?.cash ?? "");
  const [checks, setChecks] = React.useState(counted?.checks ?? "");
  const [card, setCard] = React.useState(counted?.cardTerminal ?? "");
  const [reason, setReason] = React.useState(v.varianceReason ?? "");
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [saved, setSaved] = React.useState<DepositBatchView | null>(null);
  const cur = saved ?? v;
  const hasVariance = !!counted || !!saved ? toCents(cur.variance) !== 0 : false;
  const needReason = !closed && (hasVariance || !!blocked);

  const inputsOk = okMoney(cash) && okMoney(checks) && (card.trim() === "" || okMoney(card));
  const body = {
    cash: norm(cash),
    checks: norm(checks),
    ...(card.trim() ? { cardTerminal: norm(card) } : {}),
  };
  const save = useApiMutation("saveDrawerCounts", {
    invalidates: ["getDayClose"],
    onSuccess: (r) => (setSaved(r), setBlocked(null), toast("Counts saved.")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = useApiMutation("closeDepositBatch", {
    invalidates: ["getDayClose", "getPatientAccount"],
    onSuccess: () => toast("Day closed."),
    onError: (e) => {
      setConfirm(false);
      if (e instanceof ApiError && JSON.stringify(e.problem).includes("INV-FIN-04"))
        setBlocked(errorMessage(e));
      else toast.error(errorMessage(e));
    },
  });
  const countLabel = (m: "cash" | "check" | "card") =>
    m === "cash" ? counted?.cash : m === "check" ? counted?.checks : counted?.cardTerminal;

  const userCols: Col<Expected["byUser"][number]>[] = [
    {
      id: "u",
      header: "Taken by",
      accessorFn: (r) => r.name,
      cell: ({ row }) => row.original.name,
    },
    {
      id: "c",
      header: "Cash",
      meta: { numeric: true },
      accessorFn: (r) => toCents(r.cash),
      cell: ({ row }) => money(row.original.cash),
    },
    {
      id: "k",
      header: "Check",
      meta: { numeric: true },
      accessorFn: (r) => toCents(r.check),
      cell: ({ row }) => money(row.original.check),
    },
    {
      id: "d",
      header: "Card",
      meta: { numeric: true },
      accessorFn: (r) => toCents(r.card),
      cell: ({ row }) => money(row.original.card),
    },
  ];
  const payCols: Col<Payment>[] = [
    {
      id: "t",
      header: "Time",
      accessorFn: (p) => p.takenAt,
      cell: ({ row }) => <span className="tabular-nums">{formatTime(row.original.takenAt)}</span>,
    },
    {
      id: "m",
      header: "Method",
      accessorFn: (p) => p.method,
      cell: ({ row }) =>
        `${row.original.method === "CARD" ? "Card" : row.original.method === "CASH" ? "Cash" : "Check"}${row.original.checkNumber ? ` #${row.original.checkNumber}` : ""}${row.original.refundOfId ? " (refund)" : ""}`,
    },
    {
      id: "a",
      header: "Amount",
      meta: { numeric: true },
      accessorFn: (p) => toCents(p.amount),
      cell: ({ row }) => money(row.original.amount),
    },
  ];

  return (
    <>
      <div className="flex items-center gap-3">
        <Tag tone={closed ? "outline" : "active"} data-testid={tid(S, "dc-status")}>
          {closed ? "Closed" : "Open"}
        </Tag>
        <span className="text-body text-ink-2 tabular-nums">
          {formatDate(v.businessDate)} · expected {money(v.expectedTotal)}
          {v.countedTotal ? ` · counted ${money(v.countedTotal)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-6">
        <Card>
          <CardHeader title="Expected by user" />
          <DataTable<Expected["byUser"][number]>
            columns={userCols}
            data={expected?.byUser ?? []}
            empty="No cash, check or card payments posted for this day."
            testId={tid(S, "dc-by-user")}
          />
          {expected?.byUser?.length ? (
            <dl className="mt-3 flex justify-end gap-8 text-body font-semibold tabular-nums">
              <span>Cash {money(expected.cash)}</span>
              <span>Check {money(expected.check)}</span>
              <span>Card {money(expected.card)}</span>
            </dl>
          ) : null}
          <h3 className="mb-3 mt-8 text-h3">Payments</h3>
          <DataTable<Payment> columns={payCols} data={v.payments} empty="No payments." compact />
        </Card>
        <Card data-testid={tid(S, "dc-count")}>
          <CardHeader title={closed ? "Closed count" : "Count the drawer"} />
          <div className="grid gap-3">
            {(
              [
                ["Cash", cash, setCash, "cash", true],
                ["Checks", checks, setChecks, "check", true],
                ["Card terminal", card, setCard, "card", false],
              ] as const
            ).map(([label, val, set, m, req]) => (
              <FieldShell
                key={label}
                label={label}
                htmlFor={`dc-${m}`}
                hint={`Expected ${money(expected?.[m] ?? "0.00")}${req ? "" : " · optional"}`}
                required={req}
              >
                <Input
                  id={`dc-${m}`}
                  inputMode="decimal"
                  value={closed ? (countLabel(m) ?? "") : val}
                  disabled={closed}
                  onChange={(e) => set(e.target.value)}
                  className="tabular-nums"
                  aria-invalid={!closed && val !== "" && !okMoney(val) ? true : undefined}
                />
              </FieldShell>
            ))}
          </div>
          <div className="mt-4 grid gap-3">
            <div data-testid={tid(S, "dc-deposit")} className="grid gap-1">
              <span className="text-small text-ink-2">Deposit total (cash and checks)</span>
              <span className="text-h3 tabular-nums">
                {cur.depositTotal ? money(cur.depositTotal) : "—"}
              </span>
              <Unavailable reason="No bank feed is connected, so the deposit cannot be matched to the bank.">
                <Tag tone="outline">Bank feed not connected</Tag>
              </Unavailable>
            </div>
            {(counted || saved) && hasVariance ? (
              <Alert tone="caution" title="Variance." testId={tid(S, "dc-variance")}>
                The count is {toCents(cur.variance) > 0 ? "over" : "short"} by{" "}
                <b className="tabular-nums">{money(fromCents(Math.abs(toCents(cur.variance))))}</b>.
                Explain it before closing.
              </Alert>
            ) : blocked ? (
              <Alert tone="caution" title="Variance." testId={tid(S, "dc-variance")}>
                {blocked}
              </Alert>
            ) : null}
            {needReason || (closed && v.varianceReason) ? (
              <FieldShell label="Variance reason" htmlFor="dc-reason" required={!closed}>
                <Textarea
                  id="dc-reason"
                  value={reason}
                  disabled={closed}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid={tid(S, "dc-reason")}
                />
              </FieldShell>
            ) : null}
            {!closed && canClose ? (
              <div className="flex gap-3">
                <Button
                  disabled={!inputsOk || save.isPending}
                  loading={save.isPending}
                  onClick={() => save.mutate({ params: { depositBatchId: v.id }, body })}
                  data-testid={tid(S, "dc-save")}
                >
                  Save counts
                </Button>
                <Button
                  variant="primary"
                  disabled={!inputsOk || close.isPending || (hasVariance && !reason.trim())}
                  onClick={() => setConfirm(true)}
                  data-testid={tid(S, "dc-close")}
                >
                  Close day
                </Button>
              </div>
            ) : null}
            {!closed && !canClose ? (
              <p className="text-small text-ink-2">
                Your count is saved for the biller or manager to close the day.
              </p>
            ) : null}
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Close the day?"
        description="This locks the batch. Counts and payments for this date can no longer change."
        action="Close day"
        disabled={close.isPending}
        onConfirm={() =>
          close.mutate({
            params: { depositBatchId: v.id },
            body: {
              locationId: v.locationId,
              date: v.businessDate,
              counts: body,
              ...(reason.trim() ? { varianceReason: reason.trim() } : {}),
            },
          })
        }
      />
    </>
  );
}
