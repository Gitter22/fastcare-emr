import * as React from "react";
import { Link, useParams } from "react-router-dom";
import type { ServiceRequestView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { formatShortDate, status, todayIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { Card, Page, PageHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import {
  CATEGORY_LABEL,
  CancelOrderDialog,
  ResendButton,
  orderTypeText,
  useLabConnected,
  useRequisition,
} from "@/features/encounter/orders/orderParts";

const S = "chart.orders";
const ORDER_STATES = [
  "PENDED",
  "SIGNED",
  "SENT",
  "COLLECTED",
  "RESULTED_PRELIM",
  "RESULTED_FINAL",
  "REVIEWED",
  "CANCELLED",
] as const;
const DONE = ["RESULTED_PRELIM", "RESULTED_FINAL", "REVIEWED", "CANCELLED"];

/** chart.orders: every order for the patient with status, expected-by (INV-SAFE-07 overdue chip), result link, cancel, requisition. */
export function OrdersListPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const labConnected = useLabConnected();
  const requisition = useRequisition();
  const [st, setSt] = React.useState("all");
  const [type, setType] = React.useState("all");
  const [cancelling, setCancelling] = React.useState<ServiceRequestView | null>(null);
  const q = useApi("listPatientServiceRequests", {
    params: { patientId },
    query: {
      ...(st !== "all" ? { status: [st] } : {}),
      ...(type !== "all" ? { category: type } : {}),
      limit: 100,
    },
  });
  const today = todayIso();
  const columns = React.useMemo<Col<ServiceRequestView>[]>(
    () => [
      {
        id: "test",
        header: "Test",
        accessorFn: (o) => o.display,
        cell: ({ row: { original: o } }) => (
          <span className="grid">
            <b className="font-semibold">{o.display}</b>
            <span className="text-small text-ink-2">{orderTypeText(o)}</span>
          </span>
        ),
      },
      {
        id: "ordered",
        header: "Ordered",
        accessorFn: (o) => o.signedAt ?? o.createdAt,
        cell: ({ row: { original: o } }) => (
          <span className="tabular-nums">{formatShortDate(o.signedAt ?? o.createdAt)}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (o) => o.status,
        cell: ({ row: { original: o } }) => (
          <span className="flex items-center gap-2">
            <StatusChip machine="order" value={o.status} testId={tid(S, "ord-status")} />
            {o.expectedBy && o.expectedBy < today && !DONE.includes(o.status) ? (
              <Tag tone="caution" data-testid={tid(S, "ord-overdue")}>
                Overdue
              </Tag>
            ) : null}
          </span>
        ),
      },
      {
        id: "expected",
        header: "Expected by",
        accessorFn: (o) => o.expectedBy ?? "",
        cell: ({ row: { original: o } }) => (
          <span className="tabular-nums">{o.expectedBy ? formatShortDate(o.expectedBy) : "—"}</span>
        ),
      },
      {
        id: "result",
        header: "Result",
        enableSorting: false,
        cell: ({ row: { original: o } }) => {
          const r = o.results[0];
          return r ? (
            <Link
              className="text-pine-700 underline"
              data-testid={tid(S, "ord-result")}
              to={`${pathTo("chart.results", { patientId })}?view=report&id=${r.id}`}
            >
              View result
            </Link>
          ) : (
            "—"
          );
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row: { original: o } }) => (
          <span className="flex flex-wrap justify-end gap-1">
            {o.category === "LAB" && ["SIGNED", "SENT"].includes(o.status) ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={requisition.pending === o.id}
                  data-testid={tid(S, "ord-reprint")}
                  onClick={() => void requisition.open(o.id)}
                >
                  Reprint requisition
                </Button>
                {o.status === "SIGNED" || !labConnected ? <ResendButton order={o} /> : null}
              </>
            ) : null}
            {!DONE.includes(o.status) && can("cancelServiceRequest") ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid={tid(S, "ord-cancel")}
                onClick={() => setCancelling(o)}
              >
                Cancel order
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [can, labConnected, requisition, today, patientId],
  );
  return (
    <Page>
      <PageHeader
        title="Orders"
        actions={
          <>
            <Select
              value={st}
              onValueChange={setSt}
              aria-label="Status"
              testId={tid(S, "status-filter")}
              className="w-52"
              options={[
                { value: "all", label: "All statuses" },
                ...ORDER_STATES.map((s) => ({ value: s, label: status("order", s) })),
              ]}
            />
            <Select
              value={type}
              onValueChange={setType}
              aria-label="Type"
              testId={tid(S, "type-filter")}
              className="w-44"
              options={[
                { value: "all", label: "All types" },
                ...["LAB", "IMAGING", "PROCEDURE", "REFERRAL"].map((c) => ({
                  value: c,
                  label: CATEGORY_LABEL[c]!,
                })),
              ]}
            />
          </>
        }
      />
      <Card data-testid={tid(S, "order-table")}>
        <DataTable
          columns={columns}
          data={q.data?.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty="No orders for this patient."
          getRowId={(o) => o.id}
        />
      </Card>
      <CancelOrderDialog order={cancelling} onClose={() => setCancelling(null)} />
    </Page>
  );
}
