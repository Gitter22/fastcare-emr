import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Unstyled clickable surface for full-width rows, cards and slot tiles with custom layout.
 * Only adds the Pine focus ring (same as the global :focus-visible rule) and a disabled cursor.
 * Use `Button` for normal actions.
 */
export const Pressable = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button">
>(function Pressable({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      data-slot="pressable"
      type={type}
      className={cn(
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
});
