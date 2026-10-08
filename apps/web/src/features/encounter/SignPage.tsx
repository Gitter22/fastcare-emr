import * as React from "react";
import { useNavigate } from "react-router-dom";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { toast } from "sonner";
import type { ScreenId } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Alert, LoadingRows } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { useEncounter } from "./EncounterWorkspace";
import { NotePage } from "./NotePage";

const S = "encounter.sign";

/** Where each blocker is fixed (spec/ui encounter.sign blocker-fix-*). Unbuilt screens fall back to the note. */
const FIX: Record<string, { label: string; screen: ScreenId }> = {
  ai_text_unaccepted: { label: "Review", screen: "encounter.note" },
  order_without_dx: { label: "Fix", screen: "encounter.orders" },
  unsigned_rx: { label: "Open Rx", screen: "encounter.rx" },
  charge_without_pointer: { label: "Fix", screen: "encounter.charges" },
  note_locked: { label: "Review", screen: "encounter.note" },
  plan_missing: { label: "Open", screen: "encounter.note" },
  unspecified_dx: { label: "Open", screen: "encounter.dx-coding" },
  no_diagnosis: { label: "Open", screen: "encounter.dx-coding" },
  empty_cc: { label: "Open", screen: "encounter.note" },
};

/** encounter.sign (flow:encounter/07): pre-flight blockers, then sign & lock or route for co-sign. */
export function SignPage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can } = useAuth();
  const navigate = useNavigate();
  const pre = useApi(
    "getSignPreflight",
    { params: { encounterId } },
    { enabled: can("getSignPreflight") },
  );
  const note = useApi("getNote", { params: { encounterId } });
  const [attest, setAttest] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const close = () => navigate(pathTo("encounter.note", { patientId, encounterId }));
  const sign = useApiMutation("signNote", {
    invalidates: [
      "getEncounter",
      "getNote",
      "getProviderWorklist",
      "getPatientSummary",
      "listPatientNotes",
      "getFlowBoard",
    ],
    onSuccess: (r) => {
      toast(
        r.note.status === "PENDING_COSIGN"
          ? "Note signed and sent for co-signature."
          : "Note signed.",
      );
      navigate(
        isBuilt("home.provider-worklist")
          ? pathTo("home.provider-worklist")
          : pathTo("encounter.note", { patientId, encounterId }),
      );
    },
    onError: (e) => (setError(errorMessage(e)), void pre.refetch()),
  });
  const p = pre.data;
  const signedAlready =
    note.data && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(note.data.status);
  // INV-ID-03: the chart on screen must be this encounter's patient (the server checks the same id again).
  const contextOk = encounter.patient.id === patientId;
  const fixTarget = (code: string) => {
    const f = FIX[code];
    return f && isBuilt(f.screen) ? f : FIX.note_locked!;
  };
  const go = (screen: ScreenId) => navigate(pathTo(screen, { patientId, encounterId }));
  const blockers = p?.blockers ?? [];
  return (
    <>
      <NotePage />
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent className="w-[680px] p-0" data-testid={tid(S, "dialog")}>
          <div className="grid gap-1 px-7 pb-5 pt-6">
            <span className="text-small text-ink-2">Sign &amp; lock</span>
            <DialogTitle data-testid={tid(S, "sign-title")}>
              {!p
                ? "Checking the note…"
                : blockers.length
                  ? `${blockers.length} ${blockers.length === 1 ? "thing" : "things"} to fix before signing`
                  : "Ready to sign"}
            </DialogTitle>
            <p className="text-body" data-testid={tid(S, "sign-patient")}>
              {encounter.appointment
                ? `${encounter.appointment.visitType.name} visit`
                : "Encounter"}{" "}
              · <b>{encounter.patient.name}</b> · MRN {encounter.patient.mrn} ·{" "}
              {formatDate(
                encounter.periodStart ?? encounter.appointment?.start ?? encounter.createdAt,
              )}
            </p>
          </div>
          <div className="grid max-h-[60vh] gap-5 overflow-y-auto bg-canvas px-7 py-5">
            {!p ? <LoadingRows rows={4} /> : null}
            {signedAlready ? (
              <Alert>This note is already signed. Changes are made as addenda.</Alert>
            ) : null}
            {blockers.length ? (
              <section className="grid gap-2">
                <h3 className="text-label uppercase tracking-wide text-ink-2">Blocking</h3>
                {blockers.map((b) => (
                  <div
                    key={b.code + b.text}
                    className="flex items-center gap-3 bg-surface p-4 shadow-[inset_0_0_0_1.5px_var(--color-ink)]"
                    data-testid={tid(S, "blocker")}
                  >
                    <CircleX
                      size={20}
                      strokeWidth={1.75}
                      aria-label="Blocking"
                      className="shrink-0"
                    />
                    <span className="grid flex-1">
                      <b className="font-semibold">{b.text}</b>
                    </span>
                    <Button
                      size="sm"
                      onClick={() => go(fixTarget(b.code).screen)}
                      data-testid={tid(
                        S,
                        b.code === "ai_text_unaccepted"
                          ? "blocker-fix-note"
                          : b.code === "unsigned_rx"
                            ? "blocker-fix-rx"
                            : "blocker-fix-orders",
                      )}
                    >
                      {fixTarget(b.code).label}
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
            {p?.warnings.length ? (
              <section className="grid gap-2">
                <h3 className="text-label uppercase tracking-wide text-ink-2">
                  Warnings · you can sign with these
                </h3>
                {p.warnings.map((w) => (
                  <div
                    key={w.code + w.text}
                    className="flex items-center gap-3 bg-surface p-4"
                    data-testid={tid(S, "warning")}
                  >
                    <CircleAlert
                      size={20}
                      strokeWidth={1.75}
                      aria-label="Warning"
                      className="shrink-0"
                    />
                    <span className="flex-1">{w.text}</span>
                    {FIX[w.code] && isBuilt(FIX[w.code]!.screen) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => go(FIX[w.code]!.screen)}
                        data-testid={tid(S, "warning-open")}
                      >
                        Open
                      </Button>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}
            {p ? (
              <section className="grid gap-2" data-testid={tid(S, "passed-check")}>
                <h3 className="text-label uppercase tracking-wide text-ink-2">Passed</h3>
                {[
                  ...(contextOk ? ["Patient on screen matches this encounter"] : []),
                  ...p.passed,
                ].map((t) => (
                  <p key={t} className="flex items-center gap-3 text-body text-ink-2">
                    <CircleCheck size={20} strokeWidth={1.75} aria-hidden />
                    {t}
                  </p>
                ))}
              </section>
            ) : null}
            {p && !blockers.length && !signedAlready ? (
              <Checkbox
                checked={attest}
                onCheckedChange={(v) => setAttest(v === true)}
                label={
                  p.requiresCosign
                    ? `I attest this note is accurate and complete. It goes to ${p.cosigner?.name ?? "my supervisor"} for co-signature.`
                    : "I attest this note is accurate and complete."
                }
                data-testid={tid(S, "attest")}
              />
            ) : null}
            {error ? <Alert tone="caution">{error}</Alert> : null}
          </div>
          <div className="flex items-center gap-3 px-7 py-4">
            <span className="mr-auto text-small text-ink-2">
              After signing, the note is locked. Changes become addenda.
            </span>
            <Button variant="ghost" onClick={close} data-testid={tid(S, "back-to-note")}>
              Back to note
            </Button>
            {can("signNote") && !signedAlready ? (
              <Button
                variant="primary"
                disabled={!p?.canSign || !attest || !contextOk || sign.isPending || !note.data}
                data-testid={tid(S, p?.requiresCosign ? "route-cosign" : "sign-lock")}
                onClick={() =>
                  note.data &&
                  sign.mutate({
                    params: { noteId: note.data.id },
                    body: {
                      version: note.data.version,
                      patientId,
                      attest,
                      acknowledgedWarnings: p?.warnings.map((w) => w.code) ?? [],
                    },
                  })
                }
              >
                {p?.requiresCosign ? "Sign & route for co-sign" : "Sign & lock"}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
