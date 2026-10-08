import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClinicalNoteDetail } from "@agile-emr/shared";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { useMe } from "@/app/auth";
import { opKey, useApi } from "@/lib/api/hooks";
import { useEncounter } from "./EncounterWorkspace";

const AUTOSAVE_MS = 1500;
const LOCK_RENEW_MS = 60_000;

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * Encounter note editing: sections are edited locally and autosaved (debounced) with the note version; the first edit
 * takes the edit lock and saves keep renewing it, so a second user sees "locked by another user" instead of
 * overwriting. Signed notes are read-only (INV-SAFE-02). INV-SEC-04: every keystroke reaches the server within
 * seconds, so a session timeout never loses the draft.
 */
export function useNoteDraft() {
  const { encounterId, setAutosavedAt } = useEncounter();
  const me = useMe();
  const qc = useQueryClient();
  const note = useApi("getNote", { params: { encounterId } });
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [dirtyKeys, setDirtyKeys] = React.useState<Set<string>>(new Set());
  const [state, setState] = React.useState<SaveState>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const version = React.useRef<number | null>(null);
  const holding = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<Set<string>>(new Set());
  const latest = React.useRef(draft);
  latest.current = draft;

  const n = note.data;
  React.useEffect(() => {
    if (!n) return;
    version.current = n.version;
    // Server text fills sections the user is not editing right now.
    setDraft((d) => {
      const next = { ...d };
      for (const s of n.sections) if (!pending.current.has(s.key)) next[s.key] = s.content;
      return next;
    });
  }, [n]);

  const readOnly = !n || ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(n.status);
  const lockedByOther =
    !!n?.lock && n.lock.userId !== me.user.id && new Date(n.lock.expiresAt) > new Date();

  const apply = React.useCallback(
    (detail: ClinicalNoteDetail) => {
      version.current = detail.version;
      qc.setQueryData(opKey("getNote", { params: { encounterId } }), detail);
    },
    [qc, encounterId],
  );

  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const keys = [...pending.current];
    if (!keys.length || version.current == null) return;
    setState("saving");
    try {
      const detail = await api("saveNoteSections", {
        params: { encounterId },
        body: {
          version: version.current,
          sections: keys.map((k) => ({ key: k, text: latest.current[k] ?? "" })),
        },
      });
      for (const k of keys)
        if (latest.current[k] === (detail.sections.find((s) => s.key === k)?.content ?? ""))
          pending.current.delete(k);
      holding.current = true;
      setDirtyKeys(new Set(pending.current));
      apply(detail);
      setAutosavedAt(new Date());
      setState(pending.current.size ? "dirty" : "saved");
      setError(null);
    } catch (e) {
      setState("error");
      if (
        e instanceof ApiError &&
        (e.status === 412 || e.code === "note_locked" || e.code === "note_signed")
      ) {
        setError(
          e.status === 412
            ? "This note changed in another window. Your latest edits are kept here; reload to see the other changes."
            : errorMessage(e),
        );
        void note.refetch();
      } else setError(errorMessage(e));
    }
  }, [apply, encounterId, note, setAutosavedAt]);

  const edit = React.useCallback(
    (key: string, text: string) => {
      setDraft((d) => ({ ...d, [key]: text }));
      pending.current.add(key);
      setDirtyKeys(new Set(pending.current));
      setState("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  // Keep the lock while the page is open and editing; release it on leave.
  React.useEffect(() => {
    if (!n || readOnly) return;
    const id = setInterval(() => {
      if (holding.current)
        void api("lockNote", { params: { noteId: n.id } }).catch(() => undefined);
    }, LOCK_RENEW_MS);
    return () => clearInterval(id);
  }, [n?.id, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const noteId = n?.id;
    return () => {
      if (timer.current) void flush();
      if (noteId && holding.current)
        void api("releaseNoteLock", { params: { noteId } }).catch(() => undefined);
    };
  }, [n?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    note: n,
    loading: note.isLoading,
    loadError: note.error,
    draft,
    dirtyKeys,
    edit,
    flush,
    apply,
    state,
    error,
    readOnly,
    lockedByOther,
    version: () => version.current ?? n?.version ?? 0,
    refetch: note.refetch,
  };
}
