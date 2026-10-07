import { prisma, type Tx } from "../db.js";

/**
 * Runs `fn` in one Postgres transaction with `app.practice_id` set (SET LOCAL via set_config(..., true)). Every
 * tenant-scoped table has an RLS policy on that setting (prisma/migrations/*_security), so a query that forgets
 * `where practiceId` still cannot see another practice's rows (INV-SEC-02, ADR-009). Without the setting, policies
 * match nothing: the fail-closed default.
 */
export function withTenant<T>(
  practiceId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`;
      return fn(tx);
    },
    { timeout: opts.timeoutMs ?? 30_000, maxWait: 10_000 },
  );
}

/** Work that runs before a tenant is known (login, token refresh). Only global tables and SECURITY DEFINER lookups. */
export function withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx), { timeout: 30_000, maxWait: 10_000 });
}
