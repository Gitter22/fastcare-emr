import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Tags and chips. Colour is clinical only: caution/critical always carry a word (Pine rule 3). */
export const tagVariants = cva(
  "inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap px-2 text-caption [&_svg]:size-4",
  {
    variants: {
      tone: {
        neutral: "bg-surface-muted text-ink",
        active: "bg-pine-50 text-pine-700",
        caution: "bg-caution-bg text-caution-ink",
        critical: "bg-danger-bg text-danger-ink",
        outline: "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Tag({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof tagVariants>) {
  return <span className={cn(tagVariants({ tone }), className)} {...props} />;
}
