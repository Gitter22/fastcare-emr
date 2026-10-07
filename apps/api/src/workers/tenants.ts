import { prisma, type Tx } from "../db.js";
import { withTenant } from "../platform/tenant.js";

/**
 * Background work runs per tenant under the same RLS context as a request (INV-SEC-02): practices come from the
 * narrow SECURITY DEFINER list_active_practices(), then everything else happens inside withTenant.
 */
export async function forEachPractice(
  fn: (tx: Tx, practice: { id: string; timezone: string }) => Promise<void>,
  log?: (e: unknown, practiceId: string) => void,
) {
  const practices = await prisma.$queryRaw<
    Array<{ id: string; timezone: string }>
  >`SELECT * FROM list_active_practices()`;
  for (const p of practices) {
    try {
      await withTenant(p.id, (tx) => fn(tx, p), { timeoutMs: 120_000 });
    } catch (e) {
      log?.(e, p.id);
    }
  }
}
