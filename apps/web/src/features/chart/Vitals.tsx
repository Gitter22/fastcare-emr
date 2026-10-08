import * as React from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import type { Observation } from "@agile-emr/shared";
import { LOINC } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiAll, useApiMutation } from "@/lib/api/hooks";
import { VITAL_LABEL, flagMark, vitalText } from "@/lib/clinical";
import { formatShortDate, formatTime, todayIso, addDaysIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Page, PageHeader } from "@/components/ui/layout";
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
import { TrendChart } from "@/components/domain/TrendChart";
import { useOpenEncounter } from "@/features/encounter/useOpenEncounter";

const S = "chart.vitals";
const ROWS = [
  LOINC.bpPanel,
  LOINC.heartRate,
  LOINC.temperature,
  LOINC.respiratoryRate,
  LOINC.spo2,
  LOINC.height,
  LOINC.weight,
  LOINC.bmi,
  LOINC.pain,
];
const RANGES = [
  { value: "90", label: "Last 3 months" },
  { value: "365", label: "Last year" },
  { value: "1825", label: "Last 5 years" },
];

/** chart.vitals: vitals by date (columns) and type (rows), flags, and the trend of the selected row. */
export function VitalsPage() {
  const { patientId = "" } = useParams();
  const { can } = useAuth();
  const [range, setRange] = React.useState("365");
  const [selected, setSelected] = React.useState<string>(LOINC.bpPanel);
  const today = todayIso();
  const obs = useApiAll("listObservations", {
    params: { patientId },
    query: { category: "VITAL_SIGNS", fromDate: addDaysIso(today, -Number(range)) },
  });
  const devices = useApi("listObservations", {
    params: { patientId },
    query: { stagingStatus: "STAGED", limit: 50 },
  });
  const summary = useApi("getPatientSummary", { params: { patientId } });
  const enc = useOpenEncounter();
  const accept = useApiMutation("acceptObservations", {
    invalidates: ["listObservations", "getPatientSummary"],
    onSuccess: () => toast("Readings added to the chart."),
    onError: (e) => toast.error(errorMessage(e)),
  });

  // One column per visit (encounter), else per half hour; repeat readings stay in their column.
  const columns = React.useMemo(() => {
    const cols = new Map<string, { at: string; byCode: Map<string, Observation[]> }>();
    for (const o of [...((obs.data ?? []) as Observation[])].sort((a, b) =>
      a.effectiveAt.localeCompare(b.effectiveAt),
    )) {
      const key =
        o.encounterId ?? String(Math.floor(new Date(o.effectiveAt).getTime() / 1_800_000));
      const col = cols.get(key) ?? { at: o.effectiveAt, byCode: new Map<string, Observation[]>() };
      col.byCode.set(o.loincCode, [...(col.byCode.get(o.loincCode) ?? []), o]);
      cols.set(key, col);
    }
    return [...cols.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  }, [obs.data]);

  const trend = React.useMemo(() => {
    const list = ((obs.data ?? []) as Observation[]).filter((o) => o.loincCode === selected);
    if (selected === LOINC.bpPanel) {
      const c = (o: Observation, k: "systolic" | "diastolic") =>
        (o.components as { systolic?: number; diastolic?: number } | null)?.[k];
      return [
        {
          label: "Systolic",
          points: list
            .filter((o) => c(o, "systolic") != null)
            .map((o) => ({ at: o.effectiveAt, value: c(o, "systolic")! })),
        },
        {
          label: "Diastolic",
          dashed: true,
          points: list
            .filter((o) => c(o, "diastolic") != null)
            .map((o) => ({ at: o.effectiveAt, value: c(o, "diastolic")! })),
        },
      ];
    }
    return [
      {
        label: VITAL_LABEL[selected] ?? selected,
        points: list
          .filter((o) => o.valueQuantity != null)
          .map((o) => ({
            at: o.effectiveAt,
            value: Number(vitalText(o, false)) || Number(o.valueQuantity),
          })),
      },
    ];
  }, [obs.data, selected]);

  const todayAppt = summary.data?.todayAppointment;
  return (
    <Page>
      <PageHeader
        title="Vitals"
        actions={
          <>
            <Select
              value={range}
              onValueChange={setRange}
              options={RANGES}
              aria-label="Range"
              testId={tid(S, "vitals-range")}
              className="w-44"
            />
            <Select
              value="vitals"
              onValueChange={() => undefined}
              aria-label="Flowsheet"
              testId={tid(S, "flowsheet-picker")}
              className="w-56"
              options={[
                { value: "vitals", label: "Vitals" },
                { value: "bp-log", label: "Home BP log (remote monitoring)", disabled: true },
                { value: "glucose-log", label: "Glucose log (remote monitoring)", disabled: true },
              ]}
            />
            {todayAppt && can("recordVitals") ? (
              <Button
                variant="primary"
                data-testid={tid(S, "add-vitals")}
                disabled={enc.pending}
                onClick={() =>
                  enc.open(
                    {
                      patientId,
                      appointmentId: todayAppt.id,
                      practitionerId: todayAppt.practitioner.id,
                      locationId: todayAppt.location.id,
                      encounterId: summary.data?.todayEncounterId,
                    },
                    "encounter.rooming",
                  )
                }
              >
                Record vitals
              </Button>
            ) : null}
          </>
        }
      />
      {devices.data?.data.length ? (
        <Card data-testid={tid(S, "device-readings")}>
          <CardHeader
            title={`Device readings · ${devices.data.data.length} not in the chart yet`}
            actions={
              <Button
                onClick={() =>
                  accept.mutate({
                    params: { patientId },
                    body: { ids: devices.data!.data.map((d) => d.id) },
                  })
                }
                disabled={accept.isPending}
              >
                Accept all
              </Button>
            }
          />
          <ul className="grid gap-2 text-body">
            {devices.data.data.map((d) => (
              <li key={d.id} className="tabular-nums">
                {formatShortDate(d.effectiveAt)} {formatTime(d.effectiveAt)} ·{" "}
                {VITAL_LABEL[d.loincCode] ?? d.display} {vitalText(d)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        {columns.length ? (
          <Table data-testid={tid(S, "vitals-grid")}>
            <TableHeader>
              <TableRow>
                <TableHead>Measurement</TableHead>
                {columns.map((c) => (
                  <TableHead key={c.at} className="text-right tabular-nums">
                    {formatShortDate(c.at)}
                    <span className="block text-caption font-normal">{formatTime(c.at)}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((code) => (
                <TableRow
                  key={code}
                  data-state={selected === code ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => setSelected(code)}
                  aria-selected={selected === code}
                >
                  <TableCell className="font-semibold">{VITAL_LABEL[code]}</TableCell>
                  {columns.map((c) => {
                    const readings = c.byCode.get(code) ?? [];
                    return (
                      <TableCell key={c.at} className="text-right tabular-nums">
                        {readings.length ? (
                          <span className="grid justify-items-end">
                            {readings.map((o) => (
                              <span key={o.id} className="flex items-center gap-1">
                                {vitalText(o)}
                                {flagMark(o) ? <Tag tone="critical">{flagMark(o)}</Tag> : null}
                              </span>
                            ))}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-6 text-body text-ink-2">
            {obs.isLoading ? "Loading…" : "No vitals in this range."}
          </p>
        )}
      </Card>
      <Card className="max-w-3xl">
        <CardHeader title={`${VITAL_LABEL[selected] ?? ""} trend`} />
        <TrendChart
          testId={tid(S, "vitals-chart")}
          series={trend}
          caption={
            selected === LOINC.bpPanel
              ? "Systolic (solid) and diastolic (dotted), mmHg"
              : `${VITAL_LABEL[selected] ?? ""} over the selected range`
          }
        />
      </Card>
    </Page>
  );
}
