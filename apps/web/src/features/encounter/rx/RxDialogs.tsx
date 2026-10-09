import * as React from "react";
import { toast } from "sonner";
import type { DurAlert, MedicationRequest } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  ConfirmDialog,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { Unavailable } from "@/components/ui/unavailable";
import type { PdmpState } from "./RxSidePanels";
import { RX_INVALIDATES, scheduleLabel } from "./rxParts";

const S = "encounter.rx";

/** Duplicate-therapy style alerts: shown with a checkbox each; acknowledged ids go with the signature. */
export function PassiveAlertsDialog({
  alerts,
  onCancel,
  onContinue,
}: {
  alerts: DurAlert[] | null;
  onCancel: () => void;
  onContinue: (ids: string[]) => void;
}) {
  const [ack, setAck] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setAck(new Set()), [alerts]);
  const list = alerts ?? [];
  return (
    <ConfirmDialog
      open={!!alerts}
      onOpenChange={(o) => !o && onCancel()}
      title="Review before signing"
      description="Acknowledge each notice to continue."
      action="Continue to sign"
      disabled={list.some((a) => !ack.has(a.id))}
      onConfirm={() => onContinue(list.map((a) => a.id))}
      testId={tid(S, "passive-alerts")}
    >
      <div className="my-3 grid gap-3">
        {list.map((a) => (
          <Checkbox
            key={a.id}
            checked={ack.has(a.id)}
            onCheckedChange={(v) =>
              setAck((s) => {
                const n = new Set(s);
                if (v === true) n.add(a.id);
                else n.delete(a.id);
                return n;
              })
            }
            label={a.message}
          />
        ))}
      </div>
    </ConfirmDialog>
  );
}

/** Cancel a draft or a sent prescription, with a reason. */
export function CancelRxDialog({
  rx,
  onClose,
}: {
  rx: MedicationRequest | null;
  onClose: (cancelled?: boolean) => void;
}) {
  const [reason, setReason] = React.useState("");
  React.useEffect(() => setReason(""), [rx?.id]);
  const cancel = useApiMutation("cancelPrescription", {
    invalidates: [...RX_INVALIDATES],
    onSuccess: () => (toast("Prescription cancelled."), onClose(true)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open={!!rx}
      onOpenChange={(o) => !o && onClose()}
      title={`Cancel ${rx?.display ?? "prescription"}?`}
      description={
        rx?.status === "ACTIVE"
          ? "A cancellation is sent to the pharmacy. Say why."
          : "Say why. The reason stays with the prescription."
      }
      action="Cancel prescription"
      danger
      disabled={!reason.trim() || cancel.isPending}
      testId={tid(S, "cancel-dialog")}
      onConfirm={() =>
        rx && cancel.mutate({ params: { medicationRequestId: rx.id }, body: { reason } })
      }
    >
      <FieldShell label="Reason" required className="my-3">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid={tid(S, "cancel-reason")}
        />
      </FieldShell>
    </ConfirmDialog>
  );
}

/** encounter.rx#epcs: blocking modal for controlled substances (INV-SAFE-05). */
export function EpcsDialog({
  rx,
  open,
  pdmp,
  canSign,
  busy,
  error,
  onViewReport,
  onClose,
  onSign,
}: {
  rx: MedicationRequest | null;
  open: boolean;
  pdmp: PdmpState | null;
  canSign: boolean;
  busy: boolean;
  error: string | null;
  onViewReport: () => void;
  onClose: () => void;
  onSign: (token: string) => void;
}) {
  const [ack, setAck] = React.useState(false);
  const [token, setToken] = React.useState("");
  React.useEffect(() => {
    if (open) (setAck(false), setToken(""));
  }, [open]);
  React.useEffect(() => {
    if (error) setToken("");
  }, [error]);
  const ready = ack && /^\d{6}$/.test(token);
  const sign = (
    <Button
      variant="primary"
      disabled={!ready || !canSign || busy}
      loading={busy}
      onClick={() => onSign(token)}
      data-testid={tid(S, "epcs-sign")}
    >
      Sign controlled prescription
    </Button>
  );
  return (
    <AlertDialog open={open && !!rx}>
      <AlertDialogContent className="w-dialog-md" data-testid={tid(S, "epcs")}>
        <AlertDialogTitle>Sign controlled prescription</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <dl
            className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1"
            data-testid={tid(S, "epcs-summary")}
          >
            <dt className="text-ink-2">Drug</dt>
            <dd className="font-semibold">{rx?.display}</dd>
            <dt className="text-ink-2">Quantity</dt>
            <dd className="tabular-nums">
              {rx ? Number(rx.quantity) : ""} {rx?.quantityUnit}
            </dd>
            <dt className="text-ink-2">Refills</dt>
            <dd className="tabular-nums">{rx?.refills}</dd>
            <dt className="text-ink-2">Schedule</dt>
            <dd>{scheduleLabel(rx?.deaSchedule) || "Controlled"}</dd>
          </dl>
        </AlertDialogDescription>
        <div className="grid gap-4">
          <p className="text-body" data-testid={tid(S, "epcs-pdmp")}>
            {pdmp ? (
              <>
                PDMP checked{pdmp.queriedAt ? ` ${formatDateTime(pdmp.queriedAt)}` : ""}.{" "}
                <Button variant="link" onClick={onViewReport}>
                  View report
                </Button>
              </>
            ) : rx?.pdmpExceptionReason ? (
              `PDMP exception: ${rx.pdmpExceptionReason}`
            ) : (
              "No PDMP check or exception is recorded."
            )}
          </p>
          <Checkbox
            checked={ack}
            onCheckedChange={(v) => setAck(v === true)}
            label="PDMP reviewed"
            data-testid={tid(S, "epcs-pdmp-ack")}
          />
          <FieldShell
            label="Second factor code"
            htmlFor="epcs-token"
            hint="6 digits from your authenticator app."
          >
            <Input
              id="epcs-token"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={token}
              onChange={(e) => setToken(e.target.value.replace(/\D/g, ""))}
              data-testid={tid(S, "epcs-token")}
            />
          </FieldShell>
          {error ? <Alert tone="critical">{error}</Alert> : null}
        </div>
        <div className="mt-4 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {canSign ? (
            sign
          ) : (
            <Unavailable reason="You aren't set up for EPCS, so you can't sign controlled prescriptions. Ask an administrator to enroll you.">
              {sign}
            </Unavailable>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
