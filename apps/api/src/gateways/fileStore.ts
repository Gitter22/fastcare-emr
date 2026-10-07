import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FileObject, Tx } from "../db.js";
import { getEnv } from "../env.js";
import {
  MASTER_KEY_ID,
  decryptBlob,
  encryptBlob,
  newDataKey,
  unwrapDataKey,
} from "../platform/crypto.js";

/**
 * FileStore gateway (docs/09-data-model.md#files): files on the Docker volume, each encrypted with its own AES-256-GCM
 * data key wrapped by the master key. Directories are agile-emr's existing env vars, which docker-compose already
 * points at the persistent /data volume:
 *   upload    -> PATIENT_DOCUMENT_UPLOADS_DIR (scans, faxes, portal uploads, card images)
 *   photo     -> ID_PHOTO_UPLOADS_DIR         (patient photos, ID cards)
 *   lab       -> LAB_REPORT_UPLOADS_DIR       (result PDFs, interface payloads)
 *   generated -> GENERATED_DOCS_DIR           (AVS, statements, exports, letters)
 * storageKey = <kind>/<practiceId>/<yyyy>/<mm>/<uuid>; never derived from user input. Files are served only
 * through the API after an access check and audit (downloadFile).
 */
export type FileKind = "upload" | "photo" | "lab" | "generated";

function rootFor(kind: FileKind): string {
  const env = getEnv();
  return {
    upload: env.PATIENT_DOCUMENT_UPLOADS_DIR,
    photo: env.ID_PHOTO_UPLOADS_DIR,
    lab: env.LAB_REPORT_UPLOADS_DIR,
    generated: env.GENERATED_DOCS_DIR,
  }[kind];
}

function pathFor(storageKey: string): string {
  const [kind, ...rest] = storageKey.split("/");
  const root = resolve(rootFor(kind as FileKind));
  const full = resolve(join(root, ...rest));
  if (!full.startsWith(root)) throw new Error("storage key escapes the volume");
  return full;
}

export async function putFile(
  tx: Tx,
  input: {
    practiceId: string;
    kind: FileKind;
    fileName: string;
    contentType: string;
    data: Buffer;
    pageCount?: number;
    uploadedById?: string | null;
    uploadedByPortalUserId?: string | null;
  },
): Promise<FileObject> {
  const now = new Date();
  const storageKey = `${input.kind}/${input.practiceId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  const { dataKey, wrapped } = newDataKey();
  const path = pathFor(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encryptBlob(dataKey, input.data), { mode: 0o600 });
  return tx.fileObject.create({
    data: {
      practiceId: input.practiceId,
      storageKey,
      fileName: input.fileName.slice(0, 255),
      contentType: input.contentType,
      sizeBytes: input.data.length,
      sha256: createHash("sha256").update(input.data).digest("hex"),
      encryptionKeyId: MASTER_KEY_ID,
      wrappedDataKey: wrapped,
      pageCount: input.pageCount ?? null,
      uploadedById: input.uploadedById ?? null,
      uploadedByPortalUserId: input.uploadedByPortalUserId ?? null,
    },
  });
}

export async function readFileContent(file: FileObject): Promise<Buffer> {
  if (file.deletedAt) throw new Error("file purged");
  const plain = decryptBlob(
    unwrapDataKey(file.wrappedDataKey),
    await readFile(pathFor(file.storageKey)),
  );
  // Integrity (HIPAA §164.312(c)(1)): content must match the hash taken at upload.
  if (createHash("sha256").update(plain).digest("hex") !== file.sha256)
    throw new Error("file integrity check failed");
  return plain;
}

/** Retention purge only (OPEN-Q11): content removed, row kept with deletedAt. */
export async function purgeFileContent(tx: Tx, file: FileObject): Promise<void> {
  await rm(pathFor(file.storageKey), { force: true });
  await tx.fileObject.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
}
