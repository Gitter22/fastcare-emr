import { useNavigate } from "react-router-dom";
import type { ScreenId } from "@agile-emr/shared";
import { toast } from "sonner";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";

/** The encounter section each role lands on: MAs room, providers document. */
export function encounterHome(role: string | null): ScreenId {
  const pick: ScreenId = role === "ma" ? "encounter.rooming" : "encounter.note";
  return isBuilt(pick) ? pick : "encounter.note";
}

/**
 * Open the encounter for an appointment (created on first open, shared by pre-charting and rooming) and go to the
 * role's section, or to `section` when given.
 */
export function useOpenEncounter() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const create = useApiMutation("createEncounter", {
    invalidates: ["getPatientSummary", "getProviderWorklist", "getClinicalDayList"],
  });
  const go = (patientId: string, encounterId: string, section?: ScreenId) =>
    navigate(pathTo(section ?? encounterHome(role), { patientId, encounterId }));
  return {
    pending: create.isPending,
    go,
    open: (
      a: {
        patientId: string;
        appointmentId: string;
        practitionerId: string;
        locationId?: string;
        encounterId?: string | null;
      },
      section?: ScreenId,
    ) => {
      if (a.encounterId) return go(a.patientId, a.encounterId, section);
      create.mutate(
        {
          params: { patientId: a.patientId },
          body: {
            patientId: a.patientId,
            class: "AMB",
            practitionerId: a.practitionerId,
            appointmentId: a.appointmentId,
            ...(a.locationId ? { locationId: a.locationId } : {}),
          },
        },
        {
          onSuccess: (enc) => go(a.patientId, enc.id, section),
          onError: (e) => toast.error(errorMessage(e)),
        },
      );
    },
  };
}
