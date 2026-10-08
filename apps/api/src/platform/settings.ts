import type { Tx } from "../db.js";

/** A practice setting's value (PracticeSetting, admin.settings), or the documented default when unset or mistyped. */
export async function settingValue<T>(
  tx: Tx,
  key: string,
  fallback: T,
  valid: (v: unknown) => v is T = (v): v is T => typeof v === typeof fallback,
): Promise<T> {
  const s = await tx.practiceSetting.findFirst({ where: { key } });
  return s && valid(s.value) ? s.value : fallback;
}
