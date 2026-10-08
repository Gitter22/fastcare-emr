import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import type { AiDraftSegment, CopyForwardResult } from "@agile-emr/shared";
import { LOINC } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { readingsByCode, vitalText } from "@/lib/clinical";
import { formatDateTime, formatShortDate, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, LoadingRows } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { AddendumDialog } from "@/features/chart/Timeline";
import { ContextDrawer } from "./ContextDrawer";
import { EncounterBody, useEncounter } from "./EncounterWorkspace";
import { NOTE_SECTIONS, NoteView, apKey } from "./NoteView";
import { SectionEditor, insertAtCaret } from "./SectionEditor";
import { useNoteDraft } from "./useNoteDraft";
import { useEncounterField } from "./useEncounterField";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const S = "encounter.note";
const AMBIENT_REASON = "Ambient documentation is off until a vendor is chosen (OPEN-Q8).";

/** encounter.note (flow:encounter/01-03): document the visit with templates, smart phrases and per-problem A&P. */
export function NotePage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can, role } = useAuth();
  const navigate = useNavigate();
  const d = useNoteDraft();
  const phrases = useApi("listSmartPhrases", { query: {} }, { staleTime: 300_000 });
  const templates = useApi("listNoteTemplates", { query: {} }, { staleTime: 300_000 });
  const rooming = useApi("getRooming", { params: { encounterId } });
  const summary = useApi("getPatientSummary", { params: { patientId } });
  const prior = useApi("listPatientNotes", {
    params: { patientId },
    query: { status: ["SIGNED", "ADDENDED"], limit: 5 },
  });
  const priorNote = prior.data?.data.find((n) => n.encounterId !== encounterId);
  const refs = React.useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [focused, setFocused] = React.useState<string>("hpi");
  const [tplConfirm, setTplConfirm] = React.useState<{ id: string; name: string } | null>(null);
  const [copy, setCopy] = React.useState<CopyForwardResult | null>(null);
  const [addendum, setAddendum] = React.useState(false);
  const isProvider = role === "provider";
  const appt = encounter.appointment;
  const start = useApiMutation("startVisit", {
    invalidates: ["getEncounter", "getProviderWorklist"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ready = useApiMutation("markNoteReadyToSign", {
    invalidates: ["getNote", "getEncounter"],
    onSuccess: (n) => (
      d.apply(n),
      toast("Marked ready to sign. The provider sees it on their worklist.")
    ),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const dx = encounter.diagnoses;
  const problemCodes = new Set((summary.data?.problems ?? []).map((p) => p.icd10Code));
  const pendingAi = (d.note?.aiSegments ?? []).filter((s) => s.status === "PENDING");
  const sectionOf = (seg: AiDraftSegment) =>
    d.note?.sections.find((s) => s.id === seg.sectionId)?.key;
  const filled = (key: string) => !!d.draft[key]?.trim();
  const incomplete =
    NOTE_SECTIONS.filter((s) => !filled(s.key)).length +
    dx.filter((x) => !filled(apKey(x.id))).length;

  if (d.loadError)
    return (
      <EncounterBody>
        <Alert tone="caution">{errorMessage(d.loadError)}</Alert>
      </EncounterBody>
    );
  if (!d.note)
    return (
      <EncounterBody>
        <LoadingRows rows={8} />
      </EncounterBody>
    );
  const note = d.note;
  const editable = !d.readOnly && !d.lockedByOther;

  const applyTemplate = async (id: string, mode: "replace" | "append") => {
    await d.flush();
    try {
      d.apply(
        await api("applyNoteTemplate", {
          params: { noteId: note.id },
          body: { noteTemplateId: id, mode, version: d.version() },
        }),
      );
      toast("Template applied.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const pickTemplate = (t: { id: string; name: string }) =>
    NOTE_SECTIONS.some((s) => s.key !== "cc" && filled(s.key))
      ? setTplConfirm(t)
      : void applyTemplate(t.id, "replace");
  const copyForward = async () => {
    try {
      setCopy(await api("copyForwardNote", { params: { noteId: note.id } }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const insertPhrase = (text: string) => {
    const el = refs.current[focused] ?? null;
    d.edit(focused, insertAtCaret(el, d.draft[focused] ?? "", text));
    el?.focus();
  };
  const vitals = readingsByCode(rooming.data?.vitals ?? []);
  const vitalsLine = [
    [LOINC.bpPanel, "BP"],
    [LOINC.heartRate, "HR"],
    [LOINC.temperature, "T"],
    [LOINC.spo2, "SpO₂"],
    [LOINC.bmi, "BMI"],
  ]
    .map(([code, label]) => {
      const r = vitals.get(code!) ?? [];
      if (!r.length) return null;
      return `${label} ${r.map((o, i) => (i ? `repeat ${vitalText(o)}` : vitalText(o))).join(", ")}`;
    })
    .filter(Boolean)
    .join(" · ");

  const actionBar = (
    <>
      <span className="mr-auto text-body text-ink-2" data-testid={tid(S, "open-items")}>
        {[
          note.status === "DRAFT"
            ? "Draft"
            : note.status === "READY_TO_SIGN"
              ? "Ready to sign"
              : null,
          incomplete ? `${pluralize(incomplete, "section")} incomplete` : null,
          pendingAi.length ? `${pluralize(pendingAi.length, "AI draft")} to review` : null,
          d.state === "saving" ? "Saving…" : d.state === "dirty" ? "Unsaved changes" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {editable ? (
        <Button
          variant="ghost"
          onClick={() => void d.flush()}
          disabled={d.state === "saving"}
          data-testid={tid(S, "save-draft")}
        >
          Save draft
        </Button>
      ) : null}
      {isBuilt("encounter.avs") ? (
        <Button
          onClick={() => navigate(pathTo("encounter.avs", { patientId, encounterId }))}
          data-testid={tid(S, "preview-avs")}
        >
          Preview AVS
        </Button>
      ) : null}
      {editable && can("signNote") ? (
        <Button
          variant="primary"
          onClick={() =>
            void d
              .flush()
              .then(() => navigate(pathTo("encounter.sign", { patientId, encounterId })))
          }
          data-testid={tid(S, "sign")}
        >
          Sign &amp; lock…
        </Button>
      ) : null}
      {editable && !can("signNote") && note.status === "DRAFT" && can("markNoteReadyToSign") ? (
        <Button
          variant="primary"
          disabled={ready.isPending}
          onClick={() =>
            void d.flush().then(() =>
              ready.mutate({
                params: { noteId: note.id },
                body: { to: "ready-to-sign", version: d.version() },
              }),
            )
          }
        >
          Mark ready to sign
        </Button>
      ) : null}
      {(note.status === "SIGNED" || note.status === "ADDENDED") && can("addAddendum") ? (
        <Button
          variant="primary"
          onClick={() => setAddendum(true)}
          data-testid={tid(S, "add-addendum")}
        >
          Add addendum
        </Button>
      ) : null}
    </>
  );

  return (
    <EncounterBody
      drawer={
        <ContextDrawer
          onCopyForward={editable && can("copyForwardNote") ? () => void copyForward() : undefined}
        />
      }
      actionBar={actionBar}
    >
      {isProvider &&
      appt &&
      (appt.status === "READY_FOR_PROVIDER" || appt.status === "ROOMED") &&
      can("startVisit") ? (
        <Alert
          title="The patient is ready."
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={start.isPending}
              onClick={() =>
                start.mutate({
                  params: { appointmentId: appt.id },
                  body: { to: "with-provider", version: appt.version },
                })
              }
            >
              Start visit
            </Button>
          }
        >
          Starting the visit shows you as with the patient on the flow board.
        </Alert>
      ) : null}
      {d.lockedByOther && note.lock ? (
        <Alert
          tone="caution"
          title={`${note.lock.heldBy} is editing this note.`}
          testId={tid(S, "locked-banner")}
        >
          You can read it. Editing opens when they leave the note or after two minutes without
          changes.
        </Alert>
      ) : null}
      {d.error ? <Alert tone="caution">{d.error}</Alert> : null}
      {d.readOnly ? (
        <Card data-testid={tid(S, "signed-note")}>
          <p className="mb-4 text-body text-ink-2">
            {note.status === "PENDING_COSIGN"
              ? "Signed and waiting for co-signature. "
              : "Signed and locked. "}
            Changes are added as addenda
            {note.signedAt ? ` · signed ${formatDateTime(note.signedAt)}` : ""}.
          </p>
          <NoteView note={note} diagnoses={dx} />
        </Card>
      ) : (
        <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-6">
          <nav
            aria-label="Note sections"
            className="sticky top-64 grid gap-1"
            data-testid={tid(S, "section-index")}
          >
            {[
              ...NOTE_SECTIONS.map((s) => ({ key: s.key, title: s.title, done: filled(s.key) })),
              {
                key: "ap",
                title: "Assessment & plan",
                done: dx.length > 0 && dx.every((x) => filled(apKey(x.id))),
              },
            ].map((s) => (
              <a
                key={s.key}
                href={`#sec-${s.key}`}
                className="flex items-center gap-3 px-2 py-2 text-body hover:bg-surface-hover"
                data-testid={tid(S, "idx-item")}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 rounded-full border-2 border-ink",
                    s.done && "bg-ink",
                  )}
                />
                <span>{s.title}</span>
                <span className="sr-only">{s.done ? "written" : "empty"}</span>
              </a>
            ))}
            {note.templateId ? (
              <p className="mt-4 px-2 text-small text-ink-2" data-testid={tid(S, "template-name")}>
                Template
                <br />
                <b className="text-ink">
                  {templates.data?.find((t) => t.id === note.templateId)?.name}
                </b>
              </p>
            ) : null}
          </nav>
          <div className="grid gap-4">
            <div
              className="flex flex-wrap items-center gap-2"
              role="toolbar"
              aria-label="Note tools"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={!editable} data-testid={tid(S, "template-menu")}>
                    Template <ChevronDown size={16} strokeWidth={1.75} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {(templates.data ?? []).map((t) => (
                    <DropdownMenuItem key={t.id} onSelect={() => pickTemplate(t)}>
                      {t.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={!editable} data-testid={tid(S, "smart-phrase")}>
                    Smart phrase <span className="text-ink-2">.</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-96">
                  {(phrases.data ?? []).map((p) => (
                    <DropdownMenuItem key={p.id} onSelect={() => insertPhrase(p.text)}>
                      <span className="grid">
                        <b className="font-semibold">.{p.trigger}</b>
                        <span className="line-clamp-1 text-small text-ink-2">{p.text}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Unavailable reason={AMBIENT_REASON}>
                <Button size="sm" disabled data-testid={tid(S, "dictate")}>
                  Dictate
                </Button>
              </Unavailable>
              {can("copyForwardNote") ? (
                priorNote ? (
                  <Button
                    size="sm"
                    disabled={!editable}
                    onClick={() => void copyForward()}
                    data-testid={tid(S, "copy-forward")}
                  >
                    Copy forward {formatShortDate(priorNote.dateOfService)}
                  </Button>
                ) : (
                  <Unavailable reason="There's no earlier signed note to copy from.">
                    <Button size="sm" disabled data-testid={tid(S, "copy-forward")}>
                      Copy forward
                    </Button>
                  </Unavailable>
                )
              ) : null}
              <span className="ml-auto">
                <Unavailable reason={AMBIENT_REASON}>
                  <Tag tone="outline" data-testid={tid(S, "ambient-status")}>
                    Ambient draft: off
                  </Tag>
                </Unavailable>
              </span>
            </div>
            <Card className="grid gap-6">
              {NOTE_SECTIONS.map((s) => (
                <section key={s.key} id={`sec-${s.key}`} className="grid scroll-mt-72 gap-2">
                  <label
                    htmlFor={`sec-input-${s.key}`}
                    className="text-label uppercase tracking-wide"
                  >
                    {s.title}
                  </label>
                  {s.key === "exam" && vitalsLine ? (
                    <p className="text-body" data-testid={tid(S, "exam-vitals")}>
                      <b className="font-semibold">Vitals</b> {vitalsLine}
                    </p>
                  ) : null}
                  <SectionEditor
                    ref={(el) => void (refs.current[s.key] = el)}
                    id={`sec-input-${s.key}`}
                    label={s.title}
                    value={d.draft[s.key] ?? ""}
                    onChange={(v) => d.edit(s.key, v)}
                    phrases={phrases.data ?? []}
                    disabled={!editable}
                    placeholder={editable ? "Type, or use a template or .phrase" : ""}
                    testId={tid(S, `sec-${s.key}`)}
                    onFocusSection={() => setFocused(s.key)}
                  />
                  {pendingAi
                    .filter((seg) => sectionOf(seg) === s.key)
                    .map((seg) => (
                      <AiSegmentCard
                        key={seg.id}
                        seg={seg}
                        canDecide={can("decideAiSegment")}
                        version={d.version}
                        onDecided={() => void d.refetch()}
                      />
                    ))}
                </section>
              ))}
              <section id="sec-ap" className="grid scroll-mt-72 gap-3">
                <h3 className="text-label uppercase tracking-wide">Assessment &amp; plan</h3>
                {dx.map((x, i) => (
                  <div
                    key={x.id}
                    className="grid gap-2 bg-surface-muted p-4"
                    data-testid={tid(S, "problem-block")}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <b className="font-semibold">
                        {i + 1}. {x.display}
                      </b>
                      <span
                        className="shrink-0 text-small tabular-nums text-ink-2"
                        data-testid={tid(S, "pb-code")}
                      >
                        {x.icd10Code} ·{" "}
                        {problemCodes.has(x.icd10Code ?? "") ? "problem list" : "this visit only"}
                      </span>
                    </div>
                    <SectionEditor
                      ref={(el) => void (refs.current[apKey(x.id)] = el)}
                      id={`sec-input-ap-${x.id}`}
                      label={`Plan for ${x.display}`}
                      value={d.draft[apKey(x.id)] ?? ""}
                      onChange={(v) => d.edit(apKey(x.id), v)}
                      phrases={phrases.data ?? []}
                      disabled={!editable}
                      placeholder={editable ? "Assessment and plan for this problem" : ""}
                      className="bg-surface"
                      onFocusSection={() => setFocused(apKey(x.id))}
                    />
                    {pendingAi
                      .filter((seg) => sectionOf(seg) === apKey(x.id))
                      .map((seg) => (
                        <AiSegmentCard
                          key={seg.id}
                          seg={seg}
                          canDecide={can("decideAiSegment")}
                          version={d.version}
                          onDecided={() => void d.refetch()}
                        />
                      ))}
                  </div>
                ))}
                {!dx.length ? (
                  <p className="text-body text-ink-2">
                    No diagnoses yet. Add the problems you addressed today.
                  </p>
                ) : null}
                <FollowUpField disabled={!editable || !can("updateEncounter")} />
                {isBuilt("encounter.dx-coding") && can("addEncounterDiagnosis") && editable ? (
                  <Button
                    className="justify-self-start"
                    onClick={() =>
                      navigate(pathTo("encounter.dx-coding", { patientId, encounterId }))
                    }
                    data-testid={tid(S, "add-problem")}
                  >
                    + Add problem
                  </Button>
                ) : null}
              </section>
            </Card>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!tplConfirm}
        onOpenChange={(o) => !o && setTplConfirm(null)}
        title={`Apply ${tplConfirm?.name ?? "template"}?`}
        description="The template text is added after what you've already written. Nothing is removed."
        action="Apply"
        onConfirm={() => tplConfirm && void applyTemplate(tplConfirm.id, "append")}
      />
      {copy ? (
        <CopyForwardDialog
          result={copy}
          current={d.draft}
          onClose={() => setCopy(null)}
          onApply={(sections) => {
            for (const [key, text] of sections) d.edit(key, text);
            setCopy(null);
            toast("Copied. Review each line before signing.");
          }}
        />
      ) : null}
      <AddendumDialog noteId={note.id} open={addendum} onOpenChange={setAddendum} />
    </EncounterBody>
  );
}

/** INV-DATA-02: AI-drafted text stays marked until the author accepts, edits or discards it. */
function AiSegmentCard({
  seg,
  canDecide,
  version,
  onDecided,
}: {
  seg: AiDraftSegment;
  canDecide: boolean;
  version: () => number;
  onDecided: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(seg.text);
  const decide = useApiMutation("decideAiSegment", {
    invalidates: ["getEncounter", "getSignPreflight"],
    onSuccess: () => onDecided(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const go = (decision: "accept" | "edit" | "discard") =>
    decide.mutate({
      params: { aiSegmentId: seg.id },
      body: { decision, version: version(), ...(decision === "edit" ? { editedText: text } : {}) },
    });
  return (
    <div
      className="grid gap-2 bg-surface-muted p-4 outline-dashed outline-1 -outline-offset-1 outline-ink"
      data-testid={tid(S, "ai-segment")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Tag tone="neutral" className="bg-ink text-on-primary">
          AI draft · not accepted
        </Tag>
        <span className="text-small text-ink-2">{seg.model}</span>
        {canDecide ? (
          <span className="ml-auto flex gap-2">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!text.trim() || decide.isPending}
                  onClick={() => go("edit")}
                >
                  Save edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (setEditing(false), setText(seg.text))}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={decide.isPending}
                  onClick={() => go("accept")}
                  data-testid={tid(S, "ai-accept")}
                >
                  Accept
                </Button>
                <Button size="sm" onClick={() => setEditing(true)} data-testid={tid(S, "ai-edit")}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decide.isPending}
                  onClick={() => go("discard")}
                  data-testid={tid(S, "ai-discard")}
                >
                  Discard
                </Button>
              </>
            )}
          </span>
        ) : (
          <span className="ml-auto text-small text-ink-2">Waiting for the provider's review</span>
        )}
      </div>
      {editing ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Edit AI draft"
        />
      ) : (
        <p className="whitespace-pre-wrap text-body">{seg.text}</p>
      )}
    </div>
  );
}

/** Copy forward with a per-section diff and stale-data warnings (flow:encounter/02 failure). */
function CopyForwardDialog({
  result,
  current,
  onClose,
  onApply,
}: {
  result: CopyForwardResult;
  current: Record<string, string>;
  onClose: () => void;
  onApply: (sections: Array<[string, string]>) => void;
}) {
  const [pick, setPick] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(result.sections.map((s) => [s.key, !current[s.key]?.trim()])),
  );
  const title = (k: string) => NOTE_SECTIONS.find((s) => s.key === k)?.title ?? k;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[760px]" data-testid={tid(S, "copy-forward-dialog")}>
        <DialogHeader>
          <DialogTitle>Copy forward?</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto">
          <Alert tone="caution">
            <ul className="grid gap-1">
              {result.staleItems.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Alert>
          {result.sections.map((s) => (
            <div key={s.key} className="grid gap-2">
              <Checkbox
                checked={!!pick[s.key]}
                onCheckedChange={(v) => setPick((p) => ({ ...p, [s.key]: v === true }))}
                label={`${title(s.key)}${current[s.key]?.trim() ? " (replaces what you wrote)" : ""}`}
              />
              <div className="grid grid-cols-2 gap-3 text-body">
                <div className="grid gap-1">
                  <span className="text-small text-ink-2">Now</span>
                  <p className="whitespace-pre-wrap bg-surface-muted p-3">
                    {current[s.key]?.trim() || "Empty"}
                  </p>
                </div>
                <div className="grid gap-1">
                  <span className="text-small text-ink-2">Copied</span>
                  <p className="whitespace-pre-wrap bg-surface-muted p-3">{s.content}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!Object.values(pick).some(Boolean)}
            onClick={() =>
              onApply(result.sections.filter((s) => pick[s.key]).map((s) => [s.key, s.content]))
            }
          >
            Copy selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Follow-up instruction (Encounter.followUpInstruction): shown to the front desk at checkout and on the AVS. */
function FollowUpField({ disabled }: { disabled: boolean }) {
  const f = useEncounterField("followUpInstruction");
  return (
    <FieldShell
      label="Follow-up"
      htmlFor="followup"
      hint="For example: return in 4 weeks for BP recheck. The front desk books it at checkout."
    >
      <Input id="followup" {...f} disabled={disabled} data-testid="encounter.note/follow-up" />
    </FieldShell>
  );
}
