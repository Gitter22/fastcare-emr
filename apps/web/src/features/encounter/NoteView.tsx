import type { ClinicalNoteDetail, Condition } from "@agile-emr/shared";
import { formatDateTime } from "@/lib/format";

/** Base note sections in display order (the API's notes/domain.ts BASE_SECTIONS). A&P is keyed `ap:<conditionId>`. */
export const NOTE_SECTIONS = [
  { key: "cc", title: "Chief complaint" },
  { key: "hpi", title: "History of present illness" },
  { key: "ros", title: "Review of systems" },
  { key: "exam", title: "Exam" },
  { key: "data", title: "Data reviewed" },
] as const;
export const apKey = (conditionId: string) => `ap:${conditionId}`;

/** Read-only note: signed notes, notes locked by another user, co-sign review. INV-SAFE-02: addenda below, never inline. */
export function NoteView({
  note,
  diagnoses,
  testId,
}: {
  note: ClinicalNoteDetail;
  diagnoses: Condition[];
  testId?: string;
}) {
  const text = (key: string) => note.sections.find((s) => s.key === key)?.content?.trim();
  return (
    <article className="grid gap-5" data-testid={testId}>
      {NOTE_SECTIONS.map((s) =>
        text(s.key) ? (
          <section key={s.key} className="grid gap-1">
            <h4 className="text-label uppercase tracking-wide">{s.title}</h4>
            <p className="whitespace-pre-wrap text-body">{text(s.key)}</p>
          </section>
        ) : null,
      )}
      {diagnoses.length ? (
        <section className="grid gap-3">
          <h4 className="text-label uppercase tracking-wide">Assessment and plan</h4>
          {diagnoses.map((d, i) => (
            <div key={d.id} className="grid gap-1">
              <p className="flex items-baseline justify-between gap-3">
                <b className="font-semibold">
                  {i + 1}. {d.display}
                </b>
                <span className="tabular-nums text-small text-ink-2">{d.icd10Code}</span>
              </p>
              {text(apKey(d.id)) ? (
                <p className="whitespace-pre-wrap text-body">{text(apKey(d.id))}</p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {note.signedAt ? (
        <p className="text-small text-ink-2">
          Signed {formatDateTime(note.signedAt)}
          {note.status === "PENDING_COSIGN" ? " · waiting for co-signature" : ""}
          {note.cosignedAt ? ` · co-signed ${formatDateTime(note.cosignedAt)}` : ""}
        </p>
      ) : null}
      {note.addenda.map((a) => (
        <section key={a.id} className="grid gap-1 bg-surface-muted p-4" data-testid="addendum">
          <h4 className="text-label uppercase tracking-wide">
            Addendum · {formatDateTime(a.signedAt)}
          </h4>
          <p className="whitespace-pre-wrap text-body">{a.text}</p>
        </section>
      ))}
    </article>
  );
}
