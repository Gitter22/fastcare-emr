import { isValidNpi } from "@agile-emr/shared";
import type { Prisma } from "../../db.js";
import { decryptOptionalField, encryptField } from "../../platform/crypto.js";
import { toDto, toDtos } from "../../platform/dto.js";
import type { Ctx, HandlerMap } from "../../platform/http/context.js";
import { conflict, notFound, unprocessable } from "../../platform/problem.js";
import { writeVersion } from "../../platform/versioning.js";

/** admin.locations, admin.providers, pools: the practice's own configuration. Every change is versioned + audited. */
const practiceDto = <T extends { tin: string }>(p: T) => ({
  ...p,
  tin: decryptOptionalField(p.tin) ?? "",
});

function npiError(field: string, npi: string | null | undefined) {
  if (npi && !isValidNpi(npi)) {
    return unprocessable(
      "validation_failed",
      "Check the NPI. It should be 10 digits with a valid check digit.",
      { errors: [{ field, code: "npi", message: "Not a valid NPI." }] },
    );
  }
  return null;
}

async function poolView(ctx: Ctx, id: string) {
  const pool = await ctx.db.workPool.findUniqueOrThrow({
    where: { id },
    include: { members: { include: { user: true } } },
  });
  const openTasks = await ctx.db.task.count({
    where: {
      poolId: id,
      status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "PENDED_TO_PROVIDER"] },
    },
  });
  return {
    ...toDto("WorkPool", pool),
    members: pool.members.map((m) => ({
      userId: m.userId,
      name: `${m.user.firstName} ${m.user.lastName}`,
    })),
    openTasks,
  };
}

export const organisationHandlers: HandlerMap = {
  async getPractice(ctx) {
    const p = await ctx.db.practice.findUniqueOrThrow({ where: { id: ctx.practiceId! } });
    return toDto("Practice", practiceDto(p));
  },

  async updatePractice(ctx) {
    const p = await ctx.db.practice.findUniqueOrThrow({ where: { id: ctx.practiceId! } });
    ctx.checkVersion(p.version);
    const b = ctx.body;
    const bad = npiError("groupNpi", b.groupNpi);
    if (bad) throw bad;
    const updated = await ctx.db.practice.update({
      where: { id: p.id },
      data: {
        ...(b as Prisma.PracticeUpdateInput),
        ...(b.tin ? { tin: encryptField(b.tin) } : {}),
        version: { increment: 1 },
      },
    });
    await writeVersion(ctx.db, p.id, "Practice", practiceDto(updated), ctx.staff().userId);
    ctx.audit.resource("Practice", p.id);
    return toDto("Practice", practiceDto(updated));
  },

  async listLocations(ctx) {
    return toDtos(
      "Location",
      await ctx.db.location.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    );
  },

  async createLocation(ctx) {
    const b = ctx.body;
    const bad = npiError("npi", b.npi);
    if (bad) throw bad;
    const pos = await ctx.db.codeConcept.findFirst({
      where: { system: "POS", code: b.placeOfService, active: true },
    });
    if (!pos)
      throw unprocessable(
        "validation_failed",
        "Choose a place-of-service code from the CMS list.",
        { errors: [{ field: "placeOfService", code: "unknown", message: "Unknown POS code." }] },
      );
    const loc = await ctx.db.location.create({
      data: { ...(b as Prisma.LocationUncheckedCreateInput), practiceId: ctx.practiceId! },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Location", loc, ctx.staff().userId);
    ctx.audit.resource("Location", loc.id);
    return toDto("Location", loc);
  },

  async updateLocation(ctx) {
    const loc = await ctx.db.location.findUnique({ where: { id: ctx.params.locationId } });
    if (!loc) throw notFound();
    ctx.checkVersion(loc.version);
    const bad = npiError("npi", ctx.body.npi);
    if (bad) throw bad;
    const updated = await ctx.db.location.update({
      where: { id: loc.id },
      data: { ...(ctx.body as Prisma.LocationUpdateInput), version: { increment: 1 } },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Location", updated, ctx.staff().userId);
    ctx.audit.resource("Location", loc.id);
    return toDto("Location", updated);
  },

  async listRooms(ctx) {
    return toDtos(
      "Room",
      await ctx.db.room.findMany({
        where: { locationId: ctx.params.locationId },
        orderBy: { name: "asc" },
      }),
    );
  },

  async createRoom(ctx) {
    const loc = await ctx.db.location.findUnique({ where: { id: ctx.params.locationId } });
    if (!loc) throw notFound();
    const room = await ctx.db.room.create({
      data: {
        ...(ctx.body as Prisma.RoomUncheckedCreateInput),
        equipment: ctx.body.equipment ?? [],
        practiceId: ctx.practiceId!,
        locationId: loc.id,
      },
    });
    ctx.audit.resource("Room", room.id);
    return toDto("Room", room);
  },

  async updateRoom(ctx) {
    const room = await ctx.db.room.findUnique({ where: { id: ctx.params.roomId } });
    if (!room) throw notFound();
    const updated = await ctx.db.room.update({
      where: { id: room.id },
      data: ctx.body as Prisma.RoomUpdateInput,
    });
    ctx.audit.resource("Room", room.id);
    return toDto("Room", updated);
  },

  async listPractitioners(ctx) {
    const term = ctx.query.q?.trim();
    const rows = await ctx.db.practitioner.findMany({
      where: term
        ? {
            OR: [
              { firstName: { contains: term, mode: "insensitive" } },
              { lastName: { contains: term, mode: "insensitive" } },
              { npi: term },
            ],
          }
        : {},
      orderBy: [{ active: "desc" }, { lastName: "asc" }],
    });
    return toDtos("Practitioner", rows);
  },

  async createPractitioner(ctx) {
    const b = ctx.body;
    const bad = npiError("npi", b.npi);
    if (bad) throw bad;
    if (b.npi && (await ctx.db.practitioner.findFirst({ where: { npi: b.npi } })))
      throw conflict("duplicate", "A provider with this NPI already exists.");
    const p = await ctx.db.practitioner.create({
      data: { ...(b as Prisma.PractitionerUncheckedCreateInput), practiceId: ctx.practiceId! },
    });
    await writeVersion(ctx.db, ctx.practiceId!, "Practitioner", p, ctx.staff().userId);
    ctx.audit.resource("Practitioner", p.id);
    return toDto("Practitioner", p);
  },

  async listWorkPools(ctx) {
    const pools = await ctx.db.workPool.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });
    return Promise.all(pools.map((p) => poolView(ctx, p.id)));
  },

  async createWorkPool(ctx) {
    const pool = await ctx.db.workPool.create({
      data: { ...(ctx.body as Prisma.WorkPoolUncheckedCreateInput), practiceId: ctx.practiceId! },
    });
    ctx.audit.resource("WorkPool", pool.id);
    return toDto("WorkPool", pool);
  },

  async setWorkPoolMembers(ctx) {
    const pool = await ctx.db.workPool.findUnique({ where: { id: ctx.params.workPoolId } });
    if (!pool) throw notFound();
    const users = await ctx.db.user.findMany({
      where: { id: { in: ctx.body.ids }, status: { not: "DEACTIVATED" } },
    });
    if (users.length !== new Set(ctx.body.ids).size)
      throw unprocessable("validation_failed", "Some users can't be added.");
    await ctx.db.workPoolMember.deleteMany({ where: { poolId: pool.id } });
    for (const u of users)
      await ctx.db.workPoolMember.create({
        data: { practiceId: ctx.practiceId!, poolId: pool.id, userId: u.id },
      });
    ctx.audit.resource("WorkPool", pool.id);
    return poolView(ctx, pool.id);
  },
};
