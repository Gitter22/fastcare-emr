import * as React from "react";
import { useParams } from "react-router-dom";
import { useApi } from "@/lib/api/hooks";
import { tid } from "@/app/routes";
import type { DiagnosticReportSummary } from "@agile-emr/shared";
import { addDaysIso, enumLabel, formatShortDate, todayIso } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
} from "@/components/ui/layout";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { ReportDetail } from "./ReportDetail";

const S = "chart.results";
const TYPES = [
  { value: "all", label: "All" },
  { value: "LAB", label: "Lab" },
  { value: "RAD", label: "Imaging" },
  { value: "OTHER", label: "Other" },
];
const RANGES = [
  { value: "365", label: "Last year" },
  { value: "730", label: "Last 2 years" },
  { value: "1825", label: "Last 5 years" },
];

const statusText = (s: string) =>
  s === "REGISTERED" || s === "PARTIAL" ? "Pending" : enumLabel(s);
const monthKey = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase()
    : "PENDING";

/** chart.results (flow:results/05): reports by date or by test; the selected report opens in a pane with its trend. */
export function ResultsPage() {
  const { patientId = "" } = useParams();
  const v = useView();
  const [type, setType] = React.useState("all");
  const [by, setBy] = React.useState("report");
  const [range, setRange] = React.useState("730");
  const q = useApi("listDiagnosticReports", {
    params: { patientId },
    query: {
      ...(type !== "all" ? { category: type } : {}),
      fromDate: addDaysIso(todayIso(), -Number(range)),
      limit: 200,
    },
  });
  const rows = React.useMemo(
    () =>
      [...(q.data?.data ?? [])].sort((a, b) =>
        (b.issuedAt ?? "9").localeCompare(a.issuedAt ?? "9"),
      ),
    [q.data],
  );
  const groups = React.useMemo(() => {
    const m = new Map<string, DiagnosticReportSummary[]>();
    for (const r of rows) {
      const k = by === "test" ? r.display : monthKey(r.issuedAt);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows, by]);
  const selected = v.view === "report" ? v.id : null;
  const pending = rows.filter((r) => r.status === "REGISTERED" || r.status === "PARTIAL").length;

  return (
    <Page>
      <PageHeader
        title="Results"
        actions={
          <>
            <Tabs value={type} onValueChange={setType} className="mr-6">
              <TabsList aria-label="Type">
                {TYPES.map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    data-testid={tid(S, `type-${t.value}`)}
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs value={by} onValueChange={setBy} className="mr-6">
              <TabsList aria-label="Group">
                <TabsTrigger value="report" data-testid={tid(S, "by-report")}>
                  By report
                </TabsTrigger>
                <TabsTrigger value="test" data-testid={tid(S, "by-test")}>
                  By test
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Select
              value={range}
              onValueChange={setRange}
              options={RANGES}
              aria-label="Range"
              className="w-40"
              testId={tid(S, "range")}
            />
          </>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="p-0" data-testid={tid(S, "report-list")}>
          {q.isLoading ? (
            <div className="p-4">
              <LoadingRows rows={5} />
            </div>
          ) : q.error ? (
            <ErrorState onRetry={() => void q.refetch()} />
          ) : !rows.length ? (
            <EmptyState title="No results in this range" />
          ) : (
            groups.map(([label, list]) => (
              <section key={label}>
                <h3 className="px-4 pb-1 pt-4 text-caption text-ink-2">
                  {label}
                  {by === "test" ? ` · ${list.length}` : ""}
                </h3>
                <ul>
                  {list.map((r) => (
                    <li key={r.id}>
                      <Button
                        variant="ghost"
                        data-testid={tid(S, "report-row")}
                        aria-current={selected === r.id || undefined}
                        onClick={() => v.open("report", r.id)}
                        className={cn(
                          "h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal px-4 py-3 text-left font-normal",
                          selected === r.id && "bg-pine-50 shadow-[inset_2px_0_0_var(--color-ink)]",
                        )}
                      >
                        <b className="font-semibold">{r.display}</b>
                        <span className="flex flex-wrap items-center gap-2 text-small text-ink-2">
                          {r.performer ? `${r.performer} · ` : ""}
                          {r.issuedAt ? formatShortDate(r.issuedAt) : "Not issued"}
                          <Tag tone={r.status === "CORRECTED" ? "caution" : "outline"}>
                            {statusText(r.status)}
                          </Tag>
                          {r.flag && r.flag !== "NORMAL" ? (
                            <Tag tone={r.flag === "CRITICAL" ? "critical" : "neutral"}>
                              {r.flag === "CRITICAL" ? "Critical" : "Abnormal"}
                            </Tag>
                          ) : null}
                          {!r.reviewed && r.status !== "REGISTERED" ? (
                            <span>Not reviewed</span>
                          ) : null}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          {pending ? <p className="px-4 py-3 text-small text-ink-2">{pending} pending</p> : null}
        </Card>
        <Card data-testid={tid(S, "report-pane")}>
          {selected ? (
            <ReportDetail reportId={selected} />
          ) : (
            <EmptyState title="Select a report">
              Choose a result on the left to see its values, trend and original report.
            </EmptyState>
          )}
        </Card>
      </div>
    </Page>
  );
}
