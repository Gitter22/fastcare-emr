import * as React from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { toast } from "sonner";
import type { CodeHit, Condition } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardHeader } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { Icd10Picker, isUnspecified } from "@/components/domain/CodePickers";
import { ContextDrawer } from "./ContextDrawer";
import { EncounterBody, useEncounter } from "./EncounterWorkspace";

const S = "encounter.dx-coding";
const INVALIDATES = [
  "getEncounter",
  "listEncounterDiagnoses",
  "getSignPreflight",
  "getPatientSummary",
  "listConditions",
] as const;

/** encounter.dx-coding (flow:encounter/03): specific ICD-10-CM codes in claim order; problem list updated as needed. */
export function DxCodingPage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can } = useAuth();
  const dx = encounter.diagnoses;
  const problems = useApi("listConditions", {
    params: { patientId },
    query: { category: "PROBLEM_LIST_ITEM" },
  });
  const [code, setCode] = React.useState<CodeHit | null>(null);
  const [toProblemList, setToProblemList] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const signed =
    !!encounter.note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(encounter.note.status);
  const editable = can("addEncounterDiagnosis") && !signed;
  const category = code && isUnspecified(code.display) ? code.code.slice(0, 3) : "";
  const specific = useApi(
    "searchIcd10",
    { query: { q: category, billableOnly: true } },
    { enabled: !!category },
  );
  // Closest codes first: the longest shared code prefix (J01.0x before J01.8x for J01.00).
  const shared = (a: string) => [...a].findIndex((ch, i) => ch !== code?.code[i]);
  const alternatives = (specific.data ?? [])
    .filter((c) => c.code !== code?.code && !isUnspecified(c.display))
    .sort(
      (a, b) =>
        (shared(b.code) === -1 ? 99 : shared(b.code)) -
        (shared(a.code) === -1 ? 99 : shared(a.code)),
    )
    .slice(0, 6);
  const onList = (c: string | null | undefined) =>
    (problems.data ?? []).some((p) => p.icd10Code === c);

  const add = useApiMutation("addEncounterDiagnosis", {
    invalidates: [...INVALIDATES],
    onSuccess: (c) => (toast(`${c.display} added.`), setCode(null), setError(null)),
    onError: (e) => setError(errorMessage(e)),
  });
  const update = useApiMutation("updateEncounterDiagnosis", {
    invalidates: [...INVALIDATES],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useApiMutation("removeEncounterDiagnosis", {
    invalidates: [...INVALIDATES],
    onSuccess: () => toast("Removed from this visit."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const move = (c: Condition, delta: number) =>
    update.mutate({
      params: { encounterId, conditionId: c.id },
      body: { rank: (c.rank ?? 1) + delta, version: c.version },
    });

  return (
    <EncounterBody drawer={<ContextDrawer />}>
      {signed ? <Alert>The note is signed, so this visit's diagnoses are locked.</Alert> : null}
      {editable ? (
        <Card>
          <CardHeader title="Add a diagnosis" />
          <div className="grid gap-3">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <Icd10Picker
                  value={code}
                  onChange={setCode}
                  testId={tid(S, "dx-search")}
                  placeholder="Diagnosis in plain language or code"
                />
              </div>
              <Button
                variant="primary"
                disabled={!code || add.isPending}
                onClick={() =>
                  code &&
                  add.mutate({
                    params: { encounterId },
                    body: {
                      icd10Code: code.code,
                      display: code.display,
                      addToProblemList: toProblemList && !onList(code.code),
                    },
                  })
                }
              >
                Add to visit
              </Button>
            </div>
            {code && !onList(code.code) ? (
              <Checkbox
                checked={toProblemList}
                onCheckedChange={(v) => setToProblemList(v === true)}
                label="Add to problem list"
                data-testid={tid(S, "add-to-problem-list")}
              />
            ) : null}
            {category && alternatives.length ? (
              <Alert
                tone="caution"
                title={`${code!.code} is unspecified.`}
                testId={tid(S, "specificity-prompt")}
              >
                <span className="block">A more specific code may apply:</span>
                <span className="mt-2 flex flex-wrap gap-2">
                  {alternatives.map((a) => (
                    <Button key={a.code} size="sm" onClick={() => setCode(a)}>
                      {a.code} · {a.display}
                    </Button>
                  ))}
                </span>
              </Alert>
            ) : null}
            {error ? <Alert tone="caution">{error}</Alert> : null}
          </div>
        </Card>
      ) : null}
      <Card data-testid={tid(S, "dx-list")}>
        <CardHeader
          title="This visit's diagnoses"
          actions={<span className="text-small text-ink-2">Claim order</span>}
        />
        {dx.length ? (
          <ol>
            {dx.map((c, i) => (
              <li
                key={c.id}
                className="flex items-center gap-3 border-b border-line py-3 last:border-0"
              >
                <span className="w-6 text-h3 tabular-nums">{String.fromCharCode(65 + i)}</span>
                <span className="grid flex-1">
                  <b className="font-semibold">{c.display}</b>
                  <span className="text-small text-ink-2">
                    {c.icd10Code} ·{" "}
                    {onList(c.icd10Code) ? "on the problem list" : "this visit only"}
                    {isUnspecified(c.display) ? " · unspecified" : ""}
                  </span>
                </span>
                {editable ? (
                  <span className="flex gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${c.display} up`}
                      disabled={i === 0 || update.isPending}
                      onClick={() => move(c, -1)}
                    >
                      <ArrowUp size={16} strokeWidth={1.75} />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${c.display} down`}
                      disabled={i === dx.length - 1 || update.isPending}
                      onClick={() => move(c, 1)}
                    >
                      <ArrowDown size={16} strokeWidth={1.75} />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${c.display}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ params: { encounterId, conditionId: c.id } })}
                    >
                      <X size={16} strokeWidth={1.75} />
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-body text-ink-2">No diagnoses yet.</p>
        )}
      </Card>
      <Card data-testid={tid(S, "problem-list")}>
        <CardHeader
          title="Problem list"
          actions={
            <span className="text-small text-ink-2">Address a problem to add it to this visit</span>
          }
        />
        {(problems.data ?? []).length ? (
          <ul>
            {problems.data!.map((p) => {
              const addressed = dx.some((d) => d.icd10Code === p.icd10Code);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-0"
                >
                  <span>
                    {p.display}{" "}
                    <span className="tabular-nums text-ink-2">{p.icd10Code ?? "uncoded"}</span>
                  </span>
                  {addressed ? (
                    <span className="text-small text-ink-2">Addressed this visit</span>
                  ) : editable && p.icd10Code ? (
                    <Button
                      size="sm"
                      disabled={add.isPending}
                      onClick={() =>
                        add.mutate({
                          params: { encounterId },
                          body: { icd10Code: p.icd10Code!, conditionId: p.id },
                        })
                      }
                    >
                      Address this visit
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-body text-ink-2">No active problems.</p>
        )}
      </Card>
    </EncounterBody>
  );
}
