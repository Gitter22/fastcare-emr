import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Pine button. Default is secondary; one primary per view (Pine rule 1). */
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-body font-semibold transition-colors duration-fast ease-standard disabled:cursor-not-allowed disabled:bg-surface-active disabled:text-ink-3 disabled:shadow-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-pine-600 text-on-primary hover:bg-pine-700 active:bg-pine-800",
        secondary:
          "bg-surface text-ink shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-surface-hover active:bg-surface-active",
        ghost: "text-ink hover:bg-surface-hover active:bg-surface-active disabled:bg-transparent",
        danger: "bg-danger text-on-primary hover:bg-danger-hover active:bg-danger-ink",
        link: "h-auto px-0 text-ink underline underline-offset-4 hover:text-pine-700 disabled:bg-transparent",
      },
      size: {
        sm: "h-control-sm px-3 text-label",
        md: "h-control-md px-4",
        lg: "h-control-lg px-5 text-body-lg",
        icon: "size-control-md p-0",
        "icon-sm": "size-control-sm p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), variant === "link" && "px-0", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? (
            <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />
          ) : null}
          {children}
        </>
      )}
    </Comp>
  );
}
