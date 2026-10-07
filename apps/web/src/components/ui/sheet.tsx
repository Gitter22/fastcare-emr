import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { scrim } from "./overlay";

/** Drawer (container: drawer): slides in from the right over the screen; closing returns to it. */
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

export function SheetContent({
  className,
  children,
  width = "w-[560px]",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { width?: string }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className={scrim} />
      <SheetPrimitive.Content
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex max-w-[100vw] flex-col bg-surface text-ink shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-slow data-[state=closed]:duration-fast",
          width,
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          aria-label="Close"
          className="absolute right-4 top-5 grid size-control-sm place-items-center text-ink hover:bg-surface-hover active:bg-surface-active"
        >
          <X size={18} strokeWidth={1.75} />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-1 px-6 pb-4 pr-14 pt-6", className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn("text-h2 text-ink", className)} {...props} />;
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description className={cn("text-small text-ink-2", className)} {...props} />
  );
}

export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex-1 overflow-y-auto px-6 pb-6", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 bg-surface px-6 py-4 shadow-sticky",
        className,
      )}
      {...props}
    />
  );
}
