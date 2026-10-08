import { toast } from "sonner";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDateTime, formatShortDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { ContextDrawer } from "./ContextDrawer";
import { EncounterBody, useEncounter } from "./EncounterWorkspace";
import { useEncounterField } from "./useEncounterField";

const S = "encounter.prechart";

/** encounter.prechart (flow:access/07): prepare the visit before the patient arrives. */
export function PrechartPage() {
  const { encounter, encounterId } = useEncounter();
  const { can } = useAuth();
  const pre = useApi("getPrechart", { params: { encounterId } });
  const note = useEncounterField("prechartNote");
  const done = useApiMutation("markPrecharted", {
    invalidates: ["getEncounter", "getProviderWorklist", "getClinicalDayList"],
    onSuccess: () => toast("Marked pre-charted."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const p = pre.data;
  const actionBar = (
    <>
      <span className="mr-auto text-body text-ink-2">
        {encounter.prechartedAt
          ? `Pre-charted ${formatDateTime(encounter.prechartedAt)}`
          : "Not pre-charted yet"}
      </span>
      {can("markPrecharted") ? (
        <Button
          variant="primary"
          disabled={done.isPending}
          onClick={() => done.mutate({ params: { encounterId } })}
          data-testid={tid(S, "prechart-done")}
        >
          {encounter.prechartedAt ? "Mark pre-charted again" : "Mark pre-charted"}
        </Button>
      ) : null}
    </>
  );
  return (
    <EncounterBody actionBar={actionBar} drawer={<ContextDrawer />}>
      {!p ? (
        <LoadingRows rows={8} />
      ) : (
        <>
          {p.reasonForVisit ? (
            <Card>
              <CardHeader title="Reason for visit" />
              <p className="text-body">{p.reasonForVisit}</p>
            </Card>
          ) : null}
          <Card data-testid={tid(S, "since-last")}>
            <CardHeader title="Since the last visit" />
            {p.sinceLastVisit.length ? (
              <ul>
                {p.sinceLastVisit.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0"
                  >
                    <span>
                      <b className="font-semibold">{i.title}</b>
                      {i.summary ? <span className="text-ink-2"> · {i.summary}</span> : null}
                    </span>
                    <span className="shrink-0 text-small tabular-nums text-ink-2">
                      {formatShortDate(i.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-ink-2">Nothing new since the last visit.</p>
            )}
            {p.questionnaires.length ? (
              <p className="mt-3 text-body text-ink-2">
                {p.questionnaires.length} questionnaire{p.questionnaires.length === 1 ? "" : "s"}{" "}
                completed since then.
              </p>
            ) : null}
          </Card>
          <Card data-testid={tid(S, "open-gaps")}>
            <CardHeader title="Due at this visit" />
            {p.dueImmunizations.length || p.careGaps.length ? (
              <ul>
                {p.dueImmunizations.map((v) => (
                  <li
                    key={v.vaccineGroup}
                    className="flex items-center justify-between border-b border-line py-2 last:border-0"
                    data-testid={tid(S, "standing-orders")}
                  >
                    <span>
                      {v.vaccineGroup} vaccine{v.doseNumber ? `, dose ${v.doseNumber}` : ""}
                    </span>
                    <Tag tone={v.overdue ? "caution" : "outline"}>
                      {v.overdue ? "Overdue" : "Due"}
                    </Tag>
                  </li>
                ))}
                {p.careGaps.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between border-b border-line py-2 last:border-0"
                  >
                    <span>{g.measure.name}</span>
                    <Tag tone="outline">Open</Tag>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-ink-2">Nothing due.</p>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Outside records"
              actions={
                <Unavailable reason="Outside record queries need the health information exchange, which isn't connected yet.">
                  <Button disabled data-testid={tid(S, "outside-records")}>
                    Query HIE
                  </Button>
                </Unavailable>
              }
            />
            {p.stagedOutside.length ? (
              <p className="text-body">
                {p.stagedOutside.length} patient-submitted change
                {p.stagedOutside.length === 1 ? "" : "s"} waiting for front-desk review.
              </p>
            ) : (
              <p className="text-body text-ink-2">No outside records waiting.</p>
            )}
          </Card>
          <Card>
            <FieldShell
              label="Note for the MA"
              htmlFor="prechart-note"
              hint="Shown on the rooming screen. Saved when you leave the field."
            >
              <Textarea
                id="prechart-note"
                {...note}
                disabled={!can("updateEncounter")}
                data-testid={tid(S, "prechart-note")}
              />
            </FieldShell>
          </Card>
        </>
      )}
    </EncounterBody>
  );
}
