import type { EncounterDetail } from "@agile-emr/shared";
import type { Tx } from "../../db.js";
import { toDto } from "../../platform/dto.js";
import { buildBanner } from "../patients/banner.js";
import { allowedTransitions, appointmentViews } from "../scheduling/views.js";

/**
 * EncounterDetail: the encounter workspace header and section counts. Sections owned by later slices (note,
 * orders, Rx, charges) are attached by their modules through `encounterSections`.
 */
export type SectionLoader = (
  tx: Tx,
  encounterId: string,
) => Promise<
  Partial<Pick<EncounterDetail, "note" | "diagnoses" | "orders" | "prescriptions" | "charges">>
>;
const sectionLoaders: SectionLoader[] = [];
export const registerEncounterSections = (l: SectionLoader) => void sectionLoaders.push(l);

export async function encounterDetail(tx: Tx, encounterId: string): Promise<EncounterDetail> {
  const enc = await tx.encounter.findUniqueOrThrow({
    where: { id: encounterId },
    include: { patient: true, appointment: true },
  });
  const [appt] = enc.appointment ? await appointmentViews(tx, [enc.appointment]) : [];
  const sections = Object.assign(
    { diagnoses: [], orders: [], prescriptions: [], charges: [] },
    ...(await Promise.all(sectionLoaders.map((l) => l(tx, enc.id)))),
  );
  const { patient, appointment: _a, ...row } = enc;
  return {
    ...toDto("Encounter", row),
    ...(appt ? { appointment: appt } : {}),
    patient: await buildBanner(tx, patient),
    ...sections,
    allowedTransitions: enc.appointment ? allowedTransitions(enc.appointment) : [],
  } as EncounterDetail;
}
