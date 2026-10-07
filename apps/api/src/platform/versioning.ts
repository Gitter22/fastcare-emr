import type { Tx } from "../db.js";
import { encryptJson } from "./crypto.js";

/**
 * @versioned models write a full encrypted snapshot per change (FHIR vread/_history, audit diffs, EHI export).
 * Call after the row is written, with the row as stored.
 */
export async function writeVersion(
  tx: Tx,
  practiceId: string | null,
  resourceType: string,
  row: { id: string; version?: number },
  changedById: string | null,
  changeReason?: string,
): Promise<void> {
  await tx.resourceVersion.create({
    data: {
      practiceId,
      resourceType,
      resourceId: row.id,
      version: row.version ?? 1,
      snapshot: encryptJson(row),
      changedById,
      changeReason: changeReason ?? null,
    },
  });
}
