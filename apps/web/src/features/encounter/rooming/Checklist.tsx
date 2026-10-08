import * as React from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { toast } from "sonner";
import type { Questionnaire, QuestionnaireResponse, RoomingView } from "@agile-emr/shared";
import { LOINC, POC_TESTS, TOBACCO_STATUS } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, CardHeader } from "@/components/ui/layout";
import { RadioGroup, Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const S = "encounter.rooming";
const INVALIDATES = ["getRooming", "getPatientSummary", "getProviderWorklist"] as const;

type QItem = {
  linkId: string;
  text: string;
  answerOption?: Array<{ code: string; display: string; score?: number }>;
};
type Scoring = { bands: Array<{ min: number; label: string; positive?: boolean }> };
const band = (q: Questionnaire | undefined, score: number) =>
  [...((q?.scoring as Scoring | null)?.bands ?? [])]
    .sort((a, b) => b.min - a.min)
    .find((b) => score >= b.min);

/** encounter.rooming intake checklist (flow:checkin/04): allergies, med rec, PHQ, tobacco, SDOH, POC tests. */
export function Checklist({
  rooming,
  patientId,
  encounterId,
  disabled,
}: {
  rooming: RoomingView;
  patientId: string;
  encounterId: string;
  disabled?: boolean;
}) {
  const { can } = useAuth();
  const qns = useApi("listQuestionnaires", { query: {} }, { staleTime: 300_000 });
  const tobacco = useApi("listObservations", {
    params: { patientId },
    query: { loinc: LOINC.tobacco, limit: 1 },
  });
  const pocs = useApi("listObservations", {
    params: { patientId },
    query: { category: "POINT_OF_CARE", limit: 20 },
  });
  const [form, setForm] = React.useState<Questionnaire | null>(null);
  const [poc, setPoc] = React.useState(false);
  const review = useApiMutation("recordAllergyReview", {
    invalidates: [...INVALIDATES, "getPatient"],
    onSuccess: () => toast("Allergies reviewed, no changes."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const social = useApiMutation("recordSocialHistory", {
    invalidates: [...INVALIDATES, "listObservations"],
    onSuccess: () => toast("Tobacco use recorded."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const byLoinc = (code: string) => qns.data?.find((q) => q.loincCode === code);
  const last = (codes: string[]): { r: QuestionnaireResponse; q: Questionnaire } | null => {
    for (const r of rooming.screenings) {
      const q = qns.data?.find((x) => x.id === r.questionnaireId);
      if (q?.loincCode && codes.includes(q.loincCode)) return { r, q };
    }
    return null;
  };
  const done = (k: string) => rooming.checklist.find((c) => c.key === k)?.done ?? false;
  const depression = last([LOINC.phq2, LOINC.phq9]);
  const sdoh = last([LOINC.sdoh]);
  const encPocs = (pocs.data?.data ?? []).filter((o) => o.encounterId === encounterId);
  const t = tobacco.data?.data[0];
  const count = rooming.checklist.filter((c) => c.done).length;
  const rows: Array<{
    key: string;
    testId: string;
    done: boolean;
    title: React.ReactNode;
    sub?: React.ReactNode;
    action?: React.ReactNode;
  }> = [
    {
      key: "allergies",
      testId: "allergies-reviewed",
      done: done("allergies"),
      title: done("allergies") ? "Allergies reviewed" : "Allergy review",
      sub:
        done("allergies") && rooming.allergiesReviewedAt
          ? formatTime(rooming.allergiesReviewedAt)
          : "Ask about new allergies or reactions",
      action: done("allergies") ? null : (
        <span className="flex gap-2">
          {isBuilt("chart.allergies") ? (
            <Button size="sm" variant="ghost" asChild>
              <Link to={pathTo("chart.allergies", { patientId })}>Open allergies</Link>
            </Button>
          ) : null}
          {can("recordAllergyReview") ? (
            <Button
              size="sm"
              disabled={disabled || review.isPending}
              onClick={() =>
                review.mutate({
                  params: { patientId },
                  body: { reviewedAt: new Date().toISOString() },
                })
              }
            >
              No changes
            </Button>
          ) : null}
        </span>
      ),
    },
    {
      key: "medications",
      testId: "med-rec",
      done: done("medications"),
      title: "Medication reconciliation",
      sub:
        done("medications") && rooming.medicationsReviewedAt
          ? formatTime(rooming.medicationsReviewedAt)
          : "Confirm each medication with the patient",
      action:
        done("medications") || !isBuilt("chart.medications") ? null : (
          <Button size="sm" asChild>
            <Link to={pathTo("chart.medications", { patientId })}>Reconcile</Link>
          </Button>
        ),
    },
    {
      key: "depression",
      testId: "phq",
      done: done("depression"),
      title: depression
        ? `${depression.q.name} · score ${Number(depression.r.score)} (${band(depression.q, Number(depression.r.score))?.label.toLowerCase() ?? "scored"})`
        : "Depression screening (PHQ-2)",
      sub: depression
        ? `${depression.r.source === "PATIENT_REPORTED" ? "Portal" : "Recorded"} ${formatShortDate(depression.r.authoredAt)}`
        : "Due yearly",
      action:
        depression &&
        band(depression.q, Number(depression.r.score))?.positive &&
        depression.q.loincCode === LOINC.phq2 &&
        byLoinc(LOINC.phq9) ? (
          <Button size="sm" disabled={disabled} onClick={() => setForm(byLoinc(LOINC.phq9)!)}>
            Start PHQ-9
          </Button>
        ) : !depression && byLoinc(LOINC.phq2) ? (
          <Button size="sm" disabled={disabled} onClick={() => setForm(byLoinc(LOINC.phq2)!)}>
            Start
          </Button>
        ) : null,
    },
    {
      key: "tobacco",
      testId: "tobacco",
      done: done("tobacco"),
      title: t ? `Tobacco · ${t.valueString?.toLowerCase() ?? ""}` : "Tobacco use",
      sub: t ? formatShortDate(t.effectiveAt) : "Ask and record",
      action: can("recordSocialHistory") ? (
        <Select
          aria-label="Tobacco"
          value=""
          placeholder={t ? "Update" : "Choose"}
          className="w-56"
          disabled={disabled || social.isPending}
          testId={tid(S, "tobacco")}
          onValueChange={(code) => {
            const s = TOBACCO_STATUS.find((x) => x.code === code)!;
            social.mutate({
              params: { patientId },
              body: {
                patientId,
                encounterId,
                category: "SOCIAL_HISTORY",
                loincCode: LOINC.tobacco,
                display: "Tobacco smoking status",
                effectiveAt: new Date().toISOString(),
                valueCode: s.code,
                valueString: s.display,
              },
            });
          }}
          options={TOBACCO_STATUS.map((s) => ({ value: s.code, label: s.display }))}
        />
      ) : null,
    },
    {
      key: "sdoh",
      testId: "sdoh",
      done: done("sdoh"),
      title: sdoh
        ? `SDOH screening · ${band(sdoh.q, Number(sdoh.r.score))?.label.toLowerCase() ?? "done"}`
        : "SDOH screening",
      sub: sdoh ? formatShortDate(sdoh.r.authoredAt) : "Due yearly",
      action:
        !sdoh && byLoinc(LOINC.sdoh) ? (
          <Button size="sm" disabled={disabled} onClick={() => setForm(byLoinc(LOINC.sdoh)!)}>
            Start
          </Button>
        ) : null,
    },
    {
      key: "poc",
      testId: "poc-test",
      done: encPocs.length > 0,
      title: encPocs.length
        ? `Point-of-care: ${encPocs.map((o) => `${o.display} ${o.valueString ?? o.valueQuantity ?? ""}${o.valueUnit ? ` ${o.valueUnit}` : ""}`).join(", ")}`
        : "Point-of-care test",
      sub: encPocs.length
        ? formatTime(encPocs[0]!.effectiveAt)
        : "Glucose, strep, urine and others",
      action: can("recordPocResult") ? (
        <Button size="sm" disabled={disabled} onClick={() => setPoc(true)}>
          Record
        </Button>
      ) : null,
    },
  ];
  return (
    <Card data-testid={tid(S, "checklist")}>
      <CardHeader
        title="Intake checklist"
        actions={
          <span className="text-small text-ink-2">
            {count} of {rooming.checklist.length} done
          </span>
        }
      />
      <ul>
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-center gap-4 border-b border-line py-3 last:border-0"
            data-testid={tid(S, r.testId)}
          >
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full border-2 border-ink",
                r.done && "bg-ink text-on-primary",
              )}
              aria-label={r.done ? "Done" : "Not done"}
            >
              {r.done ? <Check size={14} strokeWidth={2.5} /> : null}
            </span>
            <span className="grid flex-1">
              <span className="text-body">{r.title}</span>
              {r.sub ? <span className="text-small text-ink-2">{r.sub}</span> : null}
            </span>
            {r.action}
          </li>
        ))}
      </ul>
      {form ? (
        <QuestionnaireDrawer
          q={form}
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setForm(null)}
          onPhq9={() => setForm(byLoinc(LOINC.phq9) ?? null)}
        />
      ) : null}
      <PocDrawer open={poc} encounterId={encounterId} onClose={() => setPoc(false)} />
    </Card>
  );
}

function QuestionnaireDrawer({
  q,
  patientId,
  encounterId,
  onClose,
  onPhq9,
}: {
  q: Questionnaire;
  patientId: string;
  encounterId: string;
  onClose: () => void;
  onPhq9: () => void;
}) {
  const items = (q.items ?? []) as QItem[];
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const score = items.reduce(
    (sum, i) => sum + (i.answerOption?.find((o) => o.code === answers[i.linkId])?.score ?? 0),
    0,
  );
  const complete = items.every((i) => !i.answerOption || answers[i.linkId]);
  const b = band(q, score);
  const submit = useApiMutation("submitQuestionnaireResponse", {
    invalidates: [...INVALIDATES, "listQuestionnaireResponses"],
    onSuccess: (r) => {
      toast(`${q.name} saved · score ${Number(r.score)}.`);
      if (q.loincCode === LOINC.phq2 && b?.positive) onPhq9();
      else onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="w-[620px]">
        <SheetHeader>
          <SheetTitle>{q.name}</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-5">
          {q.purpose === "screening" ? (
            <p className="text-body text-ink-2">
              Over the last 2 weeks, how often has the patient been bothered by the following?
            </p>
          ) : null}
          {items.map((i, n) => (
            <FieldShell key={i.linkId} label={`${n + 1}. ${i.text}`}>
              <RadioGroup
                aria-label={i.text}
                value={answers[i.linkId]}
                onValueChange={(v) => setAnswers((a) => ({ ...a, [i.linkId]: v }))}
                orientation={
                  i.answerOption && i.answerOption.length <= 2 ? "horizontal" : "vertical"
                }
                testId={tid(S, "q-items")}
                options={(i.answerOption ?? []).map((o) => ({ value: o.code, label: o.display }))}
              />
            </FieldShell>
          ))}
          <div
            className="flex items-baseline gap-3 bg-surface-muted px-4 py-3"
            data-testid={tid(S, "q-score")}
          >
            <span className="text-body text-ink-2">Score</span>
            <b className="text-h3 tabular-nums">{score}</b>
            {complete && b ? (
              <span className="text-body">{b.label}</span>
            ) : (
              <span className="text-body text-ink-2">Answer every question</span>
            )}
          </div>
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!complete || submit.isPending}
            onClick={() =>
              submit.mutate({
                params: { patientId },
                body: { questionnaireId: q.id, patientId, encounterId, answers },
              })
            }
            data-testid={tid(S, "q-save")}
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function PocDrawer({
  open,
  encounterId,
  onClose,
}: {
  open: boolean;
  encounterId: string;
  onClose: () => void;
}) {
  const [loinc, setLoinc] = React.useState("");
  const [value, setValue] = React.useState("");
  const [lot, setLot] = React.useState("");
  const [flag, setFlag] = React.useState<"NORMAL" | "ABNORMAL" | "CRITICAL">("NORMAL");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(
    () => (setLoinc(""), setValue(""), setLot(""), setFlag("NORMAL"), setError(null)),
    [open],
  );
  const test = POC_TESTS.find((t) => t.loinc === loinc);
  const save = useApiMutation("recordPocResult", {
    invalidates: [...INVALIDATES, "listObservations"],
    onSuccess: (o) => (toast(`${o.display} recorded.`), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Point-of-care test</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          <FieldShell label="Test" required>
            <Select
              value={loinc}
              onValueChange={(v) => (setLoinc(v), setValue(""))}
              aria-label="Test"
              testId={tid(S, "poc-test-type")}
              options={POC_TESTS.map((t) => ({ value: t.loinc, label: t.display }))}
            />
          </FieldShell>
          {test ? (
            <FieldShell
              label={`Result${test.unit ? ` (${test.unit})` : ""}`}
              required
              htmlFor="poc-result"
            >
              {test.options ? (
                <Select
                  value={value}
                  onValueChange={(v) => (
                    setValue(v),
                    setFlag(v === "Negative" ? "NORMAL" : "ABNORMAL")
                  )}
                  aria-label="Result"
                  testId={tid(S, "poc-result")}
                  options={test.options.map((o) => ({ value: o, label: o }))}
                />
              ) : (
                <Input
                  id="poc-result"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="tabular-nums"
                  data-testid={tid(S, "poc-result")}
                />
              )}
            </FieldShell>
          ) : null}
          {test && !test.options ? (
            <FieldShell label="Interpretation">
              <Select
                value={flag}
                onValueChange={setFlag}
                aria-label="Interpretation"
                options={[
                  { value: "NORMAL", label: "Normal" },
                  { value: "ABNORMAL", label: "Abnormal" },
                  { value: "CRITICAL", label: "Critical" },
                ]}
              />
            </FieldShell>
          ) : null}
          <FieldShell label="Kit lot" htmlFor="poc-lot">
            <Input
              id="poc-lot"
              value={lot}
              onChange={(e) => setLot(e.target.value)}
              data-testid={tid(S, "poc-lot")}
            />
          </FieldShell>
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!test || !value.trim() || save.isPending}
            data-testid={tid(S, "poc-save")}
            onClick={() =>
              save.mutate({
                params: { encounterId },
                body: {
                  loinc,
                  value: value.trim(),
                  ...(test?.unit ? { unit: test.unit } : {}),
                  interpretation: flag,
                  ...(lot.trim() ? { lotNumber: lot.trim() } : {}),
                  performedAt: new Date().toISOString(),
                },
              })
            }
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
