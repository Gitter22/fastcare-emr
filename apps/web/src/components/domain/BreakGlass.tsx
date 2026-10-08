import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApiMutation } from "@/lib/api/hooks";
import { errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import { RadioGroup, Select } from "@/components/ui/select";

/**
 * Break-the-glass (INV-SEC-03): time-limited access to restricted records with a stated reason. The request is
 * audited and the privacy officer is alerted; access lapses on its own.
 */
export function BreakGlassDialog({
  patientId,
  open,
  onOpenChange,
  testId,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  testId?: string;
}) {
  const qc = useQueryClient();
  const [category, setCategory] = React.useState<"emergency" | "continuity" | "other">(
    "continuity",
  );
  const [reason, setReason] = React.useState("");
  const [minutes, setMinutes] = React.useState("30");
  const [error, setError] = React.useState<string | null>(null);
  const request = useApiMutation("requestEmergencyAccess", {
    onSuccess: () => {
      toast("Access granted. It ends automatically and has been logged.");
      onOpenChange(false);
      setReason("");
      void qc.invalidateQueries();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const tooShort = reason.trim().length < 10;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-dialog-sm" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>Request access to restricted records?</DialogTitle>
          <DialogDescription>
            Your reason is logged and the privacy officer is notified. Access ends on its own.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FieldShell label="Reason">
            <RadioGroup
              value={category}
              onValueChange={setCategory}
              options={[
                { value: "continuity", label: "Continuity of care" },
                { value: "emergency", label: "Emergency" },
                { value: "other", label: "Other" },
              ]}
            />
          </FieldShell>
          <FieldShell
            label="Why you need it"
            htmlFor="bg-reason"
            hint="A short sentence, e.g. which decision depends on it."
          >
            <Textarea id="bg-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FieldShell>
          <FieldShell label="For how long" htmlFor="bg-minutes">
            <Select
              id="bg-minutes"
              value={minutes}
              onValueChange={setMinutes}
              options={[
                { value: "15", label: "15 minutes" },
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
              ]}
            />
          </FieldShell>
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={tooShort || request.isPending}
            onClick={() =>
              request.mutate({
                params: { patientId },
                body: {
                  reason: reason.trim(),
                  reasonCategory: category,
                  durationMinutes: Number(minutes),
                },
              })
            }
          >
            Request access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
