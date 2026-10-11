import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChargeItem, ChargeReviewDetail, ChargeReviewRow } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, money, pluralize } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { BillingLayout } from "@/features/billing/BillingLayout";
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
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, LoadingRows } from "@/components/ui/layout";
import { Pressable } from "@/components/ui/pressable";
import { Checkbox } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tag } from "@/components/ui/tag";

const S = "billing.charge-review";

const HOLD_LABEL: Record<string, string> = {
  modifier: "Modifier needed",
  "dx-pointer": "Missing Dx pointer",
  ncci: "NCCI bundled pair",
  mue: "Units over limit",
  auth: "Auth missing",
  provider: "Provider NPI/TIN",
  pos: "Place of service",
  coverage: "Coverage",
  filing: "Filing deadline",
  hold: "Manual hold",
  "provider-query": "Waiting on provider",
  fixed: "Fixed, ready to release",
};
const holdLabel = (h: string) => HOLD_LABEL[h] ?? h;
const ALL = "__all";
const LETTERS = "ABCDEFGHIJKL";

type Blocker = { code?: string; text?: string };
const blockers = (e: unknown): string[] =>
  e instanceof ApiError
    ? ((e.problem.blockers ?? []) as Blocker[]).map((b) => b.text ?? b.code ?? "")
    : [];

/** billing.charge-review: held encounters grouped by rule, with an inline fix pane (flow rcm/02). */
export function ChargeReviewPage() {
  const v = useView();
  const [rule, setRule] = React.useState(ALL);
  const q = useApi("listHeldCharges", { query: {} }, { refetchInterval: 60_000 });
  const all = q.data?.data ?? [];
  const rows = rule === ALL ? all : all.filter((r) => r.holds.includes(rule));
  const groups = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) for (const h of new Set(r.holds)) m.set(h, (m.get(h) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const total = all.reduce((s, r) => s + Number(r.total), 0);
  const oldest = all.reduce((m, r) => Math.max(m, r.ageDays), 0);
  const fixed = all.filter((r) => r.holds.includes("fixed")).length;
  const releaseFixed = useApiMutation("releaseFixedCharges", {
    invalidates: ["listHeldCharges", "getChargeReviewItem"],
    onSuccess: (r) =>
      r.failed.length
        ? toast.error(
            `${pluralize(r.succeeded.length, "encounter")} released, ${r.failed.length} could not be: ${r.failed[0]?.detail}`,
          )
        : toast(`${pluralize(r.succeeded.length, "encounter")} released to claims.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <BillingLayout
      title="Charge review"
      subtitle={
        <span data-testid={tid(S, "cr-summary")}>
          {pluralize(all.length, "encounter")} held · {money(total.toFixed(2))} · oldest {oldest}{" "}
          days
        </span>
      }
      actions={
        <Button
          disabled={!fixed || releaseFixed.isPending}
          onClick={() => releaseFixed.mutate({})}
          data-testid={tid(S, "cr-release-fixed")}
        >
          Release {fixed} fixed
        </Button>
      }
    >
      {q.error ? <Alert tone="caution">{errorMessage(q.error)}</Alert> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="p-0">
          <h2 className="px-5 pb-2 pt-5 text-label text-ink-2">Grouped by rule</h2>
          <ul className="pb-3">
            {[[ALL, all.length] as const, ...groups].map(([k, n]) => (
              <li key={k}>
                <Pressable
                  type="button"
                  onClick={() => setRule(k)}
                  data-testid={tid(S, "cr-rule-group")}
                  className={cn(
                    "flex w-full items-center justify-between px-5 py-2 text-left text-body hover:bg-surface-hover",
                    rule === k && "bg-pine-50 font-semibold text-pine-700",
                  )}
                >
                  <span>{k === ALL ? "All held" : holdLabel(k)}</span>
                  <span className="tabular-nums">{n}</span>
                </Pressable>
              </li>
            ))}
          </ul>
        </Card>
        <Card data-testid={tid(S, "cr-table")}>
          {q.isLoading ? (
            <div className="p-5">
              <LoadingRows rows={4} />
            </div>
          ) : null}
          {!q.isLoading && !rows.length ? (
            <p className="p-5 text-body text-ink-2">No charges are held for review.</p>
          ) : null}
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Patient</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Edit</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <ReviewRow key={r.encounterId} row={r} open={v.id === r.encounterId} v={v} />
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Card>
      </div>
    </BillingLayout>
  );
}

function ReviewRow({
  row,
  open,
  v,
}: {
  row: ChargeReviewRow;
  open: boolean;
  v: ReturnType<typeof useView>;
}) {
  return (
    <>
      <TableRow data-state={open ? "selected" : undefined}>
        <TableCell className="tabular-nums">{formatShortDate(row.dateOfService)}</TableCell>
        <TableCell>
          <Link
            to={pathTo("billing.patient-account", { patientId: row.patient.id })}
            className="font-semibold underline-offset-4 hover:underline"
            data-testid={tid(S, "cr-patient-account")}
          >
            {row.patient.name}
          </Link>
          <div className="text-small tabular-nums text-ink-2">MRN {row.patient.mrn}</div>
        </TableCell>
        <TableCell>{row.practitioner}</TableCell>
        <TableCell>
          <span className="flex flex-wrap gap-1">
            {row.holds.map((h) => (
              <Tag key={h} tone={h === "fixed" ? "active" : "outline"}>
                {holdLabel(h)}
              </Tag>
            ))}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums font-medium">{money(row.total)}</TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            onClick={() => (open ? v.close() : v.open("fix", row.encounterId))}
            data-testid={tid(S, "cr-expand")}
          >
            {open ? (
              <ChevronDown size={18} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={18} strokeWidth={1.75} />
            )}
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-surface">
          <TableCell colSpan={6} className="h-auto p-5">
            <FixPane encounterId={row.encounterId} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

type LineEdit = { mods?: string; units?: string; dx?: string[] };
const parseMods = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((m) => m.toUpperCase());

function FixPane({ encounterId }: { encounterId: string }) {
  const qc = useQueryClient();
  const q = useApi("getChargeReviewItem", { params: { encounterId } });
  const [edits, setEdits] = React.useState<Record<string, LineEdit>>({});
  const [errors, setErrors] = React.useState<string[]>([]);
  const [dialog, setDialog] = React.useState<"query" | "hold" | null>(null);
  const [dismiss, setDismiss] = React.useState<{ lineId: string; key: string } | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const inv = { invalidates: ["getChargeReviewItem" as const, "listHeldCharges" as const] };
  const fail = (e: Error) => toast.error(errorMessage(e));
  const apply = useApiMutation("applyCodingEdit", {
    ...inv,
    onSuccess: () => (toast("Fix applied."), setEdits({})),
    onError: fail,
  });
  const dis = useApiMutation("dismissCodingEdit", {
    ...inv,
    onSuccess: () => (toast("Warning dismissed."), setDismiss(null), setText("")),
    onError: fail,
  });
  const hold = useApiMutation("holdEncounterCharges", {
    ...inv,
    onSuccess: () => (toast("Encounter held."), setDialog(null), setText("")),
    onError: fail,
  });
  const ask = useApiMutation("queryProvider", {
    ...inv,
    onSuccess: () => (toast("Task sent to the provider."), setDialog(null), setText("")),
    onError: fail,
  });
  if (q.isLoading) return <LoadingRows rows={3} />;
  if (q.error || !q.data)
    return <Alert tone="caution">{q.error ? errorMessage(q.error) : "Not found."}</Alert>;
  const d: ChargeReviewDetail = q.data;
  const dx = d.charges.diagnoses;
  const letter = (id: string) => {
    const i = dx.findIndex((c) => c.id === id);
    return i < 0 ? "?" : (LETTERS[i] ?? String(i + 1));
  };

  const dirty = (
    l: ChargeItem,
  ): Partial<{ modifiers: string[]; units: number; dxConditionIds: string[] }> | null => {
    const e = edits[l.id];
    if (!e) return null;
    const out: Partial<{ modifiers: string[]; units: number; dxConditionIds: string[] }> = {};
    if (e.mods !== undefined && parseMods(e.mods).join() !== l.modifiers.join())
      out.modifiers = parseMods(e.mods);
    if (e.units !== undefined && Number(e.units) !== Number(l.units) && Number(e.units) > 0)
      out.units = Number(e.units);
    if (e.dx && e.dx.join() !== l.dxConditionIds.join()) out.dxConditionIds = e.dx;
    return Object.keys(out).length ? out : null;
  };
  const patch = (id: string, e: LineEdit) => setEdits((p) => ({ ...p, [id]: { ...p[id], ...e } }));

  const saveAndRelease = async () => {
    setBusy(true);
    setErrors([]);
    try {
      for (const l of d.charges.lines) {
        const body = dirty(l);
        if (body)
          await api("updateChargeItem", {
            params: { chargeItemId: l.id },
            body,
            version: l.version,
          });
      }
      await api("releaseEncounterCharges", { params: { encounterId } });
      toast("Released to claim.");
      setEdits({});
    } catch (e) {
      const b = blockers(e);
      if (b.length) setErrors(b);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["getChargeReviewItem"] });
      void qc.invalidateQueries({ queryKey: ["listHeldCharges"] });
    }
  };

  const fixes = d.edits;
  return (
    <div className="grid gap-4" data-testid={tid(S, "fx-lines")}>
      <p className="text-body text-ink-2">
        {d.coverage
          ? `${d.coverage.payer.name} · member ${d.coverage.memberId}`
          : "No coverage on file."}
        {" · "}
        Diagnoses:{" "}
        {dx.length
          ? dx.map((c, i) => `${LETTERS[i]} ${c.icd10Code ?? c.display}`).join(", ")
          : "none"}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-32">Modifiers</TableHead>
            <TableHead className="w-20">Units</TableHead>
            <TableHead>Dx pointers</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Fee</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {d.charges.lines.map((l) => {
            const e = edits[l.id] ?? {};
            const editable = l.status === "DRAFT" || l.status === "HELD";
            const sel = e.dx ?? l.dxConditionIds;
            return (
              <TableRow key={l.id}>
                <TableCell className="font-semibold tabular-nums">{l.code}</TableCell>
                <TableCell>{l.description}</TableCell>
                <TableCell>
                  <Input
                    aria-label={`Modifiers for ${l.code}`}
                    value={e.mods ?? l.modifiers.join(" ")}
                    disabled={!editable}
                    onChange={(ev) => patch(l.id, { mods: ev.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`Units for ${l.code}`}
                    inputMode="numeric"
                    value={e.units ?? String(Number(l.units))}
                    disabled={!editable}
                    onChange={(ev) => patch(l.id, { units: ev.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-3">
                    {dx.map((c, i) => (
                      <Checkbox
                        key={c.id}
                        label={LETTERS[i]}
                        disabled={!editable}
                        checked={sel.includes(c.id)}
                        onCheckedChange={(on) =>
                          patch(l.id, {
                            dx: on ? [...sel, c.id] : sel.filter((x) => x !== c.id),
                          })
                        }
                        aria-label={`Pointer ${LETTERS[i]} on ${l.code}`}
                      />
                    ))}
                    {!dx.length ? (
                      <span className="text-ink-2">{sel.map(letter).join(" ") || "—"}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <Tag tone="outline">
                    {l.status === "READY"
                      ? "Ready"
                      : l.status === "BILLED"
                        ? "Billed"
                        : l.status === "HELD"
                          ? "Held"
                          : "Draft"}
                  </Tag>
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {money(l.fee)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {fixes.length ? (
        <ul className="grid gap-2">
          {fixes.map((f) => (
            <li key={f.code} className="flex items-center justify-between gap-3 text-body">
              <span className="flex items-center gap-2">
                <Tag tone={f.severity === "error" ? "critical" : "caution"}>
                  {f.severity === "error" ? "Error" : "Warning"}
                </Tag>
                {f.text}
              </span>
              <span className="flex gap-2">
                {f.lineId ? (
                  <Button
                    size="sm"
                    disabled={apply.isPending}
                    onClick={() =>
                      apply.mutate({ params: { chargeItemId: f.lineId!, editKey: f.code } })
                    }
                  >
                    Apply fix
                  </Button>
                ) : null}
                {f.severity === "warning" && f.lineId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismiss({ lineId: f.lineId!, key: f.code })}
                  >
                    Dismiss
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {errors.length ? (
        <Alert tone="critical" title="Can't release yet.">
          {errors.join(" ")}
        </Alert>
      ) : null}
      <p className="bg-surface-muted px-4 py-3 text-body" data-testid={tid(S, "fx-note-hidden")}>
        <b className="font-semibold">Note text hidden for billing roles.</b> Diagnoses and charge
        evidence are shown; ask the provider if you need more.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={() => (setText(""), setDialog("query"))} data-testid={tid(S, "fx-query")}>
          Query provider
        </Button>
        <Button
          variant="ghost"
          onClick={() => (setText(""), setDialog("hold"))}
          data-testid={tid(S, "fx-hold")}
        >
          Hold with reason
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void saveAndRelease()}
          data-testid={tid(S, "fx-release")}
        >
          Save &amp; release to claim
        </Button>
      </div>
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="w-dialog-sm">
          <DialogHeader>
            <DialogTitle>{dialog === "query" ? "Query provider" : "Hold with reason"}</DialogTitle>
          </DialogHeader>
          <FieldShell
            label={dialog === "query" ? "Question for the provider" : "Reason"}
            htmlFor="cr-text"
          >
            <Textarea id="cr-text" value={text} onChange={(e) => setText(e.target.value)} />
          </FieldShell>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!text.trim() || hold.isPending || ask.isPending}
              onClick={() =>
                dialog === "query"
                  ? ask.mutate({ params: { encounterId }, body: { comment: text.trim() } })
                  : hold.mutate({ params: { encounterId }, body: { reason: text.trim() } })
              }
            >
              {dialog === "query" ? "Send query" : "Hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={dismiss !== null}
        onOpenChange={(o) => !o && setDismiss(null)}
        title="Dismiss this warning?"
        description="The warning stops blocking release. Say why."
        action="Dismiss"
        disabled={!text.trim() || dis.isPending}
        onConfirm={() =>
          dismiss &&
          dis.mutate({
            params: { chargeItemId: dismiss.lineId, editKey: dismiss.key },
            body: { reason: text.trim() },
          })
        }
      >
        <FieldShell label="Reason" htmlFor="cr-dismiss">
          <Textarea id="cr-dismiss" value={text} onChange={(e) => setText(e.target.value)} />
        </FieldShell>
      </ConfirmDialog>
    </div>
  );
}
