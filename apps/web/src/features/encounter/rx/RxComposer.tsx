import type { Condition, Pharmacy } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { FieldShell } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { SearchCombobox, type SearchResult } from "@/components/ui/combobox";
import { Select } from "@/components/ui/select";
import { DrugSearch } from "./DrugSearch";
import { DOSE_UNITS, FREQUENCIES, ROUTES, buildSig, type RxForm } from "./rxParts";

const S = "encounter.rx";

function usePharmacies(q: string): SearchResult<Pharmacy> {
  const r = useApi("searchPharmacies", { query: { q } }, { enabled: !!q, staleTime: 300_000 });
  return {
    items: r.data ?? [],
    loading: r.isFetching,
    error: r.error ? errorMessage(r.error) : null,
  };
}

/** Middle column: the prescription form. `readOnly` once the Rx is signed or cancelled. */
export function RxComposer({
  form,
  onChange,
  readOnly,
  isNew,
  drugQuery,
  onDrugQuery,
  onPickDrug,
  diagnoses,
}: {
  form: RxForm;
  onChange: (f: RxForm) => void;
  readOnly: boolean;
  isNew: boolean;
  drugQuery: string;
  onDrugQuery: (q: string) => void;
  onPickDrug: (p: { rxcui: string; name: string }) => void;
  diagnoses: Condition[];
}) {
  /** Changing a sig input rebuilds the instructions unless the user has edited them by hand. */
  const set = (patch: Partial<RxForm>) => {
    const next = { ...form, ...patch };
    onChange(next.sigEdited ? next : { ...next, sig: buildSig(next) });
  };
  return (
    <div className="grid gap-4" data-testid={tid(S, "composer")}>
      <FieldShell label="Medication" required>
        <DrugSearch
          value={form.rxcui ? { rxcui: form.rxcui, name: form.display } : null}
          q={drugQuery}
          onQChange={onDrugQuery}
          onPick={onPickDrug}
          onClear={() => onChange({ ...form, rxcui: "", display: "" })}
          disabled={readOnly}
          testId={tid(S, isNew && !form.rxcui ? "new-drug" : "drug")}
        />
      </FieldShell>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell label="Dose" htmlFor="rx-dose">
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <Input
              id="rx-dose"
              inputMode="decimal"
              value={form.dose}
              disabled={readOnly}
              onChange={(e) => set({ dose: e.target.value })}
              data-testid={tid(S, "dose")}
            />
            <Select
              aria-label="Dose unit"
              value={form.doseUnit}
              disabled={readOnly}
              onValueChange={(v) => set({ doseUnit: v })}
              options={DOSE_UNITS}
              testId={tid(S, "dose-unit")}
            />
          </div>
        </FieldShell>
        <FieldShell label="Route" htmlFor="rx-route">
          <Select
            id="rx-route"
            value={form.route}
            disabled={readOnly}
            onValueChange={(v) => set({ route: v })}
            options={ROUTES.map((r) => ({ value: r.value, label: r.label }))}
            testId={tid(S, "route")}
          />
        </FieldShell>
        <FieldShell label="Frequency" htmlFor="rx-frequency">
          <Select
            id="rx-frequency"
            value={form.frequency}
            disabled={readOnly}
            onValueChange={(v) => set({ frequency: v })}
            options={FREQUENCIES}
            placeholder="Choose…"
            testId={tid(S, "frequency")}
          />
        </FieldShell>
        <FieldShell label="Duration (days)" htmlFor="rx-duration">
          <Input
            id="rx-duration"
            inputMode="numeric"
            value={form.duration}
            disabled={readOnly}
            onChange={(e) => set({ duration: e.target.value.replace(/\D/g, "") })}
            data-testid={tid(S, "duration")}
          />
        </FieldShell>
        <FieldShell label="Quantity" htmlFor="rx-quantity" required>
          <Input
            id="rx-quantity"
            inputMode="decimal"
            value={form.quantity}
            disabled={readOnly}
            onChange={(e) => onChange({ ...form, quantity: e.target.value })}
            data-testid={tid(S, "quantity")}
          />
        </FieldShell>
        <FieldShell label="Refills" htmlFor="rx-refills">
          <Input
            id="rx-refills"
            inputMode="numeric"
            value={form.refills}
            disabled={readOnly}
            onChange={(e) => onChange({ ...form, refills: e.target.value.replace(/\D/g, "") })}
            data-testid={tid(S, "refills")}
          />
        </FieldShell>
      </div>
      <FieldShell
        label="Patient instructions"
        htmlFor="rx-sig"
        required
        hint={readOnly ? undefined : "Built from the fields above. You can edit it."}
      >
        <Textarea
          id="rx-sig"
          rows={2}
          value={form.sig}
          disabled={readOnly}
          onChange={(e) => onChange({ ...form, sig: e.target.value, sigEdited: true })}
          data-testid={tid(S, "sig-preview")}
        />
      </FieldShell>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell label="Diagnosis" htmlFor="rx-dx">
          <Select
            id="rx-dx"
            value={form.dxId}
            disabled={readOnly}
            onValueChange={(v) => onChange({ ...form, dxId: v })}
            options={diagnoses.map((d) => ({
              value: d.id,
              label: d.icd10Code ? `${d.display} (${d.icd10Code})` : d.display,
            }))}
            placeholder={diagnoses.length ? "Choose…" : "No diagnoses on this visit"}
            testId={tid(S, "rx-dx")}
          />
        </FieldShell>
        <FieldShell label="Pharmacy">
          <SearchCombobox<Pharmacy>
            value={form.pharmacy}
            onChange={(p) => onChange({ ...form, pharmacy: p })}
            useSearch={usePharmacies}
            itemKey={(p) => p.id}
            ariaLabel="Pharmacy"
            placeholder="Search by name or ZIP"
            disabled={readOnly}
            testId={tid(S, "pharmacy")}
            renderItem={(p) => (
              <span className="grid">
                <span>{p.name}</span>
                <span className="text-small text-ink-2">
                  NCPDP {p.ncpdpId}
                  {p.epcsEnabled ? " · EPCS" : ""}
                </span>
              </span>
            )}
            renderValue={(p) => p.name}
          />
        </FieldShell>
      </div>
      <FieldShell label="Note to pharmacist" htmlFor="rx-note">
        <Input
          id="rx-note"
          value={form.note}
          disabled={readOnly}
          onChange={(e) => onChange({ ...form, note: e.target.value })}
          data-testid={tid(S, "note-to-pharmacist")}
        />
      </FieldShell>
    </div>
  );
}
