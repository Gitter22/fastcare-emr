import type { Ctx } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { notFound } from "../../platform/problem.js";

/** An encounter the caller may see: tenant via RLS, then the patient's access rules (merged, restricted). */
export async function loadEncounter(ctx: Ctx, encounterId: string) {
  const enc = await ctx.db.encounter.findUnique({ where: { id: encounterId } });
  if (!enc) throw notFound();
  await requirePatient(ctx, enc.patientId);
  ctx.audit.resource("Encounter", enc.id);
  return enc;
}
