import * as React from "react";
import type { ChargeItem, CodeHit, Condition } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { SearchCombobox, type SearchResult } from "@/components/ui/combobox";
import { Input, Label } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const S = "encounter.charges";
export const CHARGE_INVALIDATES = [
  "getEncounterCharges",
  "getEncounter",
  "getSignPreflight",
] as const;
export const letter = (i: number) => String.fromCharCode(65 + i);

function useProcedures(q: string): SearchResult<CodeHit> {
  const r = useApi("searchProcedureCodes", { query: { q } }, { enabled: !!q, staleTime: 300_000 });
  return {
    items: r.data ?? [],
    loading: r.isFetching,
    error: r.error ? errorMessage(r.error) : null,
  };
}

/** The `line` view of encounter.charges: add or edit one charge line. */
export function LineDrawer({
  open,
  onClose,
  encounterId,
  line,
  diagnoses,
}: {
  open: boolean;
  onClose: () => void;
  encounterId: string;
  line: ChargeItem | null;
  diagnoses: Condition[];
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid={tid(S, "line-drawer")}>
        {open ? (
          <LineForm
            key={line?.id ?? "new"}
            onClose={onClose}
            encounterId={encounterId}
            line={line}
            diagnoses={diagnoses}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function LineForm({
  onClose,
  encounterId,
  line,
  diagnoses,
}: {
  onClose: () => void;
  encounterId: string;
  line: ChargeItem | null;
  diagnoses: Condition[];
}) {
  const [code, setCode] = React.useState<CodeHit | null>(
    line ? { system: line.codeSystem, code: line.code, display: line.description } : null,
  );
  const [mods, setMods] = React.useState((line?.modifiers ?? []).join(", "));
  const [units, setUnits] = React.useState(line ? String(Number(line.units)) : "1");
  const [fee, setFee] = React.useState(line?.fee ?? "");
  const [ptrs, setPtrs] = React.useState<string[]>(line?.dxConditionIds ?? []);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);

  const onError = (e: unknown) => {
    const m: Record<string, string> = {};
    if (e instanceof ApiError && e.problem.errors?.length) {
      for (const f of e.problem.errors) m[f.field] = f.message;
      setMessage(null);
    } else setMessage(errorMessage(e));
    setErrors(m);
  };
  const add = useApiMutation("addChargeItem", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: onClose,
    onError,
  });
  const update = useApiMutation("updateChargeItem", {
    invalidates: [...CHARGE_INVALIDATES],
    onSuccess: onClose,
    onError,
  });
  const busy = add.isPending || update.isPending;
  const modifiers = mods
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((m) => m.toUpperCase());
  const unitsNum = Number(units);
  const unitsOk = Number.isInteger(unitsNum) && unitsNum >= 1;
  const ready = !!code && unitsOk && ptrs.length > 0;

  const save = () => {
    if (!code) return;
    setErrors({});
    setMessage(null);
    if (line) {
      update.mutate({
        params: { chargeItemId: line.id },
        version: line.version,
        body: {
          code: code.code,
          modifiers,
          units: unitsNum,
          dxConditionIds: ptrs,
          ...(fee && fee !== line.fee ? { fee } : {}),
        },
      });
    } else {
      add.mutate({
        params: { encounterId },
        body: {
          code: code.code,
          ...(code.system === "CPT" || code.system === "HCPCS" ? { codeSystem: code.system } : {}),
          modifiers,
          units: unitsNum,
          dxConditionIds: ptrs,
          ...(fee ? { fee } : {}),
        },
      });
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{line ? "Edit charge" : "Add charge"}</SheetTitle>
      </SheetHeader>
      <SheetBody className="grid content-start gap-4">
        {message ? <Alert tone="caution">{message}</Alert> : null}
        <div className="grid gap-1">
          <Label>CPT/HCPCS code</Label>
          <SearchCombobox
            value={code}
            onChange={setCode}
            useSearch={useProcedures}
            itemKey={(c) => `${c.system}:${c.code}`}
            ariaLabel="procedure code"
            placeholder="Search by code or description"
            invalid={!!errors.code}
            testId={tid(S, "line-code")}
            renderItem={(c) => (
              <span className="flex items-baseline justify-between gap-3">
                <span>{c.display}</span>
                <span className="shrink-0 tabular-nums text-small text-ink-2">{c.code}</span>
              </span>
            )}
            renderValue={(c) => (
              <span>
                {c.display} <span className="tabular-nums text-ink-2">{c.code}</span>
              </span>
            )}
          />
          {errors.code ? <p className="text-small text-danger-ink">{errors.code}</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1">
            <Label htmlFor="line-mods">Modifiers</Label>
            <Input
              id="line-mods"
              value={mods}
              placeholder="25, 59"
              onChange={(e) => setMods(e.target.value)}
              data-testid={tid(S, "line-mods")}
              aria-invalid={!!errors.modifiers || undefined}
            />
            {errors.modifiers ? (
              <p className="text-small text-danger-ink">{errors.modifiers}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="line-units">Units</Label>
            <Input
              id="line-units"
              type="number"
              min={1}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              data-testid={tid(S, "line-units")}
              aria-invalid={!unitsOk || !!errors.units || undefined}
            />
            {errors.units ? <p className="text-small text-danger-ink">{errors.units}</p> : null}
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="line-fee">Fee (blank uses the fee schedule)</Label>
          <Input
            id="line-fee"
            inputMode="decimal"
            value={fee}
            placeholder="0.00"
            onChange={(e) => setFee(e.target.value)}
            aria-invalid={!!errors.fee || undefined}
          />
          {errors.fee ? <p className="text-small text-danger-ink">{errors.fee}</p> : null}
        </div>
        <fieldset className="grid gap-2" data-testid={tid(S, "line-pointers")}>
          <legend className="mb-1 text-label text-ink">Diagnosis pointers</legend>
          {diagnoses.length ? (
            diagnoses.map((d, i) => (
              <Checkbox
                key={d.id}
                checked={ptrs.includes(d.id)}
                onCheckedChange={(v) =>
                  setPtrs((p) => (v === true ? [...p, d.id] : p.filter((x) => x !== d.id)))
                }
                label={`${letter(i)} · ${d.display} (${d.icd10Code ?? "uncoded"})`}
              />
            ))
          ) : (
            <p className="text-body text-ink-2">Add a diagnosis to this visit first.</p>
          )}
          {errors.dxConditionIds ? (
            <p className="text-small text-danger-ink">{errors.dxConditionIds}</p>
          ) : (
            <p className="text-small text-ink-2">
              Every line needs at least one pointer. The first one checked is the primary.
            </p>
          )}
        </fieldset>
      </SheetBody>
      <SheetFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!ready || busy}
          loading={busy}
          onClick={save}
          data-testid={tid(S, "line-save")}
        >
          Save line
        </Button>
      </SheetFooter>
    </>
  );
}
