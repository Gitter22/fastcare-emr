import * as React from "react";
import { toast } from "sonner";
import type { Observation, VitalsInput } from "@agile-emr/shared";
import { LOINC, bmi as _bmi, formatHeight, kgToLb, lbToKg, parseHeight } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { flagMark, latestByCode, readingsByCode, vitalText } from "@/lib/clinical";
import { formatShortDate, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, CardHeader } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";

const S = "encounter.rooming";

type Fields = {
  bp: string;
  pulse: string;
  temp: string;
  resp: string;
  spo2: string;
  height: string;
  weight: string;
  pain: string;
};
const EMPTY: Fields = {
  bp: "",
  pulse: "",
  temp: "",
  resp: "",
  spo2: "",
  height: "",
  weight: "",
  pain: "",
};
const n = (s: string) => (s.trim() === "" ? undefined : Number(s));

/** Parse the form into VitalsInput (US units in, canonical units out) or field errors. */
function toInput(
  f: Fields,
  lastHeightCm: number | null,
): { input?: VitalsInput; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const input: VitalsInput = { takenAt: new Date().toISOString() };
  if (f.bp.trim()) {
    const m = /^(\d{2,3})\s*\/\s*(\d{2,3})$/.exec(f.bp.trim());
    if (m)
      Object.assign(input, {
        systolic: Number(m[1]),
        diastolic: Number(m[2]),
        position: "sitting",
      });
    else errors.bp = "Enter as 120/80.";
  }
  const num = (k: keyof Fields, set: (v: number) => void, int = true) => {
    const v = n(f[k]);
    if (v === undefined) return;
    if (!Number.isFinite(v) || (int && !Number.isInteger(v)))
      errors[k] = int ? "Whole number." : "Number.";
    else set(v);
  };
  num("pulse", (v) => (input.heartRate = v));
  num("temp", (v) => ((input.temperature = v), (input.temperatureUnit = "degf")), false);
  num("resp", (v) => (input.respiratoryRate = v));
  num("spo2", (v) => (input.spo2 = v));
  num("pain", (v) => (input.painScore = v));
  num("weight", (v) => (input.weightKg = lbToKg(v)), false);
  if (f.height.trim()) {
    const cm = parseHeight(f.height);
    if (cm == null) errors.height = "Enter as 5 ft 4 in.";
    else if (!lastHeightCm || Math.abs(cm - lastHeightCm) > 0.5) input.heightCm = cm;
  }
  const any = Object.keys(input).some(
    (k) => k !== "takenAt" && k !== "temperatureUnit" && k !== "position",
  );
  return { input: any && !Object.keys(errors).length ? input : undefined, errors };
}

const SERVER_FIELD: Record<string, keyof Fields> = {
  systolic: "bp",
  diastolic: "bp",
  heartRate: "pulse",
  temperature: "temp",
  respiratoryRate: "resp",
  spo2: "spo2",
  heightCm: "height",
  weightKg: "weight",
  painScore: "pain",
};

export interface VitalsFormHandle {
  /** Save entered values; resolves true when saved or nothing was entered. */
  save: () => Promise<boolean>;
}

/** encounter.rooming vitals: previous value under each field; out-of-range readings alert and can be repeated. */
export const VitalsForm = React.forwardRef<
  VitalsFormHandle,
  { encounterId: string; recorded: Observation[]; previous: Observation[]; disabled?: boolean }
>(function VitalsForm({ encounterId, recorded, previous, disabled }, ref) {
  const [f, setF] = React.useState<Fields>(EMPTY);
  const [errors, setErrors] = React.useState<Partial<Record<keyof Fields, string>>>({});
  const [alerts, setAlerts] = React.useState<string[]>([]);
  const bpRef = React.useRef<HTMLInputElement>(null);
  const prev = latestByCode(previous);
  const mine = latestByCode(recorded);
  const lastHeight = mine.get(LOINC.height) ?? prev.get(LOINC.height);
  const lastHeightCm = lastHeight?.valueQuantity ? Number(lastHeight.valueQuantity) : null;
  React.useEffect(() => {
    if (lastHeightCm && !f.height) setF((x) => ({ ...x, height: formatHeight(lastHeightCm) }));
  }, [lastHeightCm]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = useApiMutation("recordVitals", {
    invalidates: [
      "getRooming",
      "getPatientSummary",
      "getEncounter",
      "getProviderWorklist",
      "getObservationTrend",
      "listObservations",
    ],
  });

  const save = React.useCallback(async () => {
    const { input, errors: e } = toInput(f, lastHeightCm);
    setErrors(e);
    if (Object.keys(e).length) return false;
    if (!input) return true;
    try {
      const r = await record.mutateAsync({ params: { encounterId }, body: input });
      setAlerts(r.alerts);
      setF({ ...EMPTY, height: f.height });
      toast(r.alerts.length ? "Vitals saved. A value is out of range." : "Vitals saved.");
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.problem.errors?.length) {
        const next: Partial<Record<keyof Fields, string>> = {};
        for (const x of err.problem.errors) {
          const k = SERVER_FIELD[x.field.replace(/^body\./, "")];
          if (k) next[k] = x.message;
        }
        setErrors(next);
      } else toast.error(errorMessage(err));
      return false;
    }
  }, [f, lastHeightCm, encounterId, record]);
  React.useImperativeHandle(ref, () => ({ save }), [save]);

  const weightLb = n(f.weight);
  const heightCm = parseHeight(f.height) ?? lastHeightCm;
  const bmiPreview = weightLb && heightCm ? _bmi(lbToKg(weightLb), heightCm) : null;
  const field = (
    k: keyof Fields,
    label: string,
    code: string,
    placeholder?: string,
    inputRef?: React.Ref<HTMLInputElement>,
  ) => {
    const p = prev.get(code);
    return (
      <FieldShell
        label={label}
        htmlFor={`v-${k}`}
        error={errors[k]}
        hint={p ? `${formatShortDate(p.effectiveAt)}: ${vitalText(p, false)}` : "No earlier value"}
      >
        <Input
          ref={inputRef}
          id={`v-${k}`}
          value={f[k]}
          inputMode={k === "bp" || k === "height" ? "text" : "decimal"}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={!!errors[k] || undefined}
          onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
          data-testid={tid(
            S,
            k === "bp" ? "bp" : k === "pulse" ? "pulse" : k === "spo2" ? "spo2" : k,
          )}
          className="tabular-nums"
        />
      </FieldShell>
    );
  };
  const readings = readingsByCode(recorded);
  const times = [...new Set(recorded.map((o) => o.effectiveAt))].sort();
  return (
    <Card data-testid={tid(S, "vitals")}>
      <CardHeader
        title="Vitals"
        actions={
          <span className="text-small text-ink-2">
            Last visit's value is shown under each field
          </span>
        }
      />
      <div className="grid grid-cols-6 gap-4">
        {field("bp", "BP (mmHg)", LOINC.bpPanel, "120/80", bpRef)}
        {field("pulse", "Pulse", LOINC.heartRate)}
        {field("temp", "Temp (°F)", LOINC.temperature)}
        {field("resp", "Resp", LOINC.respiratoryRate)}
        {field("spo2", "SpO₂ (%)", LOINC.spo2)}
        {field("height", "Height", LOINC.height, "5 ft 4 in")}
        {field("weight", "Weight (lb)", LOINC.weight)}
        <FieldShell
          label="BMI"
          hint={
            prev.get(LOINC.bmi)
              ? `${formatShortDate(prev.get(LOINC.bmi)!.effectiveAt)}: ${vitalText(prev.get(LOINC.bmi)!)}`
              : "Calculated"
          }
        >
          <div
            className="flex h-control-md items-center bg-surface-muted px-3 tabular-nums"
            data-testid={tid(S, "bmi")}
          >
            {bmiPreview ?? "—"} <span className="ml-1 text-small text-ink-2">auto</span>
          </div>
        </FieldShell>
        {field("pain", "Pain (0–10)", LOINC.pain)}
      </div>
      {alerts.length ? (
        <Alert
          tone="caution"
          className="mt-4"
          testId={tid(S, "out-of-range")}
          title={alerts.join(" ")}
          action={
            <Button
              size="sm"
              onClick={() => (setAlerts([]), bpRef.current?.focus())}
              data-testid={tid(S, "repeat-reading")}
            >
              Add repeat reading
            </Button>
          }
        >
          Re-measure after 5 minutes seated. Both readings are kept.
        </Alert>
      ) : null}
      {times.length ? (
        <div className="mt-5 grid gap-1" data-testid={tid(S, "recorded")}>
          <h4 className="text-label">Recorded this visit</h4>
          {times.map((t) => (
            <p
              key={t}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body tabular-nums"
            >
              <span className="text-ink-2">{formatTime(t)}</span>
              {[...readings.entries()].flatMap(([code, list]) =>
                list
                  .filter((o) => o.effectiveAt === t)
                  .map((o) => (
                    <span key={o.id} className="inline-flex items-center gap-1">
                      {code === LOINC.bpPanel
                        ? "BP"
                        : code === LOINC.heartRate
                          ? "HR"
                          : code === LOINC.temperature
                            ? "T"
                            : code === LOINC.respiratoryRate
                              ? "RR"
                              : code === LOINC.spo2
                                ? "SpO₂"
                                : code === LOINC.weight
                                  ? "Wt"
                                  : code === LOINC.height
                                    ? "Ht"
                                    : code === LOINC.bmi
                                      ? "BMI"
                                      : "Pain"}{" "}
                      {code === LOINC.weight
                        ? `${kgToLb(Number(o.valueQuantity))} lb`
                        : vitalText(o)}
                      {flagMark(o) ? <Tag tone="critical">{flagMark(o)}</Tag> : null}
                    </span>
                  )),
              )}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
});
