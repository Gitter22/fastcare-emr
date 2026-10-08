import * as React from "react";
import { useParams } from "react-router-dom";
import { Filter, Lock } from "lucide-react";
import { toast } from "sonner";
import type { TimelineItem } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiAll, useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { formatDate, formatTime } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows, Page, PageHeader } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Tag } from "@/components/ui/tag";
import { NoteView } from "@/features/encounter/NoteView";

const S = "chart.timeline";
const KINDS: Array<{ value: TimelineItem["kind"]; label: string }> = [
  { value: "encounter", label: "Visits" },
  { value: "result", label: "Results" },
  { value: "document", label: "Documents" },
  { value: "communication", label: "Messages" },
  { value: "immunization", label: "Immunizations" },
];
const KIND_LABEL: Record<string, string> = {
  encounter: "Visit",
  result: "Result",
  document: "Document",
  communication: "Message",
  immunization: "Immunization",
};

/** chart.timeline: visits, results, documents and messages by date; signed notes open in a pane (INV-SAFE-02 addenda). */
export function TimelinePage() {
  const { patientId = "" } = useParams();
  const v = useView();
  const [types, setTypes] = React.useState<string[]>(KINDS.map((k) => k.value));
  const items = useApiAll("getPatientTimeline", { params: { patientId }, query: { types } });
  const byDay = React.useMemo(() => {
    const out = new Map<string, TimelineItem[]>();
    for (const i of (items.data ?? []) as TimelineItem[])
      out.set(i.at.slice(0, 10), [...(out.get(i.at.slice(0, 10)) ?? []), i]);
    return [...out.entries()];
  }, [items.data]);
  const open = v.view === "note" && v.id ? v.id : null;

  return (
    <Page>
      <PageHeader
        title="Timeline"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-testid={tid(S, "type-filter")}>
                <Filter size={18} strokeWidth={1.75} />
                Show {types.length === KINDS.length ? "all" : types.length}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {KINDS.map((k) => (
                <DropdownMenuCheckboxItem
                  key={k.value}
                  checked={types.includes(k.value)}
                  onCheckedChange={(c) =>
                    setTypes((t) => (c ? [...t, k.value] : t.filter((x) => x !== k.value)))
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {k.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <div
        className={cn(
          "grid items-start gap-6",
          open ? "grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" : "grid-cols-1",
        )}
      >
        <Card data-testid={tid(S, "timeline")}>
          {items.isLoading ? <LoadingRows rows={6} /> : null}
          {!items.isLoading && !byDay.length ? (
            <p className="text-body text-ink-2">Nothing in the record yet.</p>
          ) : null}
          <ol className="grid gap-6">
            {byDay.map(([day, rows]) => (
              <li key={day} className="grid gap-2">
                <h3 className="text-label tabular-nums text-ink-2">{formatDate(day)}</h3>
                <ul>
                  {rows.map((i) => {
                    const openable =
                      i.kind === "encounter" && i.entityType === "ClinicalNote" && !i.restricted;
                    return (
                      <li key={i.id} className="border-b border-line last:border-0">
                        <button
                          type="button"
                          disabled={!openable}
                          onClick={() => v.open("note", i.entityId)}
                          data-testid={openable ? tid(S, "tl-open-visit") : undefined}
                          className={cn(
                            "grid w-full grid-cols-[96px_minmax(0,1fr)_auto] items-baseline gap-3 py-3 text-left",
                            openable && "hover:bg-surface-hover",
                            open === i.entityId && "bg-pine-50",
                          )}
                        >
                          <span className="text-small tabular-nums text-ink-2">
                            {KIND_LABEL[i.kind]} · {formatTime(i.at)}
                          </span>
                          <span className="grid">
                            <span className="flex items-center gap-2 font-semibold">
                              {i.restricted ? (
                                <Lock size={16} strokeWidth={1.75} aria-hidden />
                              ) : null}
                              {i.title}
                            </span>
                            {i.summary ? (
                              <span className="text-small text-ink-2">{i.summary}</span>
                            ) : null}
                            {i.author ? (
                              <span className="text-small text-ink-2">{i.author}</span>
                            ) : null}
                          </span>
                          {i.status ? <Tag tone="outline">{i.status}</Tag> : <span />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </Card>
        {open ? <NotePane noteId={open} onClose={v.close} /> : null}
      </div>
    </Page>
  );
}

function NotePane({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const { can } = useAuth();
  const note = useApi("getNoteDetail", { params: { noteId } });
  const dx = useApi(
    "listEncounterDiagnoses",
    { params: { encounterId: note.data?.encounterId ?? "" } },
    { enabled: !!note.data },
  );
  const [addendum, setAddendum] = React.useState(false);
  const [printing, setPrinting] = React.useState(false);
  const signed = note.data && ["SIGNED", "ADDENDED"].includes(note.data.status);
  const print = async () => {
    setPrinting(true);
    try {
      openBlob((await api("getNotePdf", { params: { noteId } })) as unknown as Blob);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPrinting(false);
    }
  };
  return (
    <Card data-testid={tid(S, "signed-note")} className="sticky top-60">
      <CardHeader
        title="Visit note"
        actions={
          <>
            {signed && can("addAddendum") ? (
              <Button
                size="sm"
                onClick={() => setAddendum(true)}
                data-testid={tid(S, "add-addendum")}
              >
                Add addendum
              </Button>
            ) : null}
            {can("getNotePdf") ? (
              <Button
                size="sm"
                onClick={() => void print()}
                disabled={printing}
                data-testid={tid(S, "print-note")}
              >
                Print
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      />
      {note.error ? <Alert tone="caution">{errorMessage(note.error)}</Alert> : null}
      {note.data ? (
        <NoteView note={note.data} diagnoses={dx.data ?? []} />
      ) : (
        <LoadingRows rows={6} />
      )}
      {note.data ? (
        <AddendumDialog noteId={noteId} open={addendum} onOpenChange={setAddendum} />
      ) : null}
    </Card>
  );
}

export function AddendumDialog({
  noteId,
  open,
  onOpenChange,
}: {
  noteId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [text, setText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const add = useApiMutation("addAddendum", {
    invalidates: ["getNoteDetail", "getNote", "getPatientTimeline", "listPatientNotes"],
    onSuccess: () => (toast("Addendum signed."), setText(""), setReason(""), onOpenChange(false)),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[560px]" data-testid="chart.timeline/addendum">
        <DialogHeader>
          <DialogTitle>Sign an addendum?</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-body text-ink-2">
            The signed note stays as it is. The addendum is added below it with your name and the
            time.
          </p>
          <FieldShell label="Addendum" htmlFor="ad-text" required>
            <Textarea
              id="ad-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-32"
              data-testid={tid(S, "addendum-text")}
            />
          </FieldShell>
          <FieldShell
            label="Reason"
            htmlFor="ad-reason"
            required
            hint="For example: late entry, correction, result follow-up."
          >
            <Input id="ad-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FieldShell>
          {error ? <Alert tone="caution">{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid={tid(S, "addendum-cancel")}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!text.trim() || !reason.trim() || add.isPending}
            onClick={() =>
              add.mutate({ params: { noteId }, body: { text: text.trim(), reason: reason.trim() } })
            }
            data-testid={tid(S, "addendum-sign")}
          >
            Sign addendum
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
