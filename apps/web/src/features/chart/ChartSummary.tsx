import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Info } from "lucide-react";
import type { ChartSummary } from "@agile-emr/shared";
import { LOINC, screens } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { flagMark, latestByCode, vitalText } from "@/lib/clinical";
import { formatDate, formatShortDate, formatTime, pluralize, status } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
} from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import { BreakGlassDialog } from "@/components/domain/BreakGlass";
import { StartEncounterDialog } from "@/features/encounter/StartEncounterDialog";
import { useOpenEncounter } from "@/features/encounter/useOpenEncounter";

const S = "chart.summary";

/** chart.summary: understand the patient in 30 seconds (INV-ID-01 banner above; restricted notes counted, INV-SEC-03). */
export function ChartSummaryPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const summary = useApi("getPatientSummary", { params: { patientId } });
  const [startOpen, setStartOpen] = React.useState(false);
  const [breakGlass, setBreakGlass] = React.useState(false);
  const enc = useOpenEncounter();
  const s = summary.data;

  if (summary.error)
    return (
      <Page>
        <ErrorState onRetry={() => void summary.refetch()} />
      </Page>
    );
  if (!s)
    return (
      <Page>
        <LoadingRows rows={8} />
      </Page>
    );
  const today = s.todayAppointment;
  const deceased = s.banner.flags.includes("deceased");
  const canEncounter = can("createEncounter") && !deceased;

  return (
    <Page>
      <PageHeader
        title="Summary"
        actions={
          <>
            {can("bookAppointment") && isBuilt("schedule.booking-drawer") ? (
              <Button
                onClick={() =>
                  navigate(pathTo("schedule.booking-drawer", {}, undefined, { patientId }))
                }
                data-testid={tid(S, "book")}
                disabled={deceased}
              >
                Book
              </Button>
            ) : null}
            {today && canEncounter ? (
              <Button
                variant="primary"
                disabled={enc.pending}
                data-testid={tid(S, "open-encounter")}
                onClick={() =>
                  enc.open({
                    patientId,
                    appointmentId: today.id,
                    practitionerId: today.practitioner.id,
                    locationId: today.location.id,
                    encounterId: s.todayEncounterId,
                  })
                }
              >
                Open today's encounter
              </Button>
            ) : canEncounter ? (
              <Button
                variant="primary"
                onClick={() => setStartOpen(true)}
                data-testid={tid(S, "start-encounter")}
              >
                Start unscheduled encounter
              </Button>
            ) : null}
          </>
        }
      />
      {today ? (
        <div
          className="-mt-3 flex flex-wrap items-center gap-2 text-body text-ink-2"
          data-testid={tid(S, "today-visit")}
        >
          Today: {today.visitType.name} {formatTime(today.start)} ·
          <StatusChip machine="appointment" value={today.status} />
          {today.room ? <span>· {today.room.name}</span> : null}
        </div>
      ) : null}
      {deceased ? (
        <div
          className="bg-surface-muted px-4 py-3 text-body"
          role="status"
          data-testid={tid(S, "deceased")}
        >
          This patient is recorded as deceased. Scheduling and new encounters are off.
        </div>
      ) : null}
      {s.restrictedHidden ? (
        <div
          className="flex items-center gap-3 bg-surface px-4 py-3 text-body outline-dashed outline-1 -outline-offset-1 outline-ink"
          data-testid={tid(S, "restricted-notice")}
        >
          <Info size={18} strokeWidth={1.75} aria-hidden />
          <span className="flex-1">
            <b>{pluralize(s.restrictedHidden, "restricted note")} hidden</b> · Access needs a reason
            and is logged.
          </span>
          <Button size="sm" onClick={() => setBreakGlass(true)}>
            Request access
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-3 items-start gap-6">
        <ProblemsCard s={s} patientId={patientId} />
        <MedsCard s={s} patientId={patientId} />
        <ResultsCard s={s} />
        <VitalsCard s={s} patientId={patientId} />
        <GapsCard s={s} />
        <VisitsCard s={s} patientId={patientId} />
      </div>
      <StartEncounterDialog patientId={patientId} open={startOpen} onOpenChange={setStartOpen} />
      <BreakGlassDialog
        patientId={patientId}
        open={breakGlass}
        onOpenChange={setBreakGlass}
        testId={tid(S, "break-glass")}
      />
    </Page>
  );
}

function CardLink({
  screen,
  patientId,
  children,
  testId,
}: {
  screen: Parameters<typeof isBuilt>[0];
  patientId: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const { role } = useAuth();
  if (!isBuilt(screen) || !(role && (screenRoles(screen) as string[]).includes(role))) return null;
  return (
    <Link
      to={pathTo(screen, { patientId })}
      className="text-body underline underline-offset-4 hover:text-pine-700"
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

const screenRoles = (id: Parameters<typeof isBuilt>[0]) =>
  screens[id].accessRoles as readonly string[];

function Row({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <li
      className="flex items-baseline justify-between gap-3 border-b border-line py-3 last:border-0"
      data-testid={testId}
    >
      {children}
    </li>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-3 text-body text-ink-2">{children}</p>
);

function ProblemsCard({ s, patientId }: { s: ChartSummary; patientId: string }) {
  return (
    <Card data-testid={tid(S, "card-problems")}>
      <CardHeader
        title="Active problems"
        actions={
          <CardLink screen="chart.problems" patientId={patientId}>
            All
          </CardLink>
        }
      />
      {s.problems.length ? (
        <ul>
          {s.problems.map((p) => (
            <Row key={p.id}>
              <span>
                <b className="font-semibold">{p.display}</b>{" "}
                {p.icd10Code ? (
                  <span className="tabular-nums text-ink-2">{p.icd10Code}</span>
                ) : null}
              </span>
              {p.onsetDate ? (
                <span className="shrink-0 text-small text-ink-2">
                  since {p.onsetDate.slice(0, 4)}
                </span>
              ) : null}
            </Row>
          ))}
        </ul>
      ) : (
        <Empty>No active problems recorded.</Empty>
      )}
    </Card>
  );
}

function MedsCard({ s, patientId }: { s: ChartSummary; patientId: string }) {
  const incoming = s.staged.medications;
  return (
    <Card data-testid={tid(S, "card-meds")}>
      <CardHeader
        title="Medications"
        actions={
          <CardLink screen="chart.medications" patientId={patientId}>
            {incoming ? `Reconcile ${incoming}` : "All"}
          </CardLink>
        }
      />
      {s.medications.length ? (
        <ul>
          {s.medications.slice(0, 6).map((m) => (
            <Row key={m.id}>
              <span>
                <b className="font-semibold">{m.display}</b>
                {m.dosageText ? <span className="text-ink-2"> · {m.dosageText}</span> : null}
              </span>
            </Row>
          ))}
          {s.medications.length > 6 ? (
            <Row>
              <span className="text-ink-2">+ {s.medications.length - 6} more</span>
            </Row>
          ) : null}
          {incoming ? (
            <Row>
              <span className="text-ink-2">+ {incoming} incoming to reconcile</span>
              <Tag tone="outline" className="outline-dashed">
                Not in list yet
              </Tag>
            </Row>
          ) : null}
        </ul>
      ) : (
        <Empty>
          {incoming
            ? `No active medications. ${incoming} incoming to reconcile.`
            : "No active medications recorded."}
        </Empty>
      )}
    </Card>
  );
}

function ResultsCard({ s }: { s: ChartSummary }) {
  return (
    <Card data-testid={tid(S, "card-results")}>
      <CardHeader title="Recent results" />
      {s.recentResults.length ? (
        <ul>
          {s.recentResults.map((r) => (
            <Row key={r.id}>
              <b className="font-semibold">{r.display}</b>
              <span className="flex shrink-0 items-center gap-2 text-small text-ink-2">
                {r.flag !== "NORMAL" ? (
                  <Tag tone="critical">{r.flag === "CRITICAL" ? "Critical" : "Abnormal"}</Tag>
                ) : null}
                {formatShortDate(r.issuedAt)}
              </span>
            </Row>
          ))}
        </ul>
      ) : (
        <Empty>No results on file.</Empty>
      )}
    </Card>
  );
}

function VitalsCard({ s, patientId }: { s: ChartSummary; patientId: string }) {
  const latest = latestByCode(s.recentVitals);
  const when = [...latest.values()]
    .map((o) => o.effectiveAt)
    .sort()
    .at(-1);
  const cell = (code: string, label: string) => {
    const o = latest.get(code);
    const mark = flagMark(o);
    return (
      <div className="grid gap-0.5">
        <span className="text-small text-ink-2">{label}</span>
        <span className="flex items-center gap-1.5 text-h3 tabular-nums">
          {o ? vitalText(o) : "—"}
          {mark ? (
            <Tag tone="critical" aria-label={mark === "H" ? "High" : "Low"}>
              {mark}
            </Tag>
          ) : null}
        </span>
      </div>
    );
  };
  return (
    <Card data-testid={tid(S, "card-vitals")}>
      <CardHeader
        title="Vitals"
        actions={
          <span className="flex items-center gap-3">
            {when ? (
              <span className="text-small text-ink-2">
                {formatShortDate(when)} {formatTime(when)}
              </span>
            ) : null}
            <CardLink screen="chart.vitals" patientId={patientId}>
              Trend
            </CardLink>
          </span>
        }
      />
      {latest.size ? (
        <div className="grid grid-cols-3 gap-x-4 gap-y-4">
          {cell(LOINC.bpPanel, "BP")}
          {cell(LOINC.heartRate, "Pulse")}
          {cell(LOINC.temperature, "Temp")}
          {cell(LOINC.weight, "Weight")}
          {cell(LOINC.bmi, "BMI")}
          {cell(LOINC.spo2, "SpO₂")}
        </div>
      ) : (
        <Empty>No vitals recorded.</Empty>
      )}
    </Card>
  );
}

function GapsCard({ s }: { s: ChartSummary }) {
  const rows = [
    ...s.careGaps.map((g) => ({
      id: g.id,
      label: g.measure.name,
      due: g.dueDate ?? null,
      overdue: !!g.dueDate && g.dueDate < new Date().toISOString().slice(0, 10),
    })),
    ...s.immunizationsDue.map((v) => ({
      id: v.vaccineGroup,
      label: `${v.vaccineGroup} vaccine`,
      due: v.dueDate,
      overdue: v.overdue,
    })),
  ];
  return (
    <Card data-testid={tid(S, "card-gaps")}>
      <CardHeader title="Care gaps" />
      {rows.length ? (
        <ul>
          {rows.map((g) => (
            <Row key={g.id}>
              <span>{g.label}</span>
              {g.overdue ? (
                <Tag tone="caution">Overdue</Tag>
              ) : (
                <Tag tone="outline">
                  Due
                  {g.due && g.due > new Date().toISOString().slice(0, 10)
                    ? ` ${formatDate(g.due)}`
                    : ""}
                </Tag>
              )}
            </Row>
          ))}
        </ul>
      ) : (
        <Empty>Nothing due.</Empty>
      )}
    </Card>
  );
}

function VisitsCard({ s, patientId }: { s: ChartSummary; patientId: string }) {
  const upcoming = s.upcomingAppointments.filter((a) => a.id !== s.todayAppointment?.id);
  return (
    <Card data-testid={tid(S, "card-visits")}>
      <CardHeader
        title="Visits"
        actions={
          <CardLink screen="chart.timeline" patientId={patientId}>
            Timeline
          </CardLink>
        }
      />
      <ul>
        {s.todayAppointment ? (
          <Row>
            <span>
              <b className="font-semibold">Today</b> · {s.todayAppointment.visitType.name} ·{" "}
              {s.todayAppointment.practitioner.name}
            </span>
            <StatusChip machine="appointment" value={s.todayAppointment.status} />
          </Row>
        ) : null}
        {s.recentVisits
          .filter((n) => n.encounterId !== s.todayEncounterId)
          .slice(0, 3)
          .map((n) => (
            <Row key={n.id}>
              <span className="tabular-nums">
                {formatShortDate(n.dateOfService)} · {n.title} · {n.authorName}
              </span>
              <span className="shrink-0 text-small text-ink-2">{status("note", n.status)}</span>
            </Row>
          ))}
        {upcoming.slice(0, 2).map((a) => (
          <Row key={a.id}>
            <span className="tabular-nums">
              Next · {formatShortDate(a.start)} {formatTime(a.start)} · {a.visitType.name}
            </span>
            <StatusChip machine="appointment" value={a.status} />
          </Row>
        ))}
        {!s.todayAppointment && !s.recentVisits.length && !upcoming.length ? (
          <Empty>No visits yet.</Empty>
        ) : null}
      </ul>
    </Card>
  );
}
