import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  formatMoney,
  fromCents,
  toCents,
  type ChargeItem,
  type EmLevelInput,
} from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { useView } from "@/lib/useView";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { RadioGroup } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { ContextDrawer } from "./ContextDrawer";
import { EncounterBody, useEncounter } from "./EncounterWorkspace";
import { CHARGE_INVALIDATES, LineDrawer, letter } from "./charges/LineDrawer";

const S = "encounter.charges";
const DX_INVALIDATES = [...CHARGE_INVALIDATES, "listEncounterDiagnoses"] as const;
const LEVELS = [
  { value: "minimal", label: "Min" },
  { value: "low", label: "Low" },
  { value: "moderate", label: "Mod" },
  { value: "high", label: "High" },
];
const DATA_LEVELS = [
  { value: "minimal", label: "Min" },
  { value: "limited", label: "Limited" },
  { value: "moderate", label: "Mod" },
  { value: "extensive", label: "Extensive" },
];
const isEm = (c: string) => /^992\d\d$/.test(c);

type Edit = {
  key: string;
  rule: string;
  severity: "error" | "warning";
  text: string;
  fix?: { addModifier?: string } | null;
  dismissed?: boolean;
  reason?: string;
};
const editsOf = (l: ChargeItem): Edit[] =>
  ((l.holdReasons as { edits?: Edit[] } | null | undefined)?.edits ?? []).filter(Boolean);
const onClaim = (l: ChargeItem) => l.status === "READY" || l.status === "BILLED";

/** encounter.charges (flow:encounter/06): visit level, coding edits and charge lines; released to billing when the note is signed. */
export function ChargesPage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can } = useAuth();
  const navigate = useNavigate();
  const v = useView();
  const charges = useApi("getEncounterCharges", { params: { encounterId } });
  const noteSigned =
    !!encounter.note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(encounter.note.status);
  const noCharge = encounter.noChargeVisit;
  const editable = can("addChargeItem") && !noteSigned && !noCharge;

  const [method, setMethod] = React.useState<"mdm" | "time">(
    encounter.emMethod === "time" ? "time" : "mdm",
  );
  const [problems, setProblems] = React.useState(encounter.mdmProblems ?? "minimal");
  const [data, setData] = React.useState(encounter.mdmData ?? "minimal");
  const [risk, setRisk] = React.useState(encounter.mdmRisk ?? "minimal");
  const [minutes, setMinutes] = React.useState(
    encounter.emTotalMinutes != null ? String(encounter.emTotalMinutes) : "",
  );
  const [newPatient, setNewPatient] = React.useState<"new" | "established">("established");
  const [levelError, setLevelError] = React.useState<string | null>(null);
  const [dismissing, setDismissing] = React.useState<{
    line: ChargeItem;
    edit: Edit;
  } | null>(null);
  const [reason, setReason] = React.useState("");
  const [removing, setRemoving] = React.useState<ChargeItem | null>(null);
  const [noChargeOpen, setNoChargeOpen] = React.useState(false);
  const [noChargeReason, setNoChargeReason] = React.useState("");

  const compute = useApiMutation("computeEmLevel", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: () => setLevelError(null),
    onError: (e) => setLevelError(errorMessage(e)),
  });
  const run = (
    o: Partial<{
      m: "mdm" | "time";
      p: string;
      d: string;
      r: string;
      t: string;
      n: string;
    }>,
  ) => {
    const m = o.m ?? method;
    const p = o.p ?? problems;
    const d = o.d ?? data;
    const r = o.r ?? risk;
    const t = o.t ?? minutes;
    const n = o.n ?? newPatient;
    if (m === "time" && !(Number(t) > 0)) return;
    const body: EmLevelInput = {
      basis: m,
      newPatient: n === "new",
      ...(m === "time"
        ? { totalMinutes: Number(t) }
        : {
            ...(p !== "minimal" ? { problems: p as "low" | "moderate" | "high" } : {}),
            data: d as EmLevelInput["data"],
            risk: r as EmLevelInput["risk"],
          }),
    };
    compute.mutate({ params: { encounterId }, body });
  };

  const err = (e: unknown) => toast.error(errorMessage(e));
  const addLine = useApiMutation("addChargeItem", {
    invalidates: [...CHARGE_INVALIDATES],
    onError: err,
  });
  const updateLine = useApiMutation("updateChargeItem", {
    invalidates: [...CHARGE_INVALIDATES],
    onError: err,
  });
  const deleteLine = useApiMutation("deleteChargeItem", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: () => (toast("Charge removed."), setRemoving(null)),
    onError: err,
  });
  const applyEdit = useApiMutation("applyCodingEdit", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: () => toast("Modifier added."),
    onError: err,
  });
  const dismissEdit = useApiMutation("dismissCodingEdit", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: () => (toast("Warning dismissed."), setDismissing(null), setReason("")),
    onError: err,
  });
  const moveDx = useApiMutation("updateEncounterDiagnosis", {
    invalidates: [...DX_INVALIDATES],
    onError: err,
  });
  const noChargeMut = useApiMutation("markNoChargeVisit", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: () => (toast("Marked as a no-charge visit."), setNoChargeOpen(false)),
    onError: err,
  });

  const d = charges.data;
  const lines = d?.lines ?? [];
  const dx = d?.diagnoses ?? [];
  const sug = d?.emSuggestion;
  const total = fromCents(
    lines.reduce((s, l) => s + Math.round(toCents(l.fee) * Number(l.units)), 0),
  );
  const edits = lines.flatMap((l) =>
    editsOf(l)
      .filter((e) => !e.dismissed)
      .map((e) => ({ line: l, edit: e })),
  );
  const emLine = lines.find((l) => isEm(l.code));
  const lineView = v.view === "line" ? v.id : null;
  const drawerLine =
    lineView && lineView !== "new" ? (lines.find((l) => l.id === lineView) ?? null) : null;
  const goDx = () => navigate(pathTo("encounter.dx-coding", { patientId, encounterId }));
  const evidence = () => navigate(pathTo("encounter.note", { patientId, encounterId }));

  const useSuggested = () => {
    if (!sug) return;
    if (emLine) {
      updateLine.mutate({
        params: { chargeItemId: emLine.id },
        version: emLine.version,
        body: { code: sug.code },
      });
    } else if (dx[0]) {
      addLine.mutate({
        params: { encounterId },
        body: { code: sug.code, dxConditionIds: [dx[0].id] },
      });
    }
  };

  const save = () => {
    if (method === "time" && !(Number(minutes) > 0)) {
      toast("Charges saved. They go to billing when the note is signed.");
      return;
    }
    compute.mutate(
      {
        params: { encounterId },
        body: {
          basis: method,
          newPatient: newPatient === "new",
          ...(method === "time"
            ? { totalMinutes: Number(minutes) }
            : {
                ...(problems !== "minimal" ? { problems: problems as "low" } : {}),
                data: data as EmLevelInput["data"],
                risk: risk as EmLevelInput["risk"],
              }),
        },
      },
      {
        onSuccess: () => toast("Charges saved. They go to billing when the note is signed."),
      },
    );
  };

  const move = (i: number, delta: number) => {
    const c = dx[i]!;
    moveDx.mutate({
      params: { encounterId, conditionId: c.id },
      body: { rank: (c.rank ?? i + 1) + delta, version: c.version },
    });
  };

  const warnCount = d?.holds.length ?? 0;
  const canMarkNoCharge = can("markNoChargeVisit") && !noCharge && !noteSigned;

  return (
    <EncounterBody
      drawer={<ContextDrawer />}
      actionBar={
        <>
          <span className="mr-auto text-small text-ink-2" data-testid={tid(S, "release-note")}>
            Charges are released to billing when the note is signed.
            {warnCount ? ` ${warnCount} ${warnCount === 1 ? "warning" : "warnings"}.` : ""}
          </span>
          {canMarkNoCharge ? (
            <Button onClick={() => setNoChargeOpen(true)} data-testid={tid(S, "no-charge")}>
              Mark no-charge visit
            </Button>
          ) : null}
          {!lines.length ? (
            <Unavailable reason="Add a charge line first.">
              <Button variant="primary" disabled data-testid={tid(S, "save-charges")}>
                Save charges
              </Button>
            </Unavailable>
          ) : (
            <Button
              variant="primary"
              disabled={compute.isPending || noCharge || noteSigned}
              loading={compute.isPending}
              onClick={save}
              data-testid={tid(S, "save-charges")}
            >
              Save charges
            </Button>
          )}
        </>
      }
    >
      {noCharge ? (
        <Alert testId={tid(S, "no-charge-state")}>
          This visit is marked no-charge, so nothing goes to billing and charges can't be added.
        </Alert>
      ) : noteSigned ? (
        <Alert>The note is signed, so these charges have been released to billing.</Alert>
      ) : null}
      {charges.isLoading ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : charges.error ? (
        <Alert tone="critical" title="Charges didn't load.">
          {errorMessage(charges.error)}
        </Alert>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card data-testid={tid(S, "diagnoses")}>
              <CardHeader
                title="Diagnoses"
                actions={
                  editable ? (
                    <Button size="sm" onClick={goDx} data-testid={tid(S, "add-dx")}>
                      + Add diagnosis
                    </Button>
                  ) : null
                }
              />
              {dx.length ? (
                <ol>
                  {dx.map((c, i) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-3 border-b border-line py-3 last:border-0"
                      data-testid={tid(S, "dx-pointer")}
                    >
                      <span className="w-6 text-h3 tabular-nums">{letter(i)}</span>
                      <span className="grid min-w-0 flex-1">
                        <b className="font-semibold">{c.display}</b>
                        <span className="text-small tabular-nums text-ink-2">{c.icd10Code}</span>
                      </span>
                      {editable ? (
                        <span className="flex gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Move ${c.display} up`}
                            disabled={i === 0 || moveDx.isPending}
                            onClick={() => move(i, -1)}
                          >
                            <ArrowUp size={16} strokeWidth={1.75} />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Move ${c.display} down`}
                            disabled={i === dx.length - 1 || moveDx.isPending}
                            onClick={() => move(i, 1)}
                          >
                            <ArrowDown size={16} strokeWidth={1.75} />
                          </Button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-body text-ink-2">No diagnoses on this visit yet.</p>
              )}
            </Card>

            <Card data-testid={tid(S, "level")}>
              <CardHeader
                title="Visit level"
                actions={
                  <Tabs
                    value={method}
                    onValueChange={(m) => {
                      setMethod(m as "mdm" | "time");
                      run({ m: m as "mdm" | "time" });
                    }}
                  >
                    <TabsList>
                      <TabsTrigger value="mdm" data-testid={tid(S, "method")}>
                        Medical decision making
                      </TabsTrigger>
                      <TabsTrigger value="time">Total time</TabsTrigger>
                    </TabsList>
                  </Tabs>
                }
              />
              <div className="grid gap-4">
                <div className="flex items-center gap-3">
                  <span className="text-label">Patient</span>
                  <RadioGroup
                    aria-label="Patient type"
                    value={newPatient}
                    onValueChange={(n) => {
                      setNewPatient(n);
                      run({ n });
                    }}
                    options={[
                      {
                        value: "established",
                        label: "Established patient",
                        disabled: !editable,
                      },
                      {
                        value: "new",
                        label: "New patient",
                        disabled: !editable,
                      },
                    ]}
                  />
                </div>
                {method === "mdm" ? (
                  <div className="grid gap-3">
                    {(
                      [
                        [
                          "Problems",
                          "mdm-problems",
                          problems,
                          LEVELS,
                          (x: string) => (setProblems(x), run({ p: x })),
                        ],
                        [
                          "Data",
                          "mdm-data",
                          data,
                          DATA_LEVELS,
                          (x: string) => (setData(x), run({ d: x })),
                        ],
                        [
                          "Risk",
                          "mdm-risk",
                          risk,
                          LEVELS,
                          (x: string) => (setRisk(x), run({ r: x })),
                        ],
                      ] as const
                    ).map(([label, id, val, opts, set]) => (
                      <div
                        key={id}
                        className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3"
                      >
                        <span className="text-label">{label}</span>
                        <RadioGroup
                          aria-label={label}
                          testId={tid(S, id)}
                          value={val}
                          onValueChange={set}
                          options={opts.map((o) => ({
                            ...o,
                            disabled: !editable,
                          }))}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid max-w-60 gap-1">
                    <Label htmlFor="total-time">Total time (minutes)</Label>
                    <Input
                      id="total-time"
                      type="number"
                      min={1}
                      value={minutes}
                      disabled={!editable}
                      onChange={(e) => setMinutes(e.target.value)}
                      onBlur={() => run({})}
                      data-testid={tid(S, "total-time")}
                    />
                  </div>
                )}
                {levelError ? <Alert tone="caution">{levelError}</Alert> : null}
                <div className="bg-surface-muted p-4" data-testid={tid(S, "suggested-level")}>
                  {sug ? (
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-label">Suggested level</span>
                        <b className="text-h3 tabular-nums">{sug.code}</b>
                        {sug.alternatives.length ? (
                          <span className="text-small text-ink-2">
                            Also considered: {sug.alternatives.join(", ")}
                          </span>
                        ) : null}
                        {editable && emLine?.code !== sug.code ? (
                          <Button
                            size="sm"
                            disabled={
                              addLine.isPending ||
                              updateLine.isPending ||
                              (!emLine && !dx.length) ||
                              (!!emLine && onClaim(emLine))
                            }
                            onClick={useSuggested}
                            data-testid={tid(S, "use-suggested")}
                          >
                            Use {sug.code}
                          </Button>
                        ) : null}
                      </div>
                      <ul className="list-disc pl-5 text-small text-ink-2">
                        {sug.rationale.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                      <div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={evidence}
                          data-testid={tid(S, "show-evidence")}
                        >
                          Show evidence in note
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-body text-ink-2">
                      Choose problems, data and risk to see a suggested level.
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </div>

          {edits.length ? (
            <div className="grid gap-3" data-testid={tid(S, "edits")}>
              {edits.map(({ line, edit }) => (
                <Alert
                  key={`${line.id}:${edit.key}`}
                  tone={edit.severity === "error" ? "critical" : "caution"}
                  testId={tid(S, "modifier-alert")}
                  title={`${line.code}:`}
                  action={
                    <span className="flex gap-2">
                      {edit.fix?.addModifier && can("applyCodingEdit") && !onClaim(line) ? (
                        <Button
                          size="sm"
                          disabled={applyEdit.isPending}
                          onClick={() =>
                            applyEdit.mutate({
                              params: {
                                chargeItemId: line.id,
                                editKey: edit.key,
                              },
                            })
                          }
                          data-testid={tid(S, "add-modifier")}
                        >
                          Add modifier {edit.fix.addModifier}
                        </Button>
                      ) : null}
                      {edit.severity === "warning" && can("dismissCodingEdit") && !onClaim(line) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDismissing({ line, edit })}
                          data-testid={tid(S, "dismiss-edit")}
                        >
                          Dismiss with reason
                        </Button>
                      ) : null}
                    </span>
                  }
                >
                  {edit.text}
                </Alert>
              ))}
            </div>
          ) : null}

          <Card data-testid={tid(S, "lines")}>
            <CardHeader
              title="Charge lines"
              actions={
                editable ? (
                  <Button
                    size="sm"
                    onClick={() => v.open("line", "new")}
                    data-testid={tid(S, "add-charge")}
                  >
                    + Add charge
                  </Button>
                ) : null
              }
            />
            {lines.length ? (
              <Table data-testid={tid(S, "charge-table")}>
                <TableHeader>
                  <tr>
                    <TableHead>Code</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Modifiers</TableHead>
                    <TableHead numeric>Units</TableHead>
                    <TableHead>Diagnosis pointers</TableHead>
                    <TableHead numeric>Fee</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="font-semibold tabular-nums">{l.code}</TableCell>
                      <TableCell>{l.description}</TableCell>
                      <TableCell className="tabular-nums">
                        {l.modifiers.join(", ") || "—"}
                      </TableCell>
                      <TableCell numeric>{Number(l.units)}</TableCell>
                      <TableCell>
                        <span className="flex gap-1">
                          {l.dxConditionIds.map((id) => {
                            const i = dx.findIndex((x) => x.id === id);
                            return (
                              <Tag key={id} tone="outline" className="tabular-nums">
                                {i >= 0 ? letter(i) : "?"}
                              </Tag>
                            );
                          })}
                        </span>
                      </TableCell>
                      <TableCell numeric>{formatMoney(l.fee)}</TableCell>
                      <TableCell>
                        <span className="flex items-center justify-end gap-1">
                          {onClaim(l) ? (
                            <Tag tone="active">On claim</Tag>
                          ) : l.status === "HELD" ? (
                            <Tag tone="caution">Held</Tag>
                          ) : null}
                          {editable && !onClaim(l) ? (
                            <>
                              <Button
                                size="sm"
                                onClick={() => v.open("line", l.id)}
                                data-testid={tid(S, "line-edit")}
                              >
                                Edit
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Remove ${l.code}`}
                                onClick={() => setRemoving(l)}
                              >
                                <Trash2 size={16} strokeWidth={1.75} />
                              </Button>
                            </>
                          ) : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="hover:bg-surface">
                    <TableCell colSpan={5} className="text-right text-label">
                      Total
                    </TableCell>
                    <TableCell numeric data-testid={tid(S, "total")}>
                      {formatMoney(total)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            ) : (
              <p className="text-body text-ink-2">
                No charges yet. Add the visit's E/M level and any procedures or vaccines.
              </p>
            )}
          </Card>
        </>
      )}

      <LineDrawer
        open={v.view === "line"}
        onClose={v.close}
        encounterId={encounterId}
        line={drawerLine}
        diagnoses={dx}
      />
      <ConfirmDialog
        open={!!dismissing}
        onOpenChange={(o) => !o && (setDismissing(null), setReason(""))}
        title="Dismiss this warning?"
        description="It stays on the claim record with your reason."
        action="Dismiss warning"
        disabled={!reason.trim() || dismissEdit.isPending}
        testId={tid(S, "dismiss-dialog")}
        onConfirm={() =>
          dismissing &&
          dismissEdit.mutate({
            params: {
              chargeItemId: dismissing.line.id,
              editKey: dismissing.edit.key,
            },
            body: { reason: reason.trim() },
          })
        }
      >
        <div className="grid gap-1">
          <Label htmlFor="dismiss-reason">Reason</Label>
          <Input id="dismiss-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.code ?? "charge"}?`}
        description="The line is removed from this visit's charges."
        action="Remove charge"
        danger
        onConfirm={() => removing && deleteLine.mutate({ params: { chargeItemId: removing.id } })}
      />
      <ConfirmDialog
        open={noChargeOpen}
        onOpenChange={(o) => !o && (setNoChargeOpen(false), setNoChargeReason(""))}
        title="Mark this visit no-charge?"
        description="Nothing from this visit goes to billing, and charges can't be added."
        action="Mark no-charge"
        disabled={!noChargeReason.trim() || noChargeMut.isPending}
        testId={tid(S, "no-charge-dialog")}
        onConfirm={() =>
          noChargeMut.mutate({
            params: { encounterId },
            body: { reason: noChargeReason.trim() },
          })
        }
      >
        <div className="grid gap-1">
          <Label htmlFor="no-charge-reason">Reason</Label>
          <Input
            id="no-charge-reason"
            value={noChargeReason}
            onChange={(e) => setNoChargeReason(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </EncounterBody>
  );
}
