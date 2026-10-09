import * as React from "react";
import { X } from "lucide-react";
import type { DrugConcept } from "@agile-emr/shared";
import { errorMessage } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PRODUCT = new Set(["SCD", "SBD", "GPCK", "BPCK"]);
interface Product {
  rxcui: string;
  name: string;
  group?: string;
}

/**
 * RxNorm product search. A prescription needs a product (drug + strength + form), so ingredient and brand hits
 * are expanded to their products. The query is controlled so "Switch to this" can seed it with an alternative.
 */
export function DrugSearch({
  value,
  q,
  onQChange,
  onPick,
  onClear,
  disabled,
  testId,
}: {
  value: { rxcui: string; name: string } | null;
  q: string;
  onQChange: (q: string) => void;
  onPick: (p: { rxcui: string; name: string }) => void;
  onClear: () => void;
  disabled?: boolean;
  testId: string;
}) {
  const [debounced, setDebounced] = React.useState(q.trim());
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const enabled = !value && debounced.length >= 2;
  const r = useApi(
    "searchDrugs",
    { query: { q: debounced } },
    { enabled, staleTime: 300_000, retry: false },
  );
  const items = React.useMemo(() => {
    const out: Product[] = [];
    for (const d of (r.data ?? []) as DrugConcept[]) {
      if (PRODUCT.has(d.tty)) out.push({ rxcui: d.rxcui, name: d.name });
      for (const p of d.related ?? [])
        if (PRODUCT.has(p.tty)) out.push({ rxcui: p.rxcui, name: p.name, group: d.name });
    }
    return out.filter((p, i) => out.findIndex((o) => o.rxcui === p.rxcui) === i).slice(0, 30);
  }, [r.data]);

  if (value)
    return (
      <div
        className="flex min-h-control-md items-center justify-between gap-2 border border-line-strong bg-surface px-3 py-1.5"
        data-testid={testId}
      >
        <span className="min-w-0 text-body">{value.name}</span>
        {!disabled ? (
          <Button variant="ghost" size="icon-sm" aria-label="Clear medication" onClick={onClear}>
            <X size={16} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="grid gap-1">
      <Input
        value={q}
        onChange={(e) => onQChange(e.target.value)}
        placeholder="Search drug, strength or form"
        aria-label="Medication"
        disabled={disabled}
        data-testid={testId}
      />
      {enabled ? (
        <ul
          className="max-h-72 overflow-y-auto border border-line bg-surface"
          aria-label="Products"
        >
          {r.isFetching ? <li className="px-3 py-2 text-body text-ink-2">Searching…</li> : null}
          {r.error ? (
            <li className="px-3 py-2 text-body text-caution-ink" role="alert">
              {errorMessage(r.error)}
            </li>
          ) : null}
          {!r.isFetching && !r.error && !items.length ? (
            <li className="px-3 py-2 text-body text-ink-2">No matching products.</li>
          ) : null}
          {items.map((p) => (
            <li key={p.rxcui}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal py-2 text-left font-normal"
                onClick={() => onPick({ rxcui: p.rxcui, name: p.name })}
              >
                <span className="grid">
                  <span>{p.name}</span>
                  {p.group ? <span className="text-small text-ink-2">{p.group}</span> : null}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
