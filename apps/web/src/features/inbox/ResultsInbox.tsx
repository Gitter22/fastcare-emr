import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { ResultFlag, ResultInboxItem } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDate, formatDateTime, formatShortDate, pluralize } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { TrendChart } from "@/components/domain/TrendChart";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
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
import { InboxLayout } from "./InboxLayout";
import { Pressable } from "@/components/ui/pressable";

const S = "inbox.results";

export const FlagTag = ({ flag }: { flag: ResultFlag | null | undefined }) =>
  flag === "CRITICAL" ? (
    <Tag tone="critical">Critical</Tag>
  ) : flag === "ABNORMAL" ? (
    <Tag tone="caution">Abnormal</Tag>
  ) : (
    <Tag tone="outline">Normal</Tag>
  );

/** inbox.results: results awaiting review, critical first (INV-SAFE-04, INV-SAFE-01). */
export function ResultsInboxPage() {
  const v = useView();
  const { can } = useAuth();
  const counts = useApi("getInboxCounts", undefined);
  const [scope, setScope] = React.useState<string>("me");
  const query = { assignee: scope as "me" | "my-pools" };
  const list = useApi("listResultsToReview", { query }, { refetchInterval: 60_000 });
  const items = list.data?.data ?? [];
  const selected = items.find((i) => i.report.id === v.id) ?? items[0] ?? null;
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [failures, setFailures] = React.useState<
    Array<{ id: string; code: string; detail: string }>
  >([]);
  const bulk = useApiMutation("reviewResultsBulk", {
    invalidates: ["listResultsToReview", "getInboxCounts"],
    onSuccess: (r) => {
      toast(`${pluralize(r.succeeded.length, "result")} signed.`);
      setFailures(r.failed);
      setChecked(new Set());
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pools = counts.data?.byPool ?? [];
  const scopeOptions = [
    { value: "me", label: "Assigned to me" },
    { value: "my-pools", label: "My work pools" },
  ];
  const nameOf = (id: string) => items.find((i) => i.report.id === id)?.patient.name ?? id;
  const normalIds = items.filter((i) => i.report.flag === "NORMAL").map((i) => i.report.id);
  const toggle = (id: string, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <InboxLayout>
      <Card className="p-0" data-testid={tid(S, "result-item")}>
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-5">
          <h2 className="text-h3" data-testid={tid(S, "items-title")}>
            {pluralize(items.length, "result")} to review
          </h2>
          {can("reviewResultsBulk") ? (
            <Button
              size="sm"
              disabled={!checked.size || bulk.isPending}
              onClick={() => bulk.mutate({ body: { ids: [...checked] } })}
              data-testid={tid(S, "sign-normals")}
            >
              Sign normal results{checked.size ? ` (${checked.size})` : ""}
            </Button>
          ) : null}
        </div>
        {pools.length ? (
          <div className="px-5 pb-3">
            <Select
              value={scope}
              onValueChange={setScope}
              options={scopeOptions}
              aria-label="Whose results"
            />
          </div>
        ) : null}
        {failures.length ? (
          <div className="px-5 pb-3">
            <Alert tone="caution" title="Not signed:" testId={tid(S, "bulk-failures")}>
              <ul>
                {failures.map((f) => (
                  <li key={f.id}>
                    {nameOf(f.id)}: {f.detail}
                  </li>
                ))}
              </ul>
            </Alert>
          </div>
        ) : null}
        {list.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!list.isLoading && !items.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">No results waiting for review.</p>
        ) : null}
        <ul>
          {items.map((i) => (
            <ResultRow
              key={i.report.id}
              item={i}
              active={selected?.report.id === i.report.id}
              selectable={can("reviewResultsBulk") && normalIds.includes(i.report.id)}
              checked={checked.has(i.report.id)}
              onCheck={(on) => toggle(i.report.id, on)}
              onOpen={() => v.open("report", i.report.id)}
            />
          ))}
        </ul>
      </Card>
      {selected ? <ResultDetail key={selected.report.id} item={selected} /> : <span />}
    </InboxLayout>
  );
}

function ResultRow({
  item,
  active,
  selectable,
  checked,
  onCheck,
  onOpen,
}: {
  item: ResultInboxItem;
  active: boolean;
  selectable: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
}) {
  const r = item.report;
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-5 py-3 hover:bg-surface-hover",
        active && "bg-pine-50",
      )}
    >
      <div className="w-[18px] pt-0.5">
        {selectable ? (
          <Checkbox
            checked={checked}
            onCheckedChange={(c) => onCheck(c === true)}
            aria-label={`Select ${item.patient.name}`}
          />
        ) : null}
      </div>
      <Pressable
        type="button"
        onClick={onOpen}
        className="grid min-w-0 flex-1 gap-0.5 text-left"
        data-testid={tid(S, "ri-patient")}
      >
        <span className="flex items-center justify-between gap-2">
          <b className="truncate font-semibold">{item.patient.name}</b>
          <FlagTag flag={r.flag} />
        </span>
        <span className="text-small tabular-nums text-ink-2">
          DOB {formatDate(item.patient.birthDate)} · MRN {item.patient.mrn}
        </span>
        <span className="text-small text-ink-2">
          {r.display} · {formatShortDate(r.issuedAt)} · {item.orderingProvider}
        </span>
        {r.status === "CORRECTED" || r.status === "AMENDED" ? (
          <span className="text-small font-semibold text-ink">Corrected result</span>
        ) : null}
      </Pressable>
    </li>
  );
}

function ResultDetail({ item }: { item: ResultInboxItem }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const id = item.report.id;
  const q = useApi("getDiagnosticReport", { params: { diagnosticReportId: id } });
  const d = q.data;
  const [comment, setComment] = React.useState("");
  const [patientComment, setPatientComment] = React.useState("");
  const [release, setRelease] = React.useState(false);
  const [fuKind, setFuKind] = React.useState<"" | "task" | "order" | "appointment">("");
  const [fuDetail, setFuDetail] = React.useState("");
  const [contactOpen, setContactOpen] = React.useState<null | boolean>(null);
  const done = ["listResultsToReview", "getInboxCounts", "getDiagnosticReport"] as const;
  const review = useApiMutation("reviewResult", {
    invalidates: [...done],
    onSuccess: () => toast("Result signed and closed."),
    onError: (e) =>
      toast.error(
        e instanceof ApiError && e.code === "critical_contact_required"
          ? "Record a reached contact for this critical result before signing."
          : errorMessage(e),
      ),
  });
  const ack = useApiMutation("acknowledgeCorrection", {
    invalidates: [...done],
    onSuccess: () => toast("Correction acknowledged."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rel = useApiMutation("releaseResultToPatient", {
    invalidates: [...done],
    onSuccess: () => toast("Result released to the patient."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const critical = item.critical || d?.isCritical === true;
  const reached = !!d?.criticalContacts.some((c) => c.reached);
  const needsContact = critical && !reached;
  const corrected =
    (d?.status === "CORRECTED" || d?.status === "AMENDED") && !d?.correctionAcknowledgedAt;
  const reviewed = !!d?.reviewedAt || item.report.reviewed;
  const p = item.patient;
  const trendFor = (code: string) => d?.priorResults.find((t) => t.code === code);

  const sign = (
    <Button
      variant="primary"
      size="sm"
      disabled={!d || needsContact || review.isPending || reviewed}
      onClick={() =>
        d &&
        review.mutate({
          params: { diagnosticReportId: id },
          body: {
            version: d.version,
            comment: comment.trim() || undefined,
            patientComment: patientComment.trim() || undefined,
            release: release || undefined,
            followUp:
              fuKind && fuDetail.trim() ? { kind: fuKind, detail: fuDetail.trim() } : undefined,
          },
        })
      }
      data-testid={tid(S, "rd-sign")}
    >
      Sign & close
    </Button>
  );
  return (
    <Card data-testid={tid(S, "rd-patient")}>
      <CardHeader
        title={`${p.name} · ${item.report.display}`}
        actions={
          isBuilt("chart.results") ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(pathTo("chart.results", { patientId: p.id }))}
              data-testid={tid(S, "rd-open-chart")}
            >
              Open chart
            </Button>
          ) : null
        }
      />
      <p className="mb-4 text-small tabular-nums text-ink-2">
        DOB {formatDate(p.birthDate)} · MRN {p.mrn} · ordered by {item.orderingProvider} · reported{" "}
        {formatDateTime(item.report.issuedAt)}
      </p>
      {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : null}
      {!d ? <LoadingRows rows={6} /> : null}
      {d ? (
        <div className="grid gap-5">
          {corrected ? (
            <Alert
              tone="caution"
              title="Corrected result."
              testId={tid(S, "corrected")}
              action={
                can("acknowledgeCorrection") ? (
                  <Button
                    size="sm"
                    disabled={ack.isPending}
                    onClick={() => ack.mutate({ params: { diagnosticReportId: id } })}
                  >
                    Acknowledge correction
                  </Button>
                ) : null
              }
            >
              The lab changed this report after it was first issued. Review the new values.
            </Alert>
          ) : null}
          {critical ? (
            <div
              className="grid gap-3 bg-danger-bg p-4 text-danger-ink"
              data-testid={tid(S, "rd-contact")}
            >
              <div className="flex items-center justify-between gap-3">
                <b className="font-semibold">Critical result · patient contact</b>
                {can("recordCriticalContact") ? (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setContactOpen(true)}
                      data-testid={tid(S, "rd-record-contact")}
                    >
                      Record contact
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setContactOpen(false)}
                      data-testid={tid(S, "rd-attempt")}
                    >
                      Couldn&apos;t reach · log attempt
                    </Button>
                  </span>
                ) : null}
              </div>
              {d.criticalContacts.length ? (
                <ul className="grid gap-1 text-body">
                  {d.criticalContacts.map((c) => (
                    <li key={c.id}>
                      {c.reached ? "Reached" : "Not reached"}
                      {c.spokeWith ? ` · ${c.spokeWith}` : ""} · {enumLabel(c.method)} ·{" "}
                      {formatDateTime(c.contactedAt)}
                      {c.readBack ? " · read back" : ""}
                      {c.instructions ? ` · ${c.instructions}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body">No contact recorded yet.</p>
              )}
              {needsContact ? (
                <p className="text-body font-semibold">
                  Sign-off needs a documented contact with the patient or caregiver.
                </p>
              ) : null}
            </div>
          ) : null}
          <Table data-testid={tid(S, "rd-table")}>
            <TableHeader>
              <TableRow>
                <TableHead>Test</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Previous</TableHead>
                <TableHead>Flag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.observations.map((o) => {
                const prior = trendFor(o.loincCode)?.points.filter((x) => x.observationId !== o.id);
                const last = prior?.[prior.length - 1];
                return (
                  <TableRow key={o.id}>
                    <TableCell>{o.display}</TableCell>
                    <TableCell className="tabular-nums">
                      {o.valueQuantity ?? o.valueString ?? "—"} {o.valueUnit ?? ""}
                    </TableCell>
                    <TableCell className="tabular-nums">{o.referenceRangeText ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">
                      {last ? `${last.value} (${formatShortDate(last.at)})` : "—"}
                    </TableCell>
                    <TableCell>
                      <FlagTag flag={o.flag} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {d.priorResults
            .filter((t) => t.points.length > 1)
            .map((t) => (
              <div key={t.code} className="grid gap-1">
                <b className="text-small font-semibold">
                  {t.display}
                  {t.unit ? ` (${t.unit})` : ""}
                </b>
                <TrendChart
                  caption={`${t.display} over time`}
                  series={[{ label: t.display, points: t.points }]}
                />
              </div>
            ))}
          {d.conclusion ? <p className="text-body">{d.conclusion}</p> : null}
          {can("reviewResult") && !reviewed ? (
            <div className="grid gap-4">
              <FieldShell label="Comment (shared with patient)" htmlFor="rd-comment">
                <Textarea
                  id="rd-comment"
                  value={patientComment}
                  onChange={(e) => setPatientComment(e.target.value)}
                  data-testid={tid(S, "rd-comment")}
                />
              </FieldShell>
              <FieldShell label="Internal note" htmlFor="rd-internal">
                <Textarea
                  id="rd-internal"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </FieldShell>
              <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3">
                <FieldShell label="Follow-up" htmlFor="rd-fu-kind">
                  <Select
                    id="rd-fu-kind"
                    value={fuKind}
                    onValueChange={(k) => setFuKind(k as typeof fuKind)}
                    options={[
                      { value: "task", label: "Task" },
                      { value: "order", label: "Order" },
                      { value: "appointment", label: "Appointment" },
                    ]}
                    placeholder="None"
                  />
                </FieldShell>
                <FieldShell label="Follow-up detail" htmlFor="rd-fu-detail">
                  <Input
                    id="rd-fu-detail"
                    value={fuDetail}
                    disabled={!fuKind}
                    onChange={(e) => setFuDetail(e.target.value)}
                  />
                </FieldShell>
              </div>
              <Checkbox
                checked={release}
                onCheckedChange={(c) => setRelease(c === true)}
                label="Release to the patient portal"
              />
              <div className="flex justify-end">
                {needsContact ? (
                  <Unavailable
                    reason="Record a reached contact with the patient first (critical result)."
                    testId={tid(S, "rd-sign-unavailable")}
                  >
                    {sign}
                  </Unavailable>
                ) : (
                  sign
                )}
              </div>
            </div>
          ) : null}
          {reviewed ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-body text-ink-2">
                Reviewed {formatDateTime(d.reviewedAt)}
                {item.report.released ? " · released to the patient" : ""}
              </span>
              {can("releaseResultToPatient") && !item.report.released ? (
                <Button
                  size="sm"
                  disabled={rel.isPending}
                  onClick={() =>
                    rel.mutate({ params: { diagnosticReportId: id }, body: { release: true } })
                  }
                >
                  Release to patient
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {contactOpen !== null ? (
        <ContactDialog
          reportId={id}
          initialReached={contactOpen}
          onClose={() => setContactOpen(null)}
        />
      ) : null}
    </Card>
  );
}

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function ContactDialog({
  reportId,
  initialReached,
  onClose,
}: {
  reportId: string;
  initialReached: boolean;
  onClose: () => void;
}) {
  const [reached, setReached] = React.useState(initialReached ? "yes" : "no");
  const [spokeWith, setSpokeWith] = React.useState("");
  const [method, setMethod] = React.useState<"phone" | "in-person" | "voicemail" | "portal">(
    initialReached ? "phone" : "voicemail",
  );
  const [at, setAt] = React.useState(localNow());
  const [instructions, setInstructions] = React.useState("");
  const [readBack, setReadBack] = React.useState(false);
  const rec = useApiMutation("recordCriticalContact", {
    invalidates: ["getDiagnosticReport", "listResultsToReview"],
    onSuccess: () => (toast("Contact recorded."), onClose()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const isReached = reached === "yes";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-dialog-sm" data-testid={tid(S, "contact-dialog")}>
        <DialogHeader>
          <DialogTitle>
            {isReached ? "Document patient contact" : "Log contact attempt"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <RadioGroup
            value={reached}
            onValueChange={setReached}
            aria-label="Reached"
            options={[
              { value: "yes", label: "Reached" },
              { value: "no", label: "Not reached" },
            ]}
          />
          <FieldShell
            label="Spoke with"
            htmlFor="cc-who"
            hint="Patient, caregiver, or other clinician."
          >
            <Input id="cc-who" value={spokeWith} onChange={(e) => setSpokeWith(e.target.value)} />
          </FieldShell>
          <FieldShell label="How" htmlFor="cc-method">
            <Select
              id="cc-method"
              value={method}
              onValueChange={setMethod}
              options={[
                { value: "phone", label: "Phone" },
                { value: "in-person", label: "In person" },
                { value: "voicemail", label: "Voicemail" },
                { value: "portal", label: "Portal" },
              ]}
            />
          </FieldShell>
          <FieldShell label="When" htmlFor="cc-at">
            <Input
              id="cc-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </FieldShell>
          <FieldShell label="Instructions given" htmlFor="cc-instr">
            <Textarea
              id="cc-instr"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </FieldShell>
          <Checkbox
            checked={readBack}
            onCheckedChange={(c) => setReadBack(c === true)}
            label="Read back confirmed"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!at || rec.isPending || (isReached && !spokeWith.trim())}
            onClick={() =>
              rec.mutate({
                params: { diagnosticReportId: reportId },
                body: {
                  diagnosticReportId: reportId,
                  reached: isReached,
                  spokeWith: spokeWith.trim() || undefined,
                  method,
                  contactedAt: new Date(at).toISOString(),
                  instructions: instructions.trim() || undefined,
                  readBack,
                },
              })
            }
            data-testid={tid(S, "contact-save")}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
