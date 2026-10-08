import * as React from "react";
import { DayPicker } from "react-day-picker";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { fieldControl } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./menu";

/**
 * Date entry for business dates (value "YYYY-MM-DD"). Typing MM/DD/YYYY is fastest for front-desk work
 * (product principle 7); the calendar is there for picking.
 */
const toDisplay = (iso: string | undefined | null) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
};

function parseTyped(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
}

export function DateInput({
  value,
  onChange,
  id,
  invalid,
  disabled,
  testId,
  fromYear = 1900,
  toYear = new Date().getFullYear() + 5,
  "aria-label": ariaLabel,
  onBlur,
}: {
  value: string | undefined | null;
  onChange: (iso: string | null) => void;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
  testId?: string;
  fromYear?: number;
  toYear?: number;
  "aria-label"?: string;
  onBlur?: () => void;
}) {
  const [text, setText] = React.useState(toDisplay(value));
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setText(toDisplay(value)), [value]);
  const selected = value ? new Date(`${value}T12:00:00`) : undefined;

  const onType = (s: string) => {
    // Auto-insert slashes: 03141968 -> 03/14/1968.
    const digits = s.replace(/\D/g, "").slice(0, 8);
    // Slashes the user typed (8/6/2024) are kept; otherwise the digits are re-grouped as MM/DD/YYYY, so typing
    // straight through after the first auto-slash still lands in the right place.
    const userSlashes = /^\d{1,2}\/(\d{1,2}(\/\d{0,4})?)?$/.test(s) && !/^\d{2}\/\d{3,}/.test(s);
    const formatted = userSlashes
      ? s
      : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
    setText(formatted);
    const iso = parseTyped(formatted);
    onChange(iso);
  };

  return (
    <div className="relative">
      <input
        id={id}
        data-testid={testId}
        aria-label={ariaLabel}
        inputMode="numeric"
        placeholder="MM/DD/YYYY"
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onType(e.target.value)}
        onBlur={onBlur}
        className={cn(fieldControl, "pr-10 tabular-nums")}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1"
            aria-label="Open calendar"
            disabled={disabled}
          >
            <CalendarDays size={18} strokeWidth={1.75} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="p-3">
          <DayPicker
            mode="single"
            captionLayout="dropdown"
            startMonth={new Date(fromYear, 0)}
            endMonth={new Date(toYear, 11)}
            selected={selected}
            defaultMonth={selected}
            onSelect={(d) => {
              if (!d) return;
              const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              onChange(iso);
              setOpen(false);
            }}
            classNames={{
              root: "text-body",
              months: "grid",
              month_caption: "flex h-control-sm items-center gap-2 font-semibold",
              dropdowns: "flex gap-2",
              dropdown: "border border-line-strong bg-surface px-1 text-body",
              nav: "absolute right-3 top-3 flex gap-1",
              button_previous: "grid size-control-sm place-items-center hover:bg-surface-hover",
              button_next: "grid size-control-sm place-items-center hover:bg-surface-hover",
              weekday: "h-8 w-9 text-caption text-ink-2",
              day: "size-9 p-0 text-center",
              day_button: "size-9 tabular-nums hover:bg-surface-hover",
              selected: "bg-pine-600 text-on-primary [&>button]:hover:bg-pine-700",
              today: "font-bold",
              outside: "text-ink-3",
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
