/**
 * Revenue-cycle seed (S5): the practice's standard fee schedule (self-pay and billed charges), one contracted
 * schedule per commercial demo payer (underpayment detection, rcm/06-07), and a demo prior-authorisation rule.
 * Idempotent: schedules are created once by name. Amounts are demo values, not real contracted rates.
 */
import type { PrismaClient } from "../../generated/prisma-client/index.js";

const STANDARD: Record<string, number> = {
  "99202": 110,
  "99203": 165,
  "99204": 245,
  "99205": 320,
  "99211": 45,
  "99212": 85,
  "99213": 125,
  "99214": 165,
  "99215": 230,
  "99385": 210,
  "99386": 230,
  "99395": 190,
  "99396": 210,
  "99397": 230,
  "90471": 25,
  "90472": 18,
  "90686": 32,
  "90715": 55,
  "90750": 190,
  "96372": 30,
  "36415": 12,
  "81002": 10,
  "82962": 8,
  "83036": 28,
  "87880": 22,
  "87804": 25,
  "93000": 45,
  "96127": 10,
  "69210": 65,
  "17110": 110,
  "20610": 120,
  G0438: 185,
  G0439: 145,
  G0444: 25,
  J3420: 15,
  J1030: 20,
};

/** Contracted allowed amounts as a share of the standard fee (demo). */
const CONTRACTS: Record<string, number> = {
  Aetna: 0.78,
  "Blue Cross Blue Shield of Illinois": 0.8,
  UnitedHealthcare: 0.75,
};

export async function seedBilling(prisma: PrismaClient, practiceId: string): Promise<void> {
  const codes = await prisma.codeConcept.findMany({
    where: { system: { in: ["CPT", "HCPCS"] }, active: true },
    select: { system: true, code: true },
  });
  const systemOf = new Map(codes.map((c) => [c.code, c.system]));
  async function schedule(
    name: string,
    payerId: string | null,
    isContract: boolean,
    factor: number,
  ) {
    if (await prisma.feeSchedule.findFirst({ where: { practiceId, name } })) return;
    const fs = await prisma.feeSchedule.create({
      data: { practiceId, name, payerId, isContract, effectiveFrom: new Date("2026-01-01") },
    });
    await prisma.feeScheduleItem.createMany({
      data: Object.entries(STANDARD)
        .filter(([code]) => systemOf.has(code))
        .map(([code, amount]) => ({
          practiceId,
          feeScheduleId: fs.id,
          codeSystem: systemOf.get(code)!,
          code,
          amount: (Math.round(amount * factor * 100) / 100).toFixed(2),
        })),
    });
  }
  await schedule("Standard fees 2026", null, false, 1);
  const payers = await prisma.payer.findMany({ where: { practiceId } });
  for (const p of payers) {
    const factor = CONTRACTS[p.name];
    if (factor) await schedule(`${p.name} contract 2026`, p.id, true, factor);
    if (p.name === "UnitedHealthcare" && !p.claimRules)
      await prisma.payer.update({
        where: { id: p.id },
        data: { claimRules: { authRequiredCodes: ["20610"] } },
      });
  }
}
