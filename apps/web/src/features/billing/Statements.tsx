import * as React from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { toCents, type Statement } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation, opKey } from "@/lib/api/hooks";
import { formatDate, formatDateTime, money, pluralize } from "@/lib/format";
import { openBlob } from "@/lib/files";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, CardHeader } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { BillingLayout } from "@/features/billing/BillingLayout";

const S = "billing.statements";
const CHANNEL: Record<string, string> = {
  sms: "Text",
  email: "Email",
  mail: "Mail",
  portal: "Portal",
};

/** billing.statements (flow:rcm/08): next cycle, run now, and the statements already sent. */
export function StatementsPage() {
  const cycle = useApi("getStatementCycle", undefined, { refetchInterval: 30_000 });
  const list = useApi("listStatements", { query: { limit: 100 } });
  const [confirm, setConfirm] = React.useState(false);
  const run = useApiMutation("runStatements", {
    invalidates: ["getStatementCycle", "listStatements", "getPatientAccount"],
    onSuccess: () => (toast("Statement run started."), setConfirm(false)),
    onError: (e) => (toast.error(errorMessage(e)), setConfirm(false)),
  });
  const rows = list.data?.data;
  const ids = React.useMemo(() => [...new Set(rows?.map((s) => s.patientId) ?? [])], [rows]);
  const names = useQueries({
    queries: ids.map((patientId) => ({
      queryKey: opKey("getPatientBanner", { params: { patientId } }),
      queryFn: () => api("getPatientBanner", { params: { patientId } }),
      staleTime: 5 * 60_000,
    })),
  });
  const nameOf = (id: string) => names[ids.indexOf(id)]?.data?.name;

  const open = async (s: Statement) => {
    try {
      openBlob(
        (await api("getStatementPdf", { params: { statementId: s.id } })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Col<Statement>[] = [
    {
      id: "patient",
      header: "Patient",
      accessorFn: (s) => nameOf(s.patientId) ?? "",
      cell: ({ row }) => (
        <Link
          className="font-semibold underline underline-offset-4 hover:text-pine-700"
          to={pathTo("billing.patient-account", { patientId: row.original.patientId })}
          data-testid={tid(S, "st-account")}
        >
          {nameOf(row.original.patientId) ?? "View account"}
        </Link>
      ),
    },
    {
      id: "cycle",
      header: "Cycle",
      accessorFn: (s) => s.cycleNumber,
      cell: ({ row }) => <span className="tabular-nums">{row.original.cycleNumber}</span>,
    },
    {
      id: "amt",
      header: "Amount",
      accessorFn: (s) => toCents(s.amountDue),
      meta: { numeric: true },
      cell: ({ row }) => money(row.original.amountDue),
    },
    {
      id: "due",
      header: "Due",
      accessorFn: (s) => s.dueDate,
      cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.dueDate)}</span>,
    },
    {
      id: "sent",
      header: "Sent",
      accessorFn: (s) => s.sentAt,
      cell: ({ row }) => (
        <span className="tabular-nums">{formatDateTime(row.original.sentAt)}</span>
      ),
    },
    {
      id: "ch",
      header: "Channel",
      enableSorting: false,
      cell: ({ row }) => row.original.channels.map((c) => CHANNEL[c] ?? c).join(", ") || "—",
    },
    {
      id: "opened",
      header: "Opened",
      accessorFn: (s) => s.openedAt ?? "",
      cell: ({ row }) =>
        row.original.openedAt ? (
          <span className="tabular-nums">{formatDate(row.original.openedAt)}</span>
        ) : (
          "—"
        ),
    },
    {
      id: "paid",
      header: "Paid",
      accessorFn: (s) => s.paidAt ?? "",
      cell: ({ row }) =>
        row.original.paidAt ? (
          <span className="tabular-nums">{formatDate(row.original.paidAt)}</span>
        ) : row.original.holdReason ? (
          <Tag tone="caution">Hold: {row.original.holdReason.replace(/-/g, " ")}</Tag>
        ) : (
          "—"
        ),
    },
    {
      id: "pdf",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void open(row.original)}
          data-testid={tid(S, "st-pdf")}
        >
          View PDF
        </Button>
      ),
    },
  ];

  const c = cycle.data;
  return (
    <BillingLayout
      title="Statements"
      actions={
        <Button
          variant="primary"
          onClick={() => setConfirm(true)}
          disabled={run.isPending}
          data-testid={tid(S, "st-run")}
        >
          Run statements now
        </Button>
      }
    >
      <Card data-testid={tid(S, "st-cycle")}>
        <CardHeader title="Next statement run" />
        {c ? (
          <dl className="grid grid-cols-3 gap-6">
            <div className="grid gap-0.5">
              <dt className="text-small text-ink-2">Runs</dt>
              <dd className="text-h3 tabular-nums">{formatDateTime(c.runAt)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-small text-ink-2">Patients included</dt>
              <dd className="text-h3 tabular-nums">{c.statements}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-small text-ink-2">Total due</dt>
              <dd className="text-h3 tabular-nums">{money(c.total)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-body text-ink-2">Loading the next run.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Statements sent" />
        <DataTable<Statement>
          columns={columns}
          data={rows}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          getRowId={(s) => s.id}
          empty="No statements sent yet."
          testId={tid(S, "st-table")}
        />
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run statements now?"
        description={
          c
            ? `${pluralize(c.statements, "patient")} totaling ${money(c.total)} get a statement by text, email or mail. Accounts on a payment plan or hold are skipped.`
            : "Patients with a balance get a statement. Accounts on a payment plan or hold are skipped."
        }
        action="Run statements"
        disabled={run.isPending}
        onConfirm={() => run.mutate({})}
      />
    </BillingLayout>
  );
}
