import * as React from "react";
import { LOINC } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { flagMark, latestByCode, vitalText } from "@/lib/clinical";
import { formatShortDate, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tag } from "@/components/ui/tag";
import { NoteView } from "./NoteView";
import { useEncounter } from "./EncounterWorkspace";

const S = "encounter.note";
type Tab = "summary" | "alerts" | "prior";

/**
 * encounter-workspace context drawer: Summary · Alerts · Prior note. Alerts are the chart's own derived prompts
 * (vaccines due, items waiting to be reconciled, allergies not reviewed); care-gap measures join in S8.
 */
export function ContextDrawer({ onCopyForward }: { onCopyForward?: () => void }) {
  const { patientId, encounterId } = useEncounter();
  const summary = useApi("getPatientSummary", { params: { patientId } });
  const prior = useApi("listPatientNotes", {
    params: { patientId },
    query: { status: ["SIGNED", "ADDENDED"], limit: 5 },
  });
  const priorNote = prior.data?.data.find((n) => n.encounterId !== encounterId);
  const priorDetail = useApi(
    "getNoteDetail",
    { params: { noteId: priorNote?.id ?? "" } },
    { enabled: !!priorNote },
  );
  const priorDx = useApi(
    "listEncounterDiagnoses",
    { params: { encounterId: priorNote?.encounterId ?? "" } },
    { enabled: !!priorNote },
  );
  const s = summary.data;
  const alerts = React.useMemo(() => {
    if (!s) return [];
    const out: Array<{ id: string; title: string; detail: string }> = [];
    for (const v of s.immunizationsDue)
      out.push({
        id: `vx-${v.vaccineGroup}`,
        title: `${v.vaccineGroup} vaccine ${v.overdue ? "overdue" : "due"}`,
        detail: `Due ${formatShortDate(v.dueDate)}. Standing order: the MA can give it at rooming.`,
      });
    if (s.staged.medications)
      out.push({
        id: "meds",
        title: `${pluralize(s.staged.medications, "medication")} waiting to be reconciled`,
        detail: "Outside or patient-reported items are not in the list until accepted.",
      });
    if (!s.banner.allergies.length && !s.banner.noKnownAllergies)
      out.push({
        id: "allergies",
        title: "Allergies not reviewed",
        detail: "Confirm allergies before prescribing.",
      });
    for (const g of s.careGaps)
      out.push({
        id: g.id,
        title: g.measure.name,
        detail: g.dueDate ? `Due ${formatShortDate(g.dueDate)}` : "Open",
      });
    return out;
  }, [s]);
  const [tab, setTab] = React.useState<Tab>("summary");
  const latest = latestByCode(s?.recentVitals ?? []);

  return (
    <div className="grid gap-4" data-testid={tid(S, "context-drawer")}>
      <div
        role="tablist"
        aria-label="Context"
        className="flex gap-1"
        data-testid={tid(S, "ctx-tabs")}
      >
        {(
          [
            ["summary", "Summary"],
            ["alerts", alerts.length ? `Alerts ${alerts.length}` : "Alerts"],
            [
              "prior",
              priorNote ? `${formatShortDate(priorNote.dateOfService)} note` : "Prior note",
            ],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "h-10 px-3 text-body text-ink-2 hover:text-ink",
              tab === id && "font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "summary" && s ? (
        <div className="grid gap-4" data-testid={tid(S, "ctx-summary")}>
          <section className="grid gap-1">
            <h4 className="text-label">Problems</h4>
            {s.problems.length ? (
              s.problems.map((p) => (
                <p key={p.id} className="text-body">
                  {p.display} <span className="tabular-nums text-ink-2">{p.icd10Code}</span>
                </p>
              ))
            ) : (
              <p className="text-body text-ink-2">None recorded.</p>
            )}
          </section>
          <section className="grid gap-1">
            <h4 className="text-label">Medications</h4>
            {s.medications.length ? (
              s.medications.map((m) => (
                <p key={m.id} className="text-body">
                  {m.display}
                </p>
              ))
            ) : (
              <p className="text-body text-ink-2">None recorded.</p>
            )}
            {s.staged.medications ? (
              <p className="text-small text-ink-2">
                {s.staged.medications} incoming, not reconciled
              </p>
            ) : null}
          </section>
          <section className="grid gap-1">
            <h4 className="text-label">Last vitals</h4>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-body">
              {[
                LOINC.bpPanel,
                LOINC.heartRate,
                LOINC.temperature,
                LOINC.spo2,
                LOINC.weight,
                LOINC.bmi,
              ].map((c) => {
                const o = latest.get(c);
                return o ? (
                  <React.Fragment key={c}>
                    <dt className="text-ink-2">
                      {
                        {
                          [LOINC.bpPanel]: "BP",
                          [LOINC.heartRate]: "Pulse",
                          [LOINC.temperature]: "Temp",
                          [LOINC.spo2]: "SpO₂",
                          [LOINC.weight]: "Weight",
                          [LOINC.bmi]: "BMI",
                        }[c]
                      }
                    </dt>
                    <dd className="flex items-center gap-1 tabular-nums">
                      {vitalText(o)} {flagMark(o) ? <Tag tone="critical">{flagMark(o)}</Tag> : null}
                    </dd>
                  </React.Fragment>
                ) : null;
              })}
            </dl>
          </section>
          <section className="grid gap-1">
            <h4 className="text-label">Recent results</h4>
            {s.recentResults.length ? (
              s.recentResults.map((r) => (
                <p key={r.id} className="text-body">
                  {r.display} <span className="text-ink-2">{formatShortDate(r.issuedAt)}</span>
                </p>
              ))
            ) : (
              <p className="text-body text-ink-2">None on file.</p>
            )}
          </section>
        </div>
      ) : null}
      {tab === "alerts" ? (
        <div className="grid gap-3" data-testid={tid(S, "cds-card")}>
          {alerts.length ? (
            alerts.map((a) => (
              <div key={a.id} className="grid gap-1 bg-surface-muted p-4">
                <b className="font-semibold">{a.title}</b>
                <span className="text-small text-ink-2">{a.detail}</span>
              </div>
            ))
          ) : (
            <p className="text-body text-ink-2">No alerts for this visit.</p>
          )}
        </div>
      ) : null}
      {tab === "prior" ? (
        priorDetail.data ? (
          <div className="grid gap-3" data-testid={tid(S, "ctx-prior-note")}>
            <p className="text-small text-ink-2">
              {priorNote?.title} · {priorNote?.authorName}
            </p>
            {onCopyForward ? (
              <button
                type="button"
                className="justify-self-start text-body underline underline-offset-4 hover:text-pine-700"
                onClick={onCopyForward}
              >
                Copy forward with diff
              </button>
            ) : null}
            <NoteView note={priorDetail.data} diagnoses={priorDx.data ?? []} />
          </div>
        ) : (
          <p className="text-body text-ink-2">
            {prior.isLoading ? "Loading…" : "No earlier signed note."}
          </p>
        )
      ) : null}
    </div>
  );
}
