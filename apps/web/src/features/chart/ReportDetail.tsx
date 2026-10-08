import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import type { DiagnosticReportDetail, Observation } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { formatDate, formatDateTime, formatShortDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, ErrorState, LoadingRows } from "@/components/ui/layout";
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
import { TrendChart } from "@/components/domain/TrendChart";

const S = "chart.results";
export const REPORT_INVALIDATES = [
  "getDiagnosticReport",
  "listDiagnosticReports",
  "getPatientSummary",
] as const;

const FLAG_MARK = (o: Observation) =>
  o.interpretation && o.interpretation !== "N"
    ? o.interpretation
    : o.flag === "NORMAL"
      ? ""
      : o.flag?.[0];
const valueText = (o: Observation) =>
  o.valueQuantity != null
    ? `${Number(o.valueQuantity)}${o.valueUnit ? ` ${o.valueUnit}` : ""}`
    : (o.valueString ?? (o.valueBoolean != null ? (o.valueBoolean ? "Yes" : "No") : "—"));
const rangeText = (o: Observation) =>
  o.referenceRangeText ??
  (o.referenceRangeLow != null && o.referenceRangeHigh != null
    ? `${Number(o.referenceRangeLow)}–${Number(o.referenceRangeHigh)}`
    : o.referenceRangeHigh != null
      ? `< ${Number(o.referenceRangeHigh)}`
      : o.referenceRangeLow != null
        ? `> ${Number(o.referenceRangeLow)}`
        : "—");

/** chart.results report pane: header, original PDF, release to patient, corrected banner, results table, trend. */
export function ReportDetail({ reportId }: { reportId: string }) {
  const { can } = useAuth();
  const q = useApi("getDiagnosticReport", { params: { diagnosticReportId: reportId } });
  if (q.isLoading) return <LoadingRows rows={6} />;
  if (q.error || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  return (
    <Loaded
      r={q.data}
      canAck={can("acknowledgeCorrection")}
      canRelease={can("releaseResultToPatient")}
    />
  );
}

function Loaded({
  r,
  canAck,
  canRelease,
}: {
  r: DiagnosticReportDetail;
  canAck: boolean;
  canRelease: boolean;
}) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [releasing, setReleasing] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const ack = useApiMutation("acknowledgeCorrection", {
    invalidates: [...REPORT_INVALIDATES],
    onSuccess: () => toast("Correction acknowledged."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const release = useApiMutation("releaseResultToPatient", {
    invalidates: [...REPORT_INVALIDATES],
    onSuccess: () => (toast("Result sent to the patient."), setReleasing(false), setComment("")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pdf = async () => {
    try {
      openBlob(
        (await api("getDiagnosticReportPdf", {
          params: { diagnosticReportId: r.id },
        })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const trendOf = (code: string) => r.priorResults.find((t) => t.code === code);
  /** The point just before this observation in its trend (the "previous" column). */
  const previous = (o: Observation) => {
    const pts = [...(trendOf(o.loincCode)?.points ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    const i = pts.findIndex((p) => p.observationId === o.id);
    return i > 0
      ? pts[i - 1]
      : i === -1
        ? pts.filter((p) => p.observationId !== o.id).at(-1)
        : undefined;
  };
  const wasValue = (o: Observation) =>
    o.previousValueId
      ? r.priorResults.flatMap((t) => t.points).find((p) => p.observationId === o.previousValueId)
          ?.value
      : undefined;
  const corrected = r.status === "CORRECTED";
  const changed = r.observations.filter((o) => o.previousValueId);
  const trendCode =
    selected ??
    changed[0]?.loincCode ??
    r.observations.find((o) => FLAG_MARK(o))?.loincCode ??
    r.observations[0]?.loincCode ??
    null;
  const trend = trendCode ? trendOf(trendCode) : undefined;
  const sel = r.observations.find((o) => o.loincCode === trendCode);
  const needsAck = corrected && !r.correctionAcknowledgedAt;
  const sr = r.serviceRequest;

  return (
    <div className="grid gap-4" data-testid={tid(S, "report-detail")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h2 className="text-h2" data-testid={tid(S, "rep-title")}>
            {r.display}
          </h2>
          <p className="text-small text-ink-2">
            {[
              r.effectiveAt ? `Collected ${formatDateTime(r.effectiveAt)}` : "Not collected yet",
              r.performerLab,
              r.reviewedAt ? `reviewed ${formatDate(r.reviewedAt)}` : "not reviewed yet",
              r.accessionNumber ? `Accession ${r.accessionNumber}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.pdfFileId ? (
            <Button onClick={() => void pdf()} data-testid={tid(S, "rep-pdf")}>
              Original report (PDF)
            </Button>
          ) : (
            <Unavailable reason="The lab didn't send a PDF with this report.">
              <Button disabled>Original report (PDF)</Button>
            </Unavailable>
          )}
          {canRelease && !r.releasedToPortalAt ? (
            <Button onClick={() => setReleasing(true)} data-testid={tid(S, "rep-send")}>
              Send to patient
            </Button>
          ) : r.releasedToPortalAt ? (
            <Tag tone="outline">Sent to patient {formatShortDate(r.releasedToPortalAt)}</Tag>
          ) : null}
        </div>
      </div>
      {r.isCritical ? (
        <Alert tone="critical" title="Critical result." testId={tid(S, "rep-critical")}>
          {r.criticalContacts.length
            ? r.criticalContacts
                .map(
                  (c) =>
                    `${c.reached ? "Reached" : "Not reached"}${c.spokeWith ? ` ${c.spokeWith}` : ""} by ${c.method} on ${formatDateTime(c.contactedAt)}.`,
                )
                .join(" ")
            : "No contact is documented yet. Review it in the results inbox."}
        </Alert>
      ) : null}
      {corrected ? (
        <Alert
          tone="caution"
          testId={tid(S, "rep-corrected")}
          title={`Corrected by lab${r.issuedAt ? ` on ${formatShortDate(r.issuedAt)}` : ""}.`}
          action={
            canAck && needsAck ? (
              <Button
                size="sm"
                variant="primary"
                disabled={ack.isPending}
                data-testid={tid(S, "rep-ack")}
                onClick={() => ack.mutate({ params: { diagnosticReportId: r.id } })}
              >
                Acknowledge correction
              </Button>
            ) : null
          }
        >
          {changed.length
            ? changed
                .map((o) => {
                  const was = wasValue(o);
                  return `${o.display} changed${was != null ? ` from ${was} to ${valueText(o)}` : ` to ${valueText(o)}`}.`;
                })
                .join(" ")
            : "Values were corrected."}{" "}
          {r.reviewedAt ? "The version you reviewed differed." : ""}
          {r.correctionAcknowledgedAt
            ? ` Acknowledged ${formatShortDate(r.correctionAcknowledgedAt)}.`
            : ""}
        </Alert>
      ) : null}
      {sr && sr.status === "RESULTED_PRELIM" ? (
        <p className="flex items-center gap-2 text-small text-ink-2">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden /> Preliminary result; final
          values may change.
        </p>
      ) : null}
      <Card className="p-0" data-testid={tid(S, "rep-table")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Test</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Flag</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Previous</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.observations.map((o) => {
              const prev = previous(o);
              const was = wasValue(o);
              const mark = FLAG_MARK(o);
              return (
                <TableRow
                  key={o.id}
                  className="cursor-pointer"
                  data-state={o.loincCode === trendCode ? "selected" : undefined}
                  onClick={() => setSelected(o.loincCode)}
                >
                  <TableCell className="font-semibold">{o.display}</TableCell>
                  <TableCell className="tabular-nums">
                    <b className={mark ? "font-semibold" : "font-normal"}>{valueText(o)}</b>
                    {corrected && was != null ? (
                      <span className="text-ink-2"> was {was}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {mark ? (
                      <Tag tone={o.flag === "CRITICAL" ? "critical" : "neutral"}>{mark}</Tag>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{rangeText(o)}</TableCell>
                  <TableCell className="tabular-nums">
                    {prev ? `${prev.value} · ${formatShortDate(prev.at)}` : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {r.conclusion ? <p className="px-4 py-3 text-body">{r.conclusion}</p> : null}
      </Card>
      {trendCode ? (
        <Card data-testid={tid(S, "rep-trend")}>
          <CardHeader
            title={`Trend · ${sel?.display ?? trend?.display ?? ""}`}
            actions={
              r.observations.length > 1 ? (
                <Select
                  value={trendCode}
                  onValueChange={setSelected}
                  aria-label="Pick test"
                  className="w-56"
                  options={r.observations.map((o) => ({ value: o.loincCode, label: o.display }))}
                />
              ) : null
            }
          />
          <div className="max-w-xl">
            <TrendChart
              series={[
                {
                  label: trend?.display ?? sel?.display ?? "",
                  points: (trend?.points ?? []).map((p) => ({ at: p.at, value: p.value })),
                },
              ]}
              threshold={
                sel?.referenceRangeHigh != null
                  ? {
                      value: Number(sel.referenceRangeHigh),
                      label: `upper ${Number(sel.referenceRangeHigh)}`,
                    }
                  : undefined
              }
              caption={`${trend?.display ?? sel?.display ?? "Result"}${trend?.unit ? ` (${trend.unit})` : ""} over time${sel?.referenceRangeHigh != null ? `. Dashed line = upper reference ${Number(sel.referenceRangeHigh)}` : ""}`}
            />
          </div>
        </Card>
      ) : null}
      <ConfirmDialog
        open={releasing}
        onOpenChange={setReleasing}
        title="Send this result to the patient?"
        description="It appears in the patient portal with your comment."
        action="Send to patient"
        testId={tid(S, "release-dialog")}
        disabled={release.isPending}
        onConfirm={() =>
          release.mutate({
            params: { diagnosticReportId: r.id },
            body: { release: true, ...(comment.trim() ? { patientComment: comment.trim() } : {}) },
          })
        }
      >
        <FieldShell label="Comment for the patient" className="my-3">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} />
        </FieldShell>
      </ConfirmDialog>
    </div>
  );
}
