import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldControl =
  "h-control-md w-full border border-line-strong bg-surface px-3 text-body text-ink placeholder:text-ink-3 hover:border-ink-2 focus:border-pine-600 focus:shadow-[inset_0_0_0_1px_var(--color-pine-600)] focus:outline-none aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-3 transition-colors duration-fast ease-standard";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(fieldControl, className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldControl, "h-auto min-h-24 py-2 leading-5", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("text-label text-ink", className)} {...props} />;
}
