import type { Prisma } from "../../db.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { conflict, notFound } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";

/** admin.payers-fees: payers (clearinghouse trading-partner ids, timely filing) and plans. */
export const payerHandlers: HandlerMap = {
  async listPayers(ctx) {
    const term = ctx.query.q?.trim();
    return toDtos(
      "Payer",
      await ctx.db.payer.findMany({
        where: term ? { name: { contains: term, mode: "insensitive" } } : {},
        orderBy: [{ active: "desc" }, { name: "asc" }],
      }),
    );
  },

  async createPayer(ctx) {
    const b = ctx.body;
    if (await ctx.db.payer.findFirst({ where: { clearinghousePayerId: b.clearinghousePayerId } }))
      throw conflict("duplicate", "A payer with this clearinghouse id already exists.");
    const p = await ctx.db.payer.create({
      data: { ...(b as Prisma.PayerUncheckedCreateInput), practiceId: ctx.practiceId! },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Payer", p, ctx.staff().userId);
    ctx.audit.resource("Payer", p.id);
    return toDto("Payer", p);
  },

  async updatePayer(ctx) {
    const p = await ctx.db.payer.findUnique({ where: { id: ctx.params.payerId } });
    if (!p) throw notFound();
    ctx.checkVersion(p.version);
    const updated = await ctx.db.payer.update({
      where: { id: p.id },
      data: { ...(ctx.body as Prisma.PayerUpdateInput), version: { increment: 1 } },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Payer", updated, ctx.staff().userId);
    ctx.audit.resource("Payer", p.id);
    return toDto("Payer", updated);
  },

  async listPayerPlans(ctx) {
    return toDtos(
      "PayerPlan",
      await ctx.db.payerPlan.findMany({
        where: { payerId: ctx.params.payerId },
        orderBy: { name: "asc" },
      }),
    );
  },

  async createPayerPlan(ctx) {
    const payer = await ctx.db.payer.findUnique({ where: { id: ctx.params.payerId } });
    if (!payer) throw notFound();
    const plan = await ctx.db.payerPlan.create({
      data: {
        ...(ctx.body as Prisma.PayerPlanUncheckedCreateInput),
        payerId: payer.id,
        practiceId: ctx.practiceId!,
      },
    });
    ctx.audit.resource("PayerPlan", plan.id);
    return toDto("PayerPlan", plan);
  },
};
