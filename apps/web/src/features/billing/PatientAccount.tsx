import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toCents, type LedgerEntry } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { formatDate, money, pluralize } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, ErrorState, LoadingRows } from "@/components/ui/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { Alert } from "@/components/ui/layout";
import { DataTable, type Col } from "@/components/ui/data-table";
import { Pressable } from "@/components/ui/pressable";
import { BillingLayout } from "@/features/billing/BillingLayout";
import { AccountActions, PaymentsCard, SendStatement } from "@/features/billing/accountActions";
import {
  LEDGER_LABEL,
  groupByVisit,
  paidYtd,
  type VisitGroup,
} from "@/features/billing/accountVisits";

const S = "billing.patient-account";

function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId: string;
}) {
  return (
    <Card className="grid gap-1" data-testid={testId}>
      <span className="text-body text-ink-2">{label}</span>
      <span className="text-display tabular-nums">{value}</span>
      <span className="min-h-5 text-small text-ink-2">{note}</span>
    </Card>
  );
}

/** billing.patient-account (flow:rcm/08): balances, by-visit ledger, payment and plan. */
export function PatientAccountPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const account = useApi("getPatientAccount", { params: { patientId } });
  const banner = useApi(
    "getPatientBanner",
    { params: { patientId } },
    { enabled: can("getPatientBanner") },
  );
  const claims = useApi(
    "listClaims",
    { query: { patientId, limit: 100 } },
    { enabled: can("listClaims") },
  );
  const [tab, setTab] = React.useState("visit");
  const [open, setOpen] = React.useState<Set<string>>(new Set());

  const a = account.data;
  const groups = React.useMemo(() => (a ? groupByVisit(a.ledger) : []), [a]);
  React.useEffect(() => {
    if (account.error) toast.error(errorMessage(account.error));
  }, [account.error]);

  if (account.error)
    return (
      <BillingLayout title="Patient account">
        <ErrorState message={errorMessage(account.error)} onRetry={() => void account.refetch()} />
      </BillingLayout>
    );
  if (!a)
    return (
      <BillingLayout title="Patient account">
        <LoadingRows rows={8} />
      </BillingLayout>
    );

  const b = a.balance;
  const plan = a.paymentPlans.find((p) => p.status === "ACTIVE");
  const credit = toCents(b.credit) > 0;
  const lastStatement = [...a.statements].sort((x, y) => y.sentAt.localeCompare(x.sentAt))[0];
  const card = a.paymentMethods.find((m) => m.isDefault) ?? a.paymentMethods[0];
  const pendingClaims = new Set(
    a.ledger.filter((e) => e.responsibility === "INSURANCE" && e.claimId).map((e) => e.claimId),
  ).size;
  const claimOf = (id: string | null) => claims.data?.data.find((c) => c.id === id);

  const statementChip = plan
    ? "Statements paused: payment plan"
    : lastStatement
      ? `Statement ${lastStatement.cycleNumber} sent ${formatDate(lastStatement.sentAt)}`
      : "No statement sent";

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(k)) n.add(k);
      return n;
    });

  const ledgerCols: Col<LedgerEntry>[] = [
    {
      id: "d",
      header: "Posted",
      accessorFn: (e) => e.postedAt,
      cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.postedAt)}</span>,
    },
    {
      id: "t",
      header: "Type",
      accessorFn: (e) => e.type,
      cell: ({ row }) => LEDGER_LABEL[row.original.type] ?? row.original.type,
    },
    {
      id: "r",
      header: "Responsibility",
      accessorFn: (e) => e.responsibility,
      cell: ({ row }) => (row.original.responsibility === "PATIENT" ? "Patient" : "Insurance"),
    },
    {
      id: "m",
      header: "Detail",
      enableSorting: false,
      cell: ({ row }) =>
        [row.original.carc ? `CARC ${row.original.carc}` : null, row.original.memo]
          .filter(Boolean)
          .join(" · ") || "—",
    },
    {
      id: "a",
      header: "Amount",
      accessorFn: (e) => toCents(e.amount),
      meta: { numeric: true },
      cell: ({ row }) => money(row.original.amount),
    },
  ];

  return (
    <BillingLayout title="Patient account">
      <Card
        data-testid={tid(S, "pa-banner")}
        className="flex flex-wrap items-center gap-x-8 gap-y-3"
      >
        <div className="grid gap-0.5">
          <span className="text-h2">{a.patient.name}</span>
          <span className="text-body text-ink-2 tabular-nums">
            DOB {formatDate(a.patient.birthDate)} · MRN {a.patient.mrn} · guarantor:{" "}
            {a.guarantor ?? "self"}
          </span>
        </div>
        <div className="grid gap-0.5">
          <span className="text-small text-ink-2">Coverage</span>
          <span className="text-body">{banner.data?.primaryCoverage ?? "Self-pay"}</span>
        </div>
        <div className="grid gap-0.5">
          <span className="text-small text-ink-2">Card on file</span>
          <span className="text-body">{card ? `${card.brand} ending ${card.last4}` : "None"}</span>
        </div>
        <div className="ml-auto" data-testid={tid(S, "pa-statement-status")}>
          <Tag tone="outline">{statementChip}</Tag>
        </div>
      </Card>

      {b.inCollections ? (
        <Alert tone="caution" title="Collections hold." testId={tid(S, "collections-hold")}>
          This account is in collections. Statements are held.
        </Alert>
      ) : null}
      {credit ? (
        <Alert tone="neutral" title="Credit balance." testId={tid(S, "credit-balance")}>
          The patient is owed {money(b.credit)}. Refund it or apply it to the next visit.
        </Alert>
      ) : null}

      <div className="grid grid-cols-4 gap-6">
        <Stat
          testId={tid(S, "pa-owes")}
          label="Patient owes now"
          value={money(b.patientDue)}
          note={
            b.oldestDays != null && toCents(b.patientDue) > 0
              ? `oldest ${b.oldestDays} days`
              : undefined
          }
        />
        <Stat
          testId={tid(S, "pa-insurance-pending")}
          label="Waiting on insurance"
          value={money(b.insurancePending)}
          note={
            toCents(b.insurancePending) > 0 && pendingClaims
              ? pluralize(pendingClaims, "claim")
              : undefined
          }
        />
        <Stat
          testId={tid(S, "pa-paid-ytd")}
          label="Paid this year"
          value={money(paidYtd(a.payments))}
        />
        <Stat testId={tid(S, "pa-credit")} label="Credit" value={money(b.credit)} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-6">
        <Card>
          <Tabs value={tab} onValueChange={setTab}>
            <div className="mb-4 flex items-center justify-between gap-4">
              <TabsList data-testid={tid(S, "pa-ledger-toggle")}>
                <TabsTrigger value="visit">By visit</TabsTrigger>
                <TabsTrigger value="ledger">Ledger</TabsTrigger>
              </TabsList>
              {can("sendStatementNow") ? (
                <SendStatement patientId={patientId} due={b.patientDue} />
              ) : null}
            </div>
            <TabsContent value="visit">
              {groups.length === 0 ? (
                <p className="text-body text-ink-2">No charges on this account yet.</p>
              ) : (
                <div className="grid">
                  <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,96px)_28px] border-b border-ink pb-2 text-label text-ink-2">
                    <span>Visit</span>
                    {["Charged", "Insurance", "Adjusted", "Paid", "You owe"].map((h) => (
                      <span key={h} className="text-right">
                        {h}
                      </span>
                    ))}
                    <span />
                  </div>
                  {groups.map((g) => (
                    <VisitRow
                      key={g.key}
                      g={g}
                      open={open.has(g.key)}
                      onToggle={() => toggle(g.key)}
                      claim={claimOf(g.claimId)}
                    />
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="ledger">
              <DataTable<LedgerEntry>
                columns={ledgerCols}
                data={a.ledger}
                getRowId={(e) => e.id}
                empty="No ledger entries."
                testId={tid(S, "pa-ledger")}
              />
            </TabsContent>
          </Tabs>
        </Card>
        <div className="grid gap-6">
          <AccountActions account={a} />
          <PaymentsCard account={a} />
        </div>
      </div>
    </BillingLayout>
  );
}

function VisitRow({
  g,
  open,
  onToggle,
  claim,
}: {
  g: VisitGroup;
  open: boolean;
  onToggle: () => void;
  claim: { id: string; number: string; payerName: string; dateOfService: string } | undefined;
}) {
  const date = claim?.dateOfService ?? g.date;
  const owed = toCents(g.owed);
  const pending = toCents(g.insurancePending) > 0;
  return (
    <div className="border-b border-line" data-testid={tid(S, "pa-visit")}>
      <Pressable
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_repeat(5,96px)_28px] items-center py-3 text-left hover:bg-surface-hover"
      >
        <span className="grid">
          <b className="font-semibold">
            {g.encounterId ? `Visit ${formatDate(date)}` : "Other activity"}
          </b>
          <span className="text-small text-ink-2">
            {claim
              ? `${claim.payerName} · claim ${claim.number}`
              : pending
                ? "Waiting on insurance"
                : owed === 0
                  ? "Paid in full"
                  : "Self-pay"}
          </span>
        </span>
        <span className="text-right tabular-nums">{money(g.charged)}</span>
        <span className="text-right tabular-nums">
          {pending ? "pending" : money(g.insurancePaid)}
        </span>
        <span className="text-right tabular-nums">{money(g.adjustments)}</span>
        <span className="text-right tabular-nums">{money(g.payments)}</span>
        <span className="text-right font-semibold tabular-nums">{money(g.owed)}</span>
        {open ? (
          <ChevronDown size={18} strokeWidth={1.75} className="ml-2" aria-hidden />
        ) : (
          <ChevronRight size={18} strokeWidth={1.75} className="ml-2" aria-hidden />
        )}
      </Pressable>
      {open ? (
        <div className="grid gap-1 pb-3 pl-4 text-body">
          {g.entries.map((e) => (
            <div key={e.id} className="flex justify-between gap-4">
              <span className="text-ink-2">
                {formatDate(e.postedAt)} · {LEDGER_LABEL[e.type] ?? e.type}
                {e.carc ? ` (${e.carc})` : ""}
                {e.memo ? ` · ${e.memo}` : ""}
                {" · "}
                {e.responsibility === "PATIENT" ? "patient" : "insurance"}
              </span>
              <span className="tabular-nums">{money(e.amount)}</span>
            </div>
          ))}
          {claim && isBuilt("billing.claims") ? (
            <Button asChild variant="link" size="sm" className="justify-self-start">
              <Link
                to={pathTo("billing.claims", {}, "detail", { id: claim.id })}
                data-testid={tid(S, "pav-claim")}
              >
                Open claim {claim.number}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
