import * as React from "react";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Select as SelectPrimitive,
  Switch as SwitchPrimitive,
} from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldControl } from "./input";
import { overlaySurface } from "./overlay";

export interface Option<V extends string = string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
}

/** Select with Pine field styling. `value === ""` shows the placeholder. */
export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder = "Select",
  id,
  disabled,
  invalid,
  className,
  testId,
  "aria-label": ariaLabel,
}: {
  value: V | "" | undefined;
  onValueChange: (v: V) => void;
  options: Option<V>[];
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  testId?: string;
  "aria-label"?: string;
}) {
  return (
    <SelectPrimitive.Root
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        className={cn(
          fieldControl,
          "flex items-center justify-between gap-2 whitespace-nowrap text-left data-[placeholder]:text-ink-3 [&>span]:truncate",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={16} strokeWidth={1.75} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-y-auto py-1",
            overlaySurface,
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex h-control-sm cursor-pointer select-none items-center pl-8 pr-3 text-body text-ink outline-none data-[highlighted]:bg-surface-hover data-[state=checked]:bg-pine-50 data-[state=checked]:text-pine-700 data-[disabled]:text-ink-3"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2.5">
                  <Check size={16} strokeWidth={1.75} />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Checkbox({
  className,
  label,
  id,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { label?: React.ReactNode }) {
  const autoId = React.useId();
  const cid = id ?? autoId;
  const box = (
    <CheckboxPrimitive.Root
      id={cid}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-xs border-[1.5px] border-ink-2 bg-surface hover:border-ink data-[state=checked]:border-pine-600 data-[state=checked]:bg-pine-600 data-[state=checked]:text-on-primary disabled:border-line-strong disabled:bg-surface-muted aria-invalid:border-danger",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check size={14} strokeWidth={2.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    <label
      htmlFor={cid}
      className="inline-flex cursor-pointer items-center gap-2 text-body text-ink"
    >
      {box}
      {label}
    </label>
  );
}

export function RadioGroup<V extends string>({
  value,
  onValueChange,
  options,
  className,
  orientation = "horizontal",
  "aria-label": ariaLabel,
  testId,
}: {
  value: V | undefined;
  onValueChange: (v: V) => void;
  options: Option<V>[];
  className?: string;
  orientation?: "horizontal" | "vertical";
  "aria-label"?: string;
  testId?: string;
}) {
  return (
    <RadioPrimitive.Root
      // Always controlled: no answer yet is "" (nothing selected), never undefined.
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        orientation === "horizontal" ? "flex flex-wrap gap-x-6 gap-y-2" : "grid gap-2",
        className,
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "inline-flex items-center gap-2 text-body",
            o.disabled ? "cursor-not-allowed text-ink-3" : "cursor-pointer text-ink",
          )}
        >
          <RadioPrimitive.Item
            value={o.value}
            disabled={o.disabled}
            className="grid size-[18px] place-items-center rounded-full border-[1.5px] border-ink-2 bg-surface hover:border-ink data-[state=checked]:border-pine-600 disabled:border-line-strong disabled:bg-surface-muted"
          >
            <RadioPrimitive.Indicator className="size-2.5 rounded-full bg-pine-600" />
          </RadioPrimitive.Item>
          {o.label}
        </label>
      ))}
    </RadioPrimitive.Root>
  );
}

export function Switch({
  className,
  label,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { label?: React.ReactNode }) {
  const sw = (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-line-strong p-0.5 transition-colors duration-fast data-[state=checked]:bg-pine-600 disabled:bg-surface-active",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-surface transition-transform duration-fast data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
  if (!label) return sw;
  return (
    <label className="inline-flex cursor-pointer items-center gap-3 text-body text-ink">
      {sw}
      {label}
    </label>
  );
}
