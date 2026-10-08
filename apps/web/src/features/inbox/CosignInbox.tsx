import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { CosignItem } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDate, formatShortDate } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { InboxLayout } from "./InboxLayout";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { NoteView } from "@/features/encounter/NoteView";
import { Pressable } from "@/components/ui/pressable";

const S = "inbox.cosign";

/** inbox.cosign: notes waiting for my co-signature (co-sign rules, INV-SAFE-01). */
export function CosignInboxPage() {
  const v = useView();
  const queue = useApi("listCosignQueue", { query: {} }, { refetchInterval: 60_000 });
  const items = queue.data?.data ?? [];
  const selected = items.find((i) => i.note.id === v.id) ?? items[0] ?? null;
  return (
    <InboxLayout counts={{ "inbox.cosign": items.length }}>
      <Card className="p-0" data-testid={tid(S, "cosign-item")}>
        <h2 className="px-5 pb-2 pt-5 text-h3">Waiting for co-signature</h2>
        {queue.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!queue.isLoading && !items.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">Nothing to co-sign.</p>
        ) : null}
        <ul>
          {items.map((i) => (
            <li key={i.note.id}>
              <Pressable
                type="button"
                onClick={() => v.open("note", i.note.id)}
                className={cn(
                  "grid w-full gap-0.5 px-5 py-3 text-left hover:bg-surface-hover",
                  selected?.note.id === i.note.id && "bg-pine-50",
                )}
              >
                <b className="font-semibold">{i.note.patient.name}</b>
                <span className="text-small text-ink-2">
                  {formatShortDate(i.note.dateOfService)} · {i.note.title} · {i.author}
                </span>
                <span className="text-small tabular-nums text-ink-2">
                  Waiting {i.waitingHours < 1 ? "under an hour" : `${i.waitingHours} h`}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <CosignDetail item={selected} /> : <span />}
    </InboxLayout>
  );
}

function CosignDetail({ item }: { item: CosignItem }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const note = useApi("getNoteDetail", { params: { noteId: item.note.id } });
  const dx = useApi("listEncounterDiagnoses", { params: { encounterId: item.note.encounterId } });
  const [confirm, setConfirm] = React.useState(false);
  const [attest, setAttest] = React.useState(false);
  const [returning, setReturning] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const done = {
    invalidates: ["listCosignQueue", "getProviderWorklist", "getNoteDetail"] as const,
  };
  const cosign = useApiMutation("cosignNote", {
    ...done,
    invalidates: [...done.invalidates],
    onSuccess: () => (toast("Note co-signed."), setConfirm(false)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ret = useApiMutation("returnNoteToAuthor", {
    invalidates: ["listCosignQueue"],
    onSuccess: () => (
      toast("Sent back to the author with your comment."),
      setReturning(false),
      setComment("")
    ),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const p = item.note.patient;
  return (
    <Card data-testid={tid(S, "cs-note")}>
      <CardHeader
        title={`${p.name} · ${item.note.title}`}
        actions={
          <>
            {isBuilt("encounter.note") ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  navigate(
                    pathTo("encounter.note", {
                      patientId: p.id,
                      encounterId: item.note.encounterId,
                    }),
                  )
                }
                data-testid={tid(S, "cs-open")}
              >
                Open encounter
              </Button>
            ) : null}
            {can("returnNoteToAuthor") ? (
              <Button
                size="sm"
                onClick={() => setReturning(true)}
                data-testid={tid(S, "cs-return")}
              >
                Return with comment
              </Button>
            ) : null}
            {can("cosignNote") ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!note.data}
                onClick={() => (setAttest(false), setConfirm(true))}
                data-testid={tid(S, "cs-sign")}
              >
                Co-sign
              </Button>
            ) : null}
          </>
        }
      />
      <p className="mb-4 text-small tabular-nums text-ink-2">
        DOB {formatDate(p.birthDate)} · MRN {p.mrn} · written by {item.author}
      </p>
      {note.error ? <Alert tone="caution">{errorMessage(note.error)}</Alert> : null}
      {note.data ? (
        <NoteView note={note.data} diagnoses={dx.data ?? []} />
      ) : (
        <LoadingRows rows={6} />
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Co-sign the note for ${p.name}?`}
        description="Your co-signature is added to the signed note. It can't be removed."
        action="Co-sign"
        disabled={!attest || cosign.isPending}
        onConfirm={() =>
          note.data &&
          cosign.mutate({
            params: { noteId: note.data.id },
            body: { version: note.data.version, patientId: p.id, attest },
          })
        }
      >
        <Checkbox
          checked={attest}
          onCheckedChange={(v) => setAttest(v === true)}
          label="I reviewed this note and agree with the assessment and plan."
        />
      </ConfirmDialog>
      <Dialog open={returning} onOpenChange={setReturning}>
        <DialogContent className="w-dialog-sm">
          <DialogHeader>
            <DialogTitle>Return to the author?</DialogTitle>
          </DialogHeader>
          <FieldShell
            label="Comment"
            htmlFor="cs-comment"
            hint="The author gets a task with your comment. The note stays waiting for your co-signature."
          >
            <Textarea
              id="cs-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </FieldShell>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReturning(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!comment.trim() || ret.isPending}
              onClick={() =>
                ret.mutate({ params: { noteId: item.note.id }, body: { comment: comment.trim() } })
              }
            >
              Return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
