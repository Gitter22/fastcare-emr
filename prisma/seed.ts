/**
 * Idempotent seed -- safe to re-run (docker-compose runs it on every deploy, like agile-emr).
 *
 *   1. Reference data (ICD-10-CM, CVX, LOINC, POS) -- always, upserted.
 *   2. Demo practices -- only when the practice (by TIN) does not exist yet.
 *
 * Test credentials (documented here, never hand-waved). Password for every seeded user: TestPassword123!
 *   Riverbend Family Medicine (TIN 84-1234567)
 *     manager@example.com    Practice manager
 *     frontdesk@example.com  Front desk
 *     ma@example.com         MA / nurse
 *     provider@example.com   Provider (Dr. Priya Rao, MD)
 *     np@example.com         Provider (Alex Kim, NP; co-sign rules supervised by Dr. Rao)
 *     biller@example.com     Biller
 *     multi@example.com      Front desk + biller (role switching)
 *   Second Test Clinic (TIN 84-7654321) -- tenant isolation checks
 *     admin2@example.com     Practice manager
 *
 * MFA (INV-SEC-04): every seeded user has an authenticator app enrolled with the FIXED, documented TOTP secret
 *   MIPW6N3DPZVXGHJ7
 * so automated tests can generate codes (otplib `authenticator.generate("MIPW6N3DPZVXGHJ7")`). In development,
 * DEV_STATIC_MFA_CODE is also accepted (same convention as agile-emr).
 */
import { PrismaClient } from "../generated/prisma-client/index.js";
import { decryptField } from "../apps/api/src/encryption.js";
import { loadReferenceData } from "./loadReferenceData.js";
import { seedDemoPractice } from "./seed/practice.js";
import { seedClinical } from "./seed/clinical.js";
import { seedOrders } from "./seed/orders.js";
import { ensureDemoDay, seedScheduling } from "./seed/schedule.js";

const prisma = new PrismaClient();
/** Only the documented demo practices get demo schedule data. */
const DEMO_TINS = ["84-1234567", "84-7654321"];

async function main() {
  const me = (
    await prisma.$queryRaw<Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT current_user AS rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`
  )[0];
  console.log(
    `Seed connected as ${me?.rolname} (super=${String(me?.rolsuper)}, bypassrls=${String(me?.rolbypassrls)})`,
  );

  await loadReferenceData(prisma);
  await seedDemoPractice(prisma, "riverbend");
  await seedDemoPractice(prisma, "second");
  for (const tin of DEMO_TINS) {
    const practice = await prisma.practice.findMany({ select: { id: true, tin: true } });
    const p = practice.find((x) => decryptField(x.tin) === tin);
    if (!p) continue;
    await seedScheduling(prisma, p.id);
    await ensureDemoDay(prisma, p.id);
    await seedClinical(prisma, p.id);
    await seedOrders(prisma, p.id);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
