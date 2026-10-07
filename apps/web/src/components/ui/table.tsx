import * as React from "react";
import { cn } from "@/lib/utils";

/** Pine table: ink rule under the header, hairlines between rows, numbers right-aligned and tabular. */
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-body", className)} {...props} />
    </div>
  );
}
export function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead {...props} />;
}
export function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody {...props} />;
}
export function TableRow({
  className,
  selected,
  onClick,
  ...props
}: React.ComponentProps<"tr"> & { selected?: boolean }) {
  return (
    <tr
      data-state={selected ? "selected" : undefined}
      aria-selected={selected || undefined}
      onClick={onClick}
      className={cn(
        "border-b border-line last:border-b-0 transition-colors duration-fast hover:bg-surface-hover data-[state=selected]:bg-pine-50",
        onClick && "cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}
export function TableHead({
  className,
  numeric,
  ...props
}: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        "h-9 whitespace-nowrap border-b border-ink px-3 text-left align-middle text-label text-ink-2 first:pl-0 last:pr-0",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({
  className,
  numeric,
  compact,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean; compact?: boolean }) {
  return (
    <td
      className={cn(
        compact ? "h-row-compact" : "h-row-default",
        "px-3 align-middle first:pl-0 last:pr-0",
        numeric && "text-right font-medium tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
