// Validates data/schema.prisma offline with Prisma's wasm engine and prints a summary.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import internals from "@prisma/internals";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datamodel = fs.readFileSync(path.join(root, "data", "schema.prisma"), "utf8");
try {
  const dmmf = await internals.getDMMF({ datamodel });
  console.log(`schema ok: ${dmmf.datamodel.models.length} models, ${dmmf.datamodel.enums.length} enums`);
} catch (e) {
  console.error(String(e.message || e).replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, 80).join("\n"));
  process.exit(1);
}
