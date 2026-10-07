/**
 * Re-exports the generated Prisma client (generated to /generated/prisma-client at the repo root -- see the
 * `generator client` block in prisma/schema.prisma).
 *
 * `prisma` connects with APP_DATABASE_URL -- the least-privilege `app_api` role (NOSUPERUSER, NOBYPASSRLS), not the
 * migration role in DATABASE_URL. That is what makes Row-Level Security apply (INV-SEC-02). Tenant-scoped work goes
 * through `withTenant` (platform/tenant.ts), never the bare client.
 */
import { PrismaClient } from "../../../generated/prisma-client/index.js";
import { getEnv } from "./env.js";

export * from "../../../generated/prisma-client/index.js";

export const prisma = new PrismaClient({
  datasources: {
    db: { url: getEnv().APP_DATABASE_URL },
  },
});

/** A Prisma transaction client (what `withTenant` hands to callers). */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;
