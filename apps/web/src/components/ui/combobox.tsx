import * as React from "react";
import { Command } from "cmdk";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { fieldControl } from "./input";
import { Popover, PopoverAnchor, PopoverContent } from "./menu";

/**
 * Server-side search combobox (type-ahead): debounced query, keyboard navigation (cmdk), results in a popover. The
 * caller supplies the search hook so each code system (ICD-10, RxNorm, SNOMED) keeps its own API call and rendering.
 */
export interface SearchResult<T> {
  items: T[];
  loading: boolean;
  error?: string | null;
}

export function SearchCombobox<T>({
  value,
  onChange,
  useSearch,
  itemKey,
  renderItem,
  renderValue,
  placeholder,
  ariaLabel,
  minChars = 2,
  emptyText = "No matches.",
  footer,
  invalid,
  disabled,
  testId,
  autoFocus,
}: {
  value: T | null;
  onChange: (v: T | null) => void;
  useSearch: (q: string) => SearchResult<T>;
  itemKey: (v: T) => string;
  renderItem: (v: T) => React.ReactNode;
  renderValue: (v: T) => React.ReactNode;
  placeholder?: string;
  ariaLabel: string;
  minChars?: number;
  emptyText?: string;
  /** Extra row below the results (e.g. "Use as typed"); receives the current text. */
  footer?: (q: string, close: () => void) => React.ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  testId?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const result = useSearch(debounced.length >= minChars ? debounced : "");
  const close = () => (setOpen(false), setQ(""));

  if (value) {
    return (
      <div
        className="flex min-h-control-md items-center justify-between gap-2 border border-line-strong bg-surface px-3 py-1.5"
        data-testid={testId}
      >
        <div className="min-w-0 text-body">{renderValue(value)}</div>
        {!disabled ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Clear ${ariaLabel}`}
            onClick={() => onChange(null)}
          >
            <X size={16} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
    );
  }
  const showList = open && debounced.length >= minChars;
  return (
    <Command shouldFilter={false} className="relative" label={ariaLabel} loop>
      <Popover open={showList} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Command.Input
            value={q}
            onValueChange={(v) => (setQ(v), setOpen(true))}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            autoFocus={autoFocus}
            data-testid={testId}
            className={cn(fieldControl)}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] min-w-80 p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
          align="start"
        >
          <Command.List className="max-h-80 overflow-y-auto">
            {result.loading ? <p className="px-3 py-2 text-body text-ink-2">Searching…</p> : null}
            {result.error ? (
              <p className="px-3 py-2 text-body text-caution-ink" role="alert">
                {result.error}
              </p>
            ) : null}
            {!result.loading && !result.error && !result.items.length ? (
              <p className="px-3 py-2 text-body text-ink-2">{emptyText}</p>
            ) : null}
            {result.items.map((item) => (
              <Command.Item
                key={itemKey(item)}
                value={itemKey(item)}
                onSelect={() => (onChange(item), close())}
                className="cursor-default px-3 py-2 text-body data-[selected=true]:bg-surface-hover"
              >
                {renderItem(item)}
              </Command.Item>
            ))}
          </Command.List>
          {footer ? <div className="px-1 pb-1 pt-2">{footer(debounced, close)}</div> : null}
        </PopoverContent>
      </Popover>
    </Command>
  );
}
