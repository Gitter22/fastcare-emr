import * as React from "react";
import type { PatientSummary } from "@agile-emr/shared";
import { useApi } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/menu";
import { Pressable } from "@/components/ui/pressable";

/** Patient type-ahead (search box with results popover). Rows show DOB and MRN (INV-ID-01). */
export function PatientPicker({
  value,
  onChange,
  testId,
  placeholder = "Any patient",
}: {
  value: PatientSummary | null;
  onChange: (p: PatientSummary | null) => void;
  testId?: string;
  placeholder?: string;
}) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useApi(
    "searchPatients",
    { query: { q: debounced, limit: 8 } },
    { enabled: debounced.length >= 2 },
  );
  if (value) {
    return (
      <div
        className="flex h-control-md items-center justify-between gap-2 border border-line-strong bg-surface px-3"
        data-testid={testId}
      >
        <span className="truncate text-body">{value.name}</span>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Clear
        </Button>
      </div>
    );
  }
  return (
    <Popover open={open && debounced.length >= 2} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          value={q}
          onChange={(e) => (setQ(e.target.value), setOpen(true))}
          placeholder={placeholder}
          aria-label="Patient"
          data-testid={testId}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-72 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {results.isLoading ? <p className="p-3 text-body text-ink-2">Searching…</p> : null}
        {results.data?.data.length === 0 ? (
          <p className="p-3 text-body text-ink-2">No matches.</p>
        ) : null}
        {results.data?.data.map((p) => (
          <Pressable
            key={p.id}
            type="button"
            className="grid w-full gap-0.5 px-3 py-2 text-left hover:bg-surface-hover"
            onClick={() => (onChange(p), setQ(""), setOpen(false))}
          >
            <span className="font-semibold">{p.name}</span>
            <span className="text-small tabular-nums text-ink-2">
              DOB {formatDate(p.birthDate)} · MRN {p.mrn}
            </span>
          </Pressable>
        ))}
      </PopoverContent>
    </Popover>
  );
}
