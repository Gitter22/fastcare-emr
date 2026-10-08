import * as React from "react";
import { z } from "zod";
import { useMe } from "@/app/auth";
import { useApi } from "@/lib/api/hooks";
import { errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelectField, TextField, useZodForm } from "@/components/ui/form";
import { Alert } from "@/components/ui/layout";
import { useApiMutation } from "@/lib/api/hooks";
import { useOpenEncounter } from "./useOpenEncounter";

const schema = z
  .object({
    class: z.enum(["AMB", "PHONE", "VR", "ASYNC"]),
    practitionerId: z.string().min(1, "Choose the provider."),
    locationId: z.string(),
    reason: z.string().trim().min(3, "Give the reason in a few words.").max(500),
  })
  .refine((v) => v.class !== "AMB" || v.locationId, {
    path: ["locationId"],
    message: "Choose the location.",
  });

/** chart.summary start-encounter: an unscheduled phone, portal, video or walk-in encounter. */
export function StartEncounterDialog({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const me = useMe();
  const practitioners = useApi("listPractitioners", { query: {} }, { enabled: open });
  const { go } = useOpenEncounter();
  const [error, setError] = React.useState<string | null>(null);
  const form = useZodForm(schema, {
    defaultValues: {
      class: "PHONE",
      practitionerId: me.user.practitionerId ?? "",
      locationId: me.activeLocationId ?? "",
      reason: "",
    },
  });
  const create = useApiMutation("createEncounter", {
    invalidates: ["getPatientSummary", "getPatientTimeline"],
    onSuccess: (enc) => (onOpenChange(false), go(patientId, enc.id, "encounter.note")),
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = form.handleSubmit((v) =>
    create.mutate({
      params: { patientId },
      body: {
        patientId,
        class: v.class,
        practitionerId: v.practitionerId,
        ...(v.locationId ? { locationId: v.locationId } : {}),
        reason: v.reason,
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-dialog-sm" data-testid="chart.summary/start-encounter-dialog">
        <DialogHeader>
          <DialogTitle>Start an encounter?</DialogTitle>
        </DialogHeader>
        <form id="start-encounter" onSubmit={submit} className="grid gap-4">
          <SelectField
            form={form}
            name="class"
            label="Type"
            options={[
              { value: "PHONE", label: "Phone" },
              { value: "ASYNC", label: "Portal" },
              { value: "VR", label: "Video" },
              { value: "AMB", label: "Walk-in (office)" },
            ]}
          />
          <SelectField
            form={form}
            name="practitionerId"
            label="Provider"
            options={(practitioners.data ?? [])
              .filter((p) => p.npi)
              .map((p) => ({
                value: p.id,
                label: `${p.firstName} ${p.lastName}${p.credential ? `, ${p.credential}` : ""}`,
              }))}
          />
          <SelectField
            form={form}
            name="locationId"
            label="Location"
            options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
          />
          <TextField form={form} name="reason" label="Reason" required />
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="start-encounter"
            disabled={create.isPending}
          >
            Start encounter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
