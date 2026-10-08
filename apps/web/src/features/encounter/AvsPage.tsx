import * as React from "react";
import { toast } from "sonner";
import type { AfterVisitSummary } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { formatDate, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { EncounterBody, useEncounter } from "./EncounterWorkspace";

const S = "encounter.avs";

/** The API's generated AVS content (modules/encounters/avs.ts AvsContent). */
export interface AvsContent {
  visit: { title: string; date: string; provider: string; location: string | null };
  reason: string | null;
  diagnoses: string[];
  vitals: Array<{ label: string; value: string }>;
  medications: { current: string[]; started: string[]; stopped: string[] };
  allergies: string[];
  followUp: string | null;
}

export const AVS_LABELS = {
  en: {
    title: "After-visit summary",
    reason: "Why you came in",
    diagnoses: "What we found",
    vitals: "Your measurements today",
    instructions: "What to do next",
    followUp: "Follow-up",
    started: "Medicines started today",
    stopped: "Medicines to stop",
    current: "Your medicine list",
    allergies: "Allergies on file",
    none: "None",
  },
  es: {
    title: "Resumen de la visita",
    reason: "Motivo de la visita",
    diagnoses: "Lo que encontramos",
    vitals: "Sus mediciones de hoy",
    instructions: "Qué hacer ahora",
    followUp: "Seguimiento",
    started: "Medicamentos que empezó hoy",
    stopped: "Medicamentos que debe dejar",
    current: "Su lista de medicamentos",
    allergies: "Alergias registradas",
    none: "Ninguno",
  },
} as const;

/** Plain-language AVS as the patient will see it (screen and checkout share it). */
export function AvsPreview({ avs, testId }: { avs: AfterVisitSummary; testId?: string }) {
  const c = avs.content as AvsContent;
  const L = AVS_LABELS[avs.language === "es" ? "es" : "en"];
  const list = (items: string[]) =>
    items.length ? (
      <ul className="list-disc pl-5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    ) : (
      <p className="text-ink-2">{L.none}</p>
    );
  const block = (title: string, body: React.ReactNode) => (
    <section className="grid gap-1">
      <h4 className="text-label uppercase tracking-wide">{title}</h4>
      <div className="text-body">{body}</div>
    </section>
  );
  if (!c?.visit)
    return (
      <p className="text-body text-ink-2">The summary is generated when the visit is documented.</p>
    );
  return (
    <article className="grid gap-4" data-testid={testId}>
      <p className="text-body">
        <b className="font-semibold">{c.visit.title}</b> · {formatDate(c.visit.date)} ·{" "}
        {c.visit.provider}
        {c.visit.location ? ` · ${c.visit.location}` : ""}
      </p>
      {c.reason ? block(L.reason, c.reason) : null}
      {block(L.diagnoses, list(c.diagnoses))}
      {c.vitals.length
        ? block(
            L.vitals,
            <span className="tabular-nums">
              {c.vitals.map((v) => `${v.label} ${v.value}`).join(" · ")}
            </span>,
          )
        : null}
      {avs.instructions?.trim()
        ? block(L.instructions, <p className="whitespace-pre-wrap">{avs.instructions}</p>)
        : null}
      {c.followUp ? block(L.followUp, c.followUp) : null}
      {c.medications.started.length ? block(L.started, list(c.medications.started)) : null}
      {c.medications.stopped.length ? block(L.stopped, list(c.medications.stopped)) : null}
      {block(L.current, list(c.medications.current))}
      {block(L.allergies, list(c.allergies))}
    </article>
  );
}

export async function printAvs(encounterId: string) {
  try {
    openBlob(
      (await api("getAfterVisitSummaryPdf", { params: { encounterId } })) as unknown as Blob,
    );
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/** encounter.avs (flow:encounter/08): plain-language summary and instructions; released to the portal after signing. */
export function AvsPage() {
  const { encounter, encounterId } = useEncounter();
  const { can } = useAuth();
  const avs = useApi("getAfterVisitSummary", { params: { encounterId } });
  const [instructions, setInstructions] = React.useState("");
  const [follow, setFollow] = React.useState("");
  React.useEffect(() => setInstructions(avs.data?.instructions ?? ""), [avs.data?.instructions]);
  React.useEffect(
    () => setFollow(encounter.followUpInstruction ?? ""),
    [encounter.followUpInstruction],
  );
  const update = useApiMutation("updateAfterVisitSummary", {
    invalidates: ["getAfterVisitSummary"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const updateEnc = useApiMutation("updateEncounter", {
    invalidates: ["getEncounter", "getAfterVisitSummary"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const release = useApiMutation("releaseAfterVisitSummary", {
    invalidates: ["getAfterVisitSummary", "getCheckout"],
    onSuccess: () => toast("Released to the patient portal."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const a = avs.data;
  const signed =
    !!encounter.note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(encounter.note.status);
  const released = !!a?.releasedAt;
  const releaseButton = (
    <Button
      variant="primary"
      disabled={!signed || released || release.isPending}
      onClick={() => release.mutate({ params: { encounterId } })}
      data-testid={tid(S, "avs-release")}
    >
      Release to portal
    </Button>
  );
  const actionBar = (
    <>
      <span className="mr-auto text-body text-ink-2">
        {released ? `Released ${formatDateTime(a!.releasedAt)}` : "Not released yet"}
      </span>
      <Button
        onClick={() => void printAvs(encounterId)}
        disabled={!a}
        data-testid={tid(S, "avs-print")}
      >
        Print
      </Button>
      {can("releaseAfterVisitSummary") ? (
        signed ? (
          releaseButton
        ) : (
          <Unavailable reason="Sign the visit note first.">{releaseButton}</Unavailable>
        )
      ) : null}
    </>
  );
  return (
    <EncounterBody actionBar={actionBar}>
      {!a ? (
        <LoadingRows rows={8} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-6">
          <Card data-testid={tid(S, "avs-preview")}>
            <CardHeader
              title={AVS_LABELS[a.language === "es" ? "es" : "en"].title}
              actions={released ? <Tag tone="neutral">Released to portal</Tag> : null}
            />
            <AvsPreview avs={a} />
          </Card>
          <Card className="grid gap-4">
            <FieldShell label="Language">
              <Select
                value={a.language}
                onValueChange={(language) =>
                  update.mutate({ params: { encounterId }, body: { language } })
                }
                aria-label="Language"
                disabled={released || !can("updateAfterVisitSummary")}
                testId={tid(S, "avs-language")}
                options={[
                  { value: "en", label: "English" },
                  { value: "es", label: "Spanish" },
                ]}
              />
            </FieldShell>
            <FieldShell
              label="Follow-up"
              htmlFor="avs-followup"
              hint="Also shown to the front desk at checkout."
            >
              <Textarea
                id="avs-followup"
                value={follow}
                disabled={signed || !can("updateEncounter")}
                onChange={(e) => setFollow(e.target.value)}
                onBlur={() =>
                  follow.trim() !== (encounter.followUpInstruction ?? "") &&
                  updateEnc.mutate({
                    params: { encounterId },
                    version: encounter.version,
                    body: { followUpInstruction: follow.trim() || null },
                  })
                }
                className="min-h-16"
              />
            </FieldShell>
            <FieldShell
              label="Patient instructions"
              htmlFor="avs-instructions"
              hint="Plain language. Saved when you leave the field."
            >
              <Textarea
                id="avs-instructions"
                value={instructions}
                disabled={released || !can("updateAfterVisitSummary")}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={() =>
                  instructions !== (a.instructions ?? "") &&
                  update.mutate({
                    params: { encounterId },
                    body: { instructions: instructions.trim() || null },
                  })
                }
                className="min-h-40"
                data-testid={tid(S, "avs-instructions")}
              />
            </FieldShell>
            <FieldShell label="Education materials">
              <Unavailable reason="The patient education library isn't connected yet.">
                <Button disabled data-testid={tid(S, "avs-education")}>
                  Attach education
                </Button>
              </Unavailable>
            </FieldShell>
          </Card>
        </div>
      )}
    </EncounterBody>
  );
}
