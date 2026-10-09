import * as React from "react";
import { toast } from "sonner";
import type { MedicationRequest, RxCheckResult } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { openBlob } from "@/lib/files";
import { formatDateTime, money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { PDMP_EXCEPTIONS, scheduleLabel } from "./rxParts";

const S = "encounter.rx";
const STATUS: Record<string, string> = {
  preferred: "Preferred",
  "on-formulary": "On formulary",
  "non-formulary": "Not covered",
  unknown: "Unknown",
};

export function CoveragePanel({
  check,
  checking,
  hasRx,
  onSwitch,
}: {
  check: RxCheckResult | null;
  checking: boolean;
  hasRx: boolean;
  onSwitch?: (name: string) => void;
}) {
  const f = check?.formulary;
  return (
    <Card data-testid={tid(S, "coverage")}>
      <CardHeader title={f?.payerName ? `Coverage · ${f.payerName}` : "Coverage"} />
      {!hasRx ? (
        <p className="text-body text-ink-2">Save the draft to check coverage.</p>
      ) : checking && !check ? (
        <p className="text-body text-ink-2">Checking coverage…</p>
      ) : check?.formularyUnavailable ? (
        <p className="text-body" data-testid={tid(S, "formulary")}>
          {check.formularyUnavailable}
        </p>
      ) : f ? (
        <>
          <dl
            className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2"
            data-testid={tid(S, "formulary")}
          >
            <dt className="text-ink-2">Formulary</dt>
            <dd className="font-semibold">
              {STATUS[f.status] ?? f.status}
              {f.tier != null ? ` · tier ${f.tier}` : ""}
            </dd>
            <dt className="text-ink-2">Est. copay</dt>
            <dd className="tabular-nums">
              {f.estimatedCopay ? money(f.estimatedCopay) : "Not available"}
            </dd>
            <dt className="text-ink-2">Prior auth</dt>
            <dd>{f.priorAuthRequired ? "Required" : "Not required"}</dd>
          </dl>
          {f.alternatives.length ? (
            <div className="mt-4 grid gap-2" data-testid={tid(S, "alternatives")}>
              <h4 className="text-label">Covered alternatives</h4>
              {f.alternatives.map((a) => (
                <div key={a} className="flex items-center justify-between gap-2">
                  <span>{a}</span>
                  {onSwitch ? (
                    <Button size="sm" onClick={() => onSwitch(a)}>
                      Switch
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-body text-ink-2">No coverage information.</p>
      )}
    </Card>
  );
}

export interface PdmpState {
  id: string;
  queriedAt?: string;
}

export function PdmpPanel({
  rx,
  patientId,
  pdmp,
  onQueried,
  onException,
  saving,
}: {
  rx: MedicationRequest | null;
  patientId: string;
  pdmp: PdmpState | null;
  onQueried: (p: PdmpState) => void;
  onException: (reason: string) => void;
  saving: boolean;
}) {
  const { me } = useAuth();
  const [busy, setBusy] = React.useState(false);
  const isProvider = !!me?.canSign.prescriptions;
  const connected = !!me?.connectedGateways.includes("PdmpGateway");
  const draft = rx?.status === "DRAFT";
  const query = async () => {
    setBusy(true);
    try {
      const q = await api("queryPdmp", {
        params: { patientId },
        body: { patientId, state: "", purpose: "Prescribing a controlled substance" },
      });
      onQueried({ id: q.id, queriedAt: q.queriedAt });
      toast("PDMP checked.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const report = async () => {
    if (!pdmp) return;
    try {
      openBlob(
        (await api("getPdmpReport", { params: { pdmpQueryId: pdmp.id } })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const btn = (
    <Button
      size="sm"
      disabled={!connected || busy}
      loading={busy}
      onClick={() => void query()}
      data-testid={tid(S, "pdmp-check")}
    >
      {pdmp ? "Check again" : "Check PDMP"}
    </Button>
  );
  return (
    <Card data-testid={tid(S, "pdmp")}>
      <CardHeader title="PDMP" />
      {!rx ? (
        <p className="text-body">Save the draft to see whether a PDMP check is needed.</p>
      ) : !rx.isControlled ? (
        <p className="text-body">Not a controlled substance. No check needed.</p>
      ) : (
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-body">
            <Tag tone="caution">Controlled {scheduleLabel(rx.deaSchedule)}</Tag>
            PDMP review is required before signing.
          </p>
          {pdmp ? (
            <p className="text-body" data-testid={tid(S, "pdmp-status")}>
              {pdmp.queriedAt ? `Checked ${formatDateTime(pdmp.queriedAt)}. ` : "Checked. "}
              <Button
                variant="link"
                onClick={() => void report()}
                data-testid={tid(S, "pdmp-report")}
              >
                View report
              </Button>
            </p>
          ) : rx.pdmpExceptionReason ? (
            <p className="text-body">Exception recorded: {rx.pdmpExceptionReason}</p>
          ) : (
            <p className="text-body text-ink-2">No check recorded.</p>
          )}
          {isProvider && draft ? (
            <>
              {connected ? (
                btn
              ) : (
                <Unavailable reason="The PDMP interface isn't connected, so it can't be checked from here. Record an exception instead.">
                  {btn}
                </Unavailable>
              )}
              <FieldShell label="Record exception" htmlFor="rx-pdmp-exception">
                <Select
                  id="rx-pdmp-exception"
                  value={rx.pdmpExceptionReason ?? ""}
                  disabled={saving}
                  onValueChange={onException}
                  options={PDMP_EXCEPTIONS}
                  placeholder="Choose a reason…"
                  testId={tid(S, "pdmp-exception")}
                />
              </FieldShell>
            </>
          ) : null}
        </div>
      )}
    </Card>
  );
}
