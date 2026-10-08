import * as React from "react";
import { toast } from "sonner";
import type { EncounterUpdate } from "@agile-emr/shared";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { useEncounter } from "./EncounterWorkspace";

type TextField = "chiefComplaint" | "patientWords" | "prechartNote" | "followUpInstruction";

/**
 * A free-text encounter field edited in place and saved on blur (merge-patch with If-Match). Returns input props.
 * A version conflict reloads the encounter and keeps what the user typed so nothing is lost.
 */
export function useEncounterField(field: TextField) {
  const { encounter, encounterId } = useEncounter();
  const server = (encounter[field] as string | null | undefined) ?? "";
  const [value, setValue] = React.useState(server);
  const editing = React.useRef(false);
  React.useEffect(() => {
    if (!editing.current) setValue(server);
  }, [server]);
  const save = useApiMutation("updateEncounter", {
    invalidates: ["getEncounter", "getRooming", "getPrechart"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  return {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => (
      (editing.current = true),
      setValue(e.target.value)
    ),
    onBlur: () => {
      editing.current = false;
      if (value.trim() === server.trim()) return;
      save.mutate({
        params: { encounterId },
        version: encounter.version,
        body: { [field]: value.trim() || null } as EncounterUpdate,
      });
    },
  };
}
