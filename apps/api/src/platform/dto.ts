import type { SchemaTypes } from "@agile-emr/shared";
import schemasJson from "../contracts/schemas.json" with { type: "json" };

/**
 * Serialises a row into a components.schemas shape from api/openapi.yaml:
 *   - only properties the schema declares are copied (so @secret / @server-only columns never leave the API),
 *   - format: date -> "YYYY-MM-DD", format: date-time -> ISO string,
 *   - money (pattern ^-?\d+\.\d{2}$) -> two-decimal string, never a float,
 *   - nested $ref / arrays / allOf are followed.
 * Decrypt @encrypted fields before calling.
 */
type Schema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  pattern?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};

const defs = (schemasJson as unknown as { definitions: Record<string, Schema> }).definitions;
const MONEY = "^-?\\d+\\.\\d{2}$";

function resolve(s: Schema): Schema {
  let cur = s;
  while (cur.$ref) cur = defs[cur.$ref.split("/").pop()!]!;
  return cur;
}

function properties(s: Schema): Record<string, Schema> | null {
  const r = resolve(s);
  if (r.allOf) return Object.assign({}, ...r.allOf.map((x) => properties(x) ?? {}));
  if (r.properties) return r.properties;
  return null;
}

function convert(value: unknown, schema: Schema): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = resolve(schema);
  const variants = s.oneOf ?? s.anyOf;
  if (variants) {
    const nonNull = variants.map(resolve).find((v) => v.type !== "null");
    return nonNull ? convert(value, nonNull) : value;
  }
  if (value instanceof Date) {
    return s.format === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (typeof value === "bigint")
    return s.type === "integer" || (Array.isArray(s.type) && s.type.includes("integer"))
      ? Number(value)
      : value.toString();
  if (isDecimal(value)) {
    const n = value.toNumber();
    // Decimals serialise as strings with at least two places (money "25.00"); finer values keep their precision
    // (observation quantities are scale 4), so nothing is rounded away.
    const places = Math.max(2, value.decimalPlaces());
    return types(s).includes("string") || s.pattern === MONEY ? value.toFixed(places) : n;
  }
  if (typeof value === "number" && s.pattern === MONEY) return value.toFixed(2);
  if (Array.isArray(value)) return s.items ? value.map((v) => convert(v, s.items!)) : value;
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    const props = properties(s);
    if (!props) return value; // free-form JSON
    const out: Record<string, unknown> = {};
    for (const [k, ps] of Object.entries(props)) {
      const v = convert((value as Record<string, unknown>)[k], ps);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (value instanceof Uint8Array) return undefined;
  return value;
}

const types = (s: Schema) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);

function isDecimal(v: unknown): v is {
  toNumber(): number;
  toString(): string;
  toFixed(dp: number): string;
  decimalPlaces(): number;
} {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { toNumber?: unknown }).toNumber === "function" &&
    "d" in (v as object)
  );
}

export function toDto<K extends keyof SchemaTypes>(name: K, row: unknown): SchemaTypes[K] {
  if (!defs[name]) throw new Error(`Unknown schema ${name}`);
  return convert(row, { $ref: `#/definitions/${name}` }) as SchemaTypes[K];
}

export function toDtos<K extends keyof SchemaTypes>(
  name: K,
  rows: unknown[],
): Array<SchemaTypes[K]> {
  return rows.map((r) => toDto(name, r));
}

/** Money helpers for Prisma Decimal values. */
export const money = (v: { toNumber(): number } | number | null | undefined): string =>
  v == null ? "0.00" : (typeof v === "number" ? v : v.toNumber()).toFixed(2);

export const isoDate = (d: Date | null | undefined): string | undefined =>
  d ? d.toISOString().slice(0, 10) : undefined;
export const iso = (d: Date | null | undefined): string | undefined =>
  d ? d.toISOString() : undefined;

/** Cursor pagination over a uuid/createdAt-ordered list. */
export function page<TRow, TOut>(
  rows: TRow[],
  limit: number,
  map: (r: TRow) => TOut,
  cursorOf: (r: TRow) => string,
) {
  const slice = rows.slice(0, limit);
  return {
    data: slice.map(map),
    nextCursor: rows.length > limit && slice.length ? cursorOf(slice[slice.length - 1]!) : null,
    hasMore: rows.length > limit,
  };
}

export function limitOf(q: { limit?: number } | undefined, max = 200, def = 50): number {
  const n = Number(q?.limit ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(1, n), max) : def;
}
