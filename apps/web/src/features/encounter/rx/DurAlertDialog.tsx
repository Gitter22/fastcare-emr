import * as React from "react";
import type { DurAlert, OperationId } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Alert } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";

const S = "encounter.rx";

/** Override reasons offered at the alert (stored with the override and reportable, INV-SAFE-06). */
export const OVERRIDE_REASONS = [
  "Patient has tolerated this drug before",
  "Reaction was an intolerance, not an allergy",
  "Benefit outweighs risk; will monitor",
  "No suitable alternative",
  "Dose adjusted for the interaction",
] as const;

const KIND: Record<string, string> = {
  DRUG_ALLERGY: "Allergy alert",
  DRUG_DRUG: "Interaction alert",
  DUPLICATE_THERAPY: "Duplicate therapy",
  DOSE: "Dose alert",
  DRUG_CONDITION: "Drug-condition alert",
};

type Evidence = {
  allergy?: string;
  reaction?: string | null;
  recordedAt?: string;
  verificationStatus?: string;
  with?: string;
  effect?: string;
};

export interface DurAlertDialogProps {
  /** A pending interruptive alert; null closes the dialog. */
  alert: DurAlert | null;
  /** Covered alternatives from the formulary check (may be empty). */
  alternatives?: string[];
  /** Replace the drug in the composer. Omitted where the drug can't be switched (no Switch buttons). */
  onSwitch?: (alternative: string) => void;
  /** Called after the decision is stored. */
  onDecided: (outcome: "overridden" | "removed") => void;
  /** Invalidated after a decision (the screen's prescription list). */
  invalidates?: OperationId[];
}

/**
 * Interruptive DUR alert (encounter.rx#alert, INV-SAFE-06). Blocking: the only ways out are switching the drug,
 * removing the prescription, or overriding with a reason, which is stored and reportable.
 */
export function DurAlertDialog({
  alert,
  alternatives = [],
  onSwitch,
  onDecided,
  invalidates,
}: DurAlertDialogProps) {
  const [reason, setReason] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setReason("");
    setError(null);
  }, [alert?.id]);
  const decide = useApiMutation("decideDurAlert", {
    invalidates: [
      "listEncounterPrescriptions",
      "listRxRequests",
      "getRxRequest",
      ...(invalidates ?? []),
    ],
    onError: (e) => setError(errorMessage(e)),
  });
  if (!alert) return null;
  const ev = (alert.evidence ?? {}) as Evidence;
  const submit = (action: "override" | "cancel") =>
    decide.mutate(
      {
        params: { durAlertId: alert.id },
        body: { action, ...(action === "override" ? { reason } : {}) },
      },
      { onSuccess: () => onDecided(action === "override" ? "overridden" : "removed") },
    );

  return (
    <AlertDialog open>
      <AlertDialogContent
        className="w-dialog-md! gap-0 overflow-hidden p-0"
        data-testid={tid(S, "alert")}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3 bg-danger-bg p-5 text-danger-ink">
          <span
            aria-hidden
            className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-danger font-semibold text-surface"
          >
            !
          </span>
          <div>
            <p className="text-small">{KIND[alert.type] ?? "Alert"} · prescription stopped</p>
            <AlertDialogTitle className="text-danger-ink" data-testid={tid(S, "alert-title")}>
              {alert.message}
            </AlertDialogTitle>
          </div>
        </div>
        <div className="grid gap-5 p-5">
          <AlertDialogDescription asChild>
            <dl
              className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2"
              data-testid={tid(S, "alert-evidence")}
            >
              {ev.allergy ? (
                <>
                  <dt className="text-ink-2">Recorded allergy</dt>
                  <dd>
                    <span className="font-semibold">{ev.allergy}</span>
                    {ev.reaction ? ` · ${ev.reaction}` : ""}
                  </dd>
                  <dt className="text-ink-2">Source</dt>
                  <dd>
                    {ev.recordedAt ? `Recorded ${formatDate(ev.recordedAt)}` : "Allergy list"}
                    {ev.verificationStatus ? ` · ${ev.verificationStatus.toLowerCase()}` : ""}
                  </dd>
                </>
              ) : null}
              {ev.with ? (
                <>
                  <dt className="text-ink-2">Interacts with</dt>
                  <dd className="font-semibold">{ev.with}</dd>
                </>
              ) : null}
              {ev.effect ? (
                <>
                  <dt className="text-ink-2">Effect</dt>
                  <dd>{ev.effect}</dd>
                </>
              ) : null}
            </dl>
          </AlertDialogDescription>

          {onSwitch && alternatives.length ? (
            <section className="grid gap-2">
              <h3 className="text-h3">Covered alternatives</h3>
              {alternatives.map((alt, i) => (
                <div
                  key={alt}
                  className="flex items-center justify-between gap-3 rounded-md border border-line p-3"
                  data-testid={tid(S, "alert-alternative")}
                >
                  <span className="font-semibold">{alt}</span>
                  <Button
                    size="sm"
                    variant={i === 0 ? "primary" : "secondary"}
                    onClick={() => onSwitch(alt)}
                    data-testid={tid(S, "alert-switch")}
                  >
                    Switch to this
                  </Button>
                </div>
              ))}
            </section>
          ) : null}

          <section className="grid gap-2 border-t border-line pt-4">
            <h3 className="text-h3">Prescribe anyway</h3>
            <FieldShell label="Reason for override (required, reported)" htmlFor="dur-reason">
              <Select
                id="dur-reason"
                value={reason}
                onValueChange={setReason}
                placeholder="Choose a reason…"
                options={OVERRIDE_REASONS.map((r) => ({ value: r, label: r }))}
                testId={tid(S, "alert-reason")}
              />
            </FieldShell>
          </section>
          {error ? <Alert tone="critical">{error}</Alert> : null}
        </div>
        <div className="flex justify-between gap-3 border-t border-line p-4">
          <Button
            variant="secondary"
            onClick={() => submit("cancel")}
            disabled={decide.isPending}
            data-testid={tid(S, "alert-remove")}
          >
            Remove prescription
          </Button>
          <Button
            onClick={() => submit("override")}
            disabled={!reason || decide.isPending}
            data-testid={tid(S, "alert-override")}
          >
            Override and continue
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
