import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 6.x config file (replaces the deprecated package.json#prisma seed
 * key). Still on Prisma 6.x, not 7.x -- see the version note at the top of
 * prisma/schema.prisma.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
