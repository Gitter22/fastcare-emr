import type { Prisma } from "../../db.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";
import { parseWindows } from "../scheduling/domain.js";

/** admin.visit-types: visit types, weekly schedule templates and blocked time. Versioned and audited. */
const day = (s: string | null | undefined) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : s === null ? null : undefined;

function validateWindows(raw: unknown) {
  const windows = parseWindows(raw);
  if (!Array.isArray(raw) || windows.length !== raw.length) {
    throw unprocessable(
      "validation_failed",
      "Each block needs a weekday and a start before its end (HH:MM).",
      { errors: [{ field: "slots", code: "invalid", message: "Check the schedule blocks." }] },
    );
  }
  return windows;
}

export const schedulingSetupHandlers: HandlerMap = {
  async listVisitTypes(ctx) {
    return toDtos(
      "VisitType",
      await ctx.db.visitType.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    );
  },

  async createVisitType(ctx) {
    const b = ctx.body;
    if (b.durationMinutes < 5 || b.durationMinutes > 480)
      throw unprocessable("validation_failed", "Duration must be 5 to 480 minutes.");
    const vt = await ctx.db.visitType.create({
      data: {
        ...(b as Prisma.VisitTypeUncheckedCreateInput),
        modalities: b.modalities ?? ["IN_PERSON"],
        defaultCptHints: b.defaultCptHints ?? [],
        previsitQuestionnaireIds: b.previsitQuestionnaireIds ?? [],
        practiceId: ctx.practiceId!,
      },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "VisitType", vt, ctx.staff().userId);
    ctx.audit.resource("VisitType", vt.id);
    return toDto("VisitType", vt);
  },

  async updateVisitType(ctx) {
    const vt = await ctx.db.visitType.findUnique({ where: { id: ctx.params.visitTypeId } });
    if (!vt) throw notFound();
    ctx.checkVersion(vt.version);
    const updated = await ctx.db.visitType.update({
      where: { id: vt.id },
      data: { ...(ctx.body as Prisma.VisitTypeUpdateInput), version: { increment: 1 } },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "VisitType", updated, ctx.staff().userId);
    ctx.audit.resource("VisitType", vt.id);
    return toDto("VisitType", updated);
  },

  async listScheduleTemplates(ctx) {
    const q = ctx.query;
    return toDtos(
      "ScheduleTemplate",
      await ctx.db.scheduleTemplate.findMany({
        where: {
          ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
          ...(q.locationId ? { locationId: q.locationId } : {}),
        },
        orderBy: { effectiveFrom: "desc" },
      }),
    );
  },

  async createScheduleTemplate(ctx) {
    const b = ctx.body;
    const slots = validateWindows(b.slots);
    const t = await ctx.db.scheduleTemplate.create({
      data: {
        practiceId: ctx.practiceId!,
        practitionerId: b.practitionerId,
        locationId: b.locationId,
        effectiveFrom: day(b.effectiveFrom)!,
        effectiveTo: day(b.effectiveTo) ?? null,
        slots: slots as unknown as Prisma.InputJsonValue,
      },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "ScheduleTemplate", t, ctx.staff().userId);
    ctx.audit.resource("ScheduleTemplate", t.id);
    return toDto("ScheduleTemplate", t);
  },

  async updateScheduleTemplate(ctx) {
    const t = await ctx.db.scheduleTemplate.findUnique({
      where: { id: ctx.params.scheduleTemplateId },
    });
    if (!t) throw notFound();
    ctx.checkVersion(t.version);
    const b = ctx.body;
    const updated = await ctx.db.scheduleTemplate.update({
      where: { id: t.id },
      data: {
        ...(b.effectiveFrom ? { effectiveFrom: day(b.effectiveFrom)! } : {}),
        ...(b.effectiveTo !== undefined ? { effectiveTo: day(b.effectiveTo) } : {}),
        ...(b.slots !== undefined
          ? { slots: validateWindows(b.slots) as unknown as Prisma.InputJsonValue }
          : {}),
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "ScheduleTemplate", updated, ctx.staff().userId);
    ctx.audit.resource("ScheduleTemplate", t.id);
    return toDto("ScheduleTemplate", updated);
  },

  async listScheduleBlocks(ctx) {
    const q = ctx.query;
    return toDtos(
      "ScheduleBlock",
      await ctx.db.scheduleBlock.findMany({
        where: {
          ...(q.from ? { end: { gt: new Date(q.from) } } : {}),
          ...(q.to ? { start: { lt: new Date(q.to) } } : {}),
          ...(q.practitionerId
            ? { OR: [{ practitionerId: q.practitionerId }, { practitionerId: null }] }
            : {}),
        },
        orderBy: { start: "asc" },
      }),
    );
  },

  async createScheduleBlock(ctx) {
    const b = ctx.body;
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (!(start < end))
      throw unprocessable("validation_failed", "The block must end after it starts.");
    const blk = await ctx.db.scheduleBlock.create({
      data: {
        practiceId: ctx.practiceId!,
        practitionerId: b.practitionerId ?? null,
        roomId: b.roomId ?? null,
        start,
        end,
        reason: b.reason,
        createdById: ctx.staff().userId,
      },
    });
    ctx.audit.resource("ScheduleBlock", blk.id);
    return toDto("ScheduleBlock", blk);
  },

  async deleteScheduleBlock(ctx) {
    const blk = await ctx.db.scheduleBlock.findUnique({
      where: { id: ctx.params.scheduleBlockId },
    });
    if (!blk) throw notFound();
    await ctx.db.scheduleBlock.delete({ where: { id: blk.id } });
    ctx.audit.resource("ScheduleBlock", blk.id);
  },
};
