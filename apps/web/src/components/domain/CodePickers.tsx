import * as React from "react";
import type { CodeHit, DrugConcept } from "@agile-emr/shared";
import { useApi } from "@/lib/api/hooks";
import { errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { SearchCombobox, type SearchResult } from "@/components/ui/combobox";
import { Tag } from "@/components/ui/tag";

/** Code pickers over the reference APIs: ICD-10-CM (local), RxNorm via RxNav, SNOMED allergens. */

function useIcd10(q: string): SearchResult<CodeHit> {
  const r = useApi(
    "searchIcd10",
    { query: { q, billableOnly: true } },
    { enabled: !!q, staleTime: 300_000 },
  );
  return {
    items: r.data ?? [],
    loading: r.isFetching,
    error: r.error ? errorMessage(r.error) : null,
  };
}

export const isUnspecified = (display: string) => /\bunspecified\b/i.test(display);

/** ICD-10-CM search in plain language or by code ("high blood pressure", "E11"). */
export function Icd10Picker({
  value,
  onChange,
  testId,
  invalid,
  placeholder = "Search diagnosis or code",
  autoFocus,
}: {
  value: CodeHit | null;
  onChange: (v: CodeHit | null) => void;
  testId?: string;
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <SearchCombobox
      value={value}
      onChange={onChange}
      useSearch={useIcd10}
      itemKey={(c) => c.code}
      ariaLabel="Diagnosis"
      placeholder={placeholder}
      invalid={invalid}
      testId={testId}
      autoFocus={autoFocus}
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
  );
}

export interface DrugChoice {
  rxcui: string | null;
  name: string;
}

type DrugItem = DrugChoice & { group?: string; tty?: string };

function useDrugs(q: string): SearchResult<DrugItem> {
  const r = useApi(
    "searchDrugs",
    { query: { q } },
    { enabled: !!q, staleTime: 300_000, retry: false },
  );
  const items = React.useMemo(
    () =>
      (r.data ?? []).flatMap((d: DrugConcept) =>
        d.related?.length
          ? d.related.map((p) => ({ rxcui: p.rxcui, name: p.name, tty: p.tty, group: d.name }))
          : [{ rxcui: d.rxcui, name: d.name, tty: d.tty }],
      ),
    [r.data],
  );
  return { items, loading: r.isFetching, error: r.error ? errorMessage(r.error) : null };
}

/**
 * RxNorm product search (RxNav). When drug search is down, or the medication isn't in RxNorm (supplements), the
 * typed name can be used uncoded; it is then shown as uncoded on the list.
 */
export function DrugPicker({
  value,
  onChange,
  testId,
  invalid,
}: {
  value: DrugChoice | null;
  onChange: (v: DrugChoice | null) => void;
  testId?: string;
  invalid?: boolean;
}) {
  return (
    <SearchCombobox<DrugItem>
      value={value}
      onChange={(v) => onChange(v ? { rxcui: v.rxcui, name: v.name } : null)}
      useSearch={useDrugs}
      itemKey={(d) => `${d.rxcui}:${d.name}`}
      ariaLabel="Medication"
      placeholder="Search drug, strength or form"
      invalid={invalid}
      testId={testId}
      renderItem={(d) => (
        <span className="grid">
          <span>{d.name}</span>
          {d.group ? <span className="text-small text-ink-2">{d.group}</span> : null}
        </span>
      )}
      renderValue={(d) => (
        <span className="flex items-center gap-2">
          {d.name}
          {!d.rxcui ? <Tag tone="outline">Uncoded</Tag> : null}
        </span>
      )}
      footer={(q, close) =>
        q ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => (onChange({ rxcui: null, name: q }), close())}
          >
            Use “{q}” as typed (uncoded)
          </Button>
        ) : null
      }
    />
  );
}

export interface AllergenChoice {
  system: "RXNORM" | "SNOMEDCT";
  code: string;
  display: string;
  category: "MEDICATION" | "FOOD" | "ENVIRONMENT" | "BIOLOGIC";
}

const CATEGORY_LABEL: Record<string, string> = {
  MEDICATION: "Drug",
  DRUG_CLASS: "Drug class",
  FOOD: "Food",
  ENVIRONMENT: "Environmental",
};

type AllergenItem = AllergenChoice & { kind?: string };

function useAllergens(q: string): SearchResult<AllergenItem> {
  const snomed = useApi("searchSnomed", { query: { q } }, { staleTime: 300_000 });
  const drugs = useApi(
    "searchDrugs",
    { query: { q } },
    { enabled: q.length >= 3, staleTime: 300_000, retry: false },
  );
  const items = React.useMemo(() => {
    const out: AllergenItem[] = [];
    for (const d of (drugs.data ?? [])
      .filter((d) => d.tty === "IN" || d.related?.length)
      .slice(0, 5))
      out.push({
        system: "RXNORM",
        code: d.rxcui,
        display: d.name,
        category: "MEDICATION",
        kind: "Drug",
      });
    for (const c of snomed.data ?? [])
      out.push({
        system: c.system === "RXNORM" ? "RXNORM" : "SNOMEDCT",
        code: c.code,
        display: c.display,
        category:
          c.category === "FOOD"
            ? "FOOD"
            : c.category === "ENVIRONMENT"
              ? "ENVIRONMENT"
              : "MEDICATION",
        kind: CATEGORY_LABEL[c.category ?? ""] ?? "Substance",
      });
    return out;
  }, [drugs.data, snomed.data]);
  return {
    items,
    loading: snomed.isFetching || drugs.isFetching,
    error: snomed.error && drugs.error ? errorMessage(snomed.error) : null,
  };
}

/** Allergen search: drugs (RxNorm ingredients), drug classes, foods and environmental agents (SNOMED CT). */
export function AllergenPicker({
  value,
  onChange,
  testId,
  invalid,
}: {
  value: AllergenChoice | null;
  onChange: (v: AllergenChoice | null) => void;
  testId?: string;
  invalid?: boolean;
}) {
  return (
    <SearchCombobox<AllergenItem>
      value={value}
      onChange={(v) =>
        onChange(
          v ? { system: v.system, code: v.code, display: v.display, category: v.category } : null,
        )
      }
      useSearch={useAllergens}
      minChars={0}
      itemKey={(a) => `${a.system}:${a.code}`}
      ariaLabel="Substance"
      placeholder="Drug, drug class, food or environmental"
      invalid={invalid}
      testId={testId}
      renderItem={(a) => (
        <span className="flex items-baseline justify-between gap-3">
          <span>{a.display}</span>
          <span className="shrink-0 text-small text-ink-2">{a.kind}</span>
        </span>
      )}
      renderValue={(a) => a.display}
    />
  );
}
