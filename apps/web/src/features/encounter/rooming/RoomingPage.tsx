import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LOINC } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { TrendChart } from "@/components/domain/TrendChart";
import { Unavailable } from "@/components/ui/unavailable";
import { EncounterBody, useEncounter } from "../EncounterWorkspace";
import { useEncounterField } from "../useEncounterField";
import { Checklist } from "./Checklist";
import { StandingOrders } from "./StandingOrders";
import { VitalsForm, type VitalsFormHandle } from "./VitalsForm";

const S = "encounter.rooming";

/** encounter.rooming (flow:checkin/04-05): capture intake data and hand off to the provider. */
export function RoomingPage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can } = useAuth();
  const navigate = useNavigate();
  const rooming = useApi("getRooming", { params: { encounterId } });
  const cc = useEncounterField("chiefComplaint");
  const words = useEncounterField("patientWords");
  const vitals = React.useRef<VitalsFormHandle>(null);
  const appt = encounter.appointment;
  const ready = useApiMutation("markReadyForProvider", {
    invalidates: ["getEncounter", "getClinicalDayList", "getFlowBoard", "getProviderWorklist"],
    onSuccess: () => {
      toast("Ready for provider.");
      if (isBuilt("home.clinical-daylist")) navigate(pathTo("home.clinical-daylist"));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const closed =
    encounter.status === "FINISHED" ||
    encounter.note?.status === "SIGNED" ||
    encounter.note?.status === "ADDENDED";
  const r = rooming.data;

  const saveAll = async () => {
    const ok = await vitals.current?.save();
    return ok !== false;
  };
  const readyButton = (
    <Button
      variant="primary"
      disabled={appt?.status !== "ROOMED" || ready.isPending}
      data-testid={tid(S, "ready-for-provider")}
      onClick={async () => {
        if (!appt || !(await saveAll())) return;
        ready.mutate({
          params: { appointmentId: appt.id },
          body: { to: "ready-for-provider", version: appt.version },
        });
      }}
    >
      Mark ready for provider
    </Button>
  );
  const actionBar = (
    <>
      <span className="mr-auto text-body text-ink-2">
        {appt?.room ? `${appt.room.name} · ` : ""}
        {appt ? `Appointment ${formatTime(appt.start)}` : "Unscheduled encounter"}
      </span>
      {!closed && can("recordVitals") ? (
        <Button variant="ghost" onClick={() => void saveAll()} data-testid={tid(S, "rooming-save")}>
          Save
        </Button>
      ) : null}
      {appt && can("markReadyForProvider") ? (
        appt.status === "ROOMED" ? (
          readyButton
        ) : (
          <Unavailable
            reason={
              appt.status === "ARRIVED"
                ? "Room the patient first."
                : "The patient is already past rooming."
            }
          >
            {readyButton}
          </Unavailable>
        )
      ) : null}
    </>
  );

  return (
    <EncounterBody
      actionBar={actionBar}
      drawer={
        r ? (
          <RoomingDrawer
            patientId={patientId}
            due={r.vaccinesDue.map((v) => v.vaccineGroup)}
            prechart={encounter.prechartNote ?? null}
          />
        ) : undefined
      }
    >
      {closed ? (
        <Alert>This visit's note is signed. Rooming data can no longer change.</Alert>
      ) : null}
      <Card>
        <CardHeader title="Reason for visit" />
        <div className="grid grid-cols-2 gap-4">
          <FieldShell label="Chief complaint" htmlFor="cc">
            <Input id="cc" {...cc} disabled={closed} data-testid={tid(S, "chief-complaint")} />
          </FieldShell>
          <FieldShell label="Patient's words (optional)" htmlFor="pw">
            <Input id="pw" {...words} disabled={closed} data-testid={tid(S, "patient-words")} />
          </FieldShell>
        </div>
      </Card>
      {r ? (
        <>
          <VitalsForm
            ref={vitals}
            encounterId={encounterId}
            recorded={r.vitals}
            previous={r.previousVitals}
            disabled={closed || !can("recordVitals")}
          />
          <Checklist
            rooming={r}
            patientId={patientId}
            encounterId={encounterId}
            disabled={closed}
          />
          <StandingOrders
            due={r.vaccinesDue}
            patientId={patientId}
            encounterId={encounterId}
            orderedById={encounter.practitionerId}
            disabled={closed}
          />
        </>
      ) : (
        <LoadingRows rows={8} />
      )}
    </EncounterBody>
  );
}

function RoomingDrawer({
  patientId,
  due,
  prechart,
}: {
  patientId: string;
  due: string[];
  prechart: string | null;
}) {
  const trend = useApi("getObservationTrend", {
    params: { patientId },
    query: { loinc: LOINC.systolic },
  });
  const points = (trend.data?.points ?? []).slice(-5);
  const high = Number(trend.data?.referenceRange?.split("-")[1]);
  return (
    <div className="grid gap-6">
      <section className="grid gap-2" data-testid={tid(S, "bp-trend")}>
        <h3 className="text-h3">Blood pressure trend</h3>
        <TrendChart
          series={[
            { label: "Systolic", points: points.map((p) => ({ at: p.at, value: p.value })) },
          ]}
          threshold={Number.isFinite(high) ? { value: high, label: String(high) } : undefined}
          height={150}
          caption={`Systolic, last ${points.length} readings${Number.isFinite(high) ? ` · dashed line = ${high}` : ""}`}
        />
      </section>
      <section className="grid gap-2" data-testid={tid(S, "gaps")}>
        <h3 className="text-h3">Care gaps</h3>
        {due.length ? (
          <ul>
            {due.map((g) => (
              <li
                key={g}
                className="flex items-center justify-between border-b border-line py-2 last:border-0"
              >
                <span>{g} vaccine</span>
                <Tag tone="outline">Due</Tag>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-2">Nothing due.</p>
        )}
      </section>
      <section className="grid gap-2" data-testid={tid(S, "prechart-note")}>
        <h3 className="text-h3">Pre-chart notes</h3>
        <p className="whitespace-pre-wrap text-body">
          {prechart ?? <span className="text-ink-2">None from the provider.</span>}
        </p>
      </section>
      <p className="text-small text-ink-2">
        Trend updated {points.at(-1) ? formatShortDate(points.at(-1)!.at) : "—"}
      </p>
    </div>
  );
}
