import * as React from "react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";
import { overlaySurface, scrim } from "./overlay";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Centred dialog (container: modal). `blocking` makes it a blocking-modal: no Esc, no scrim click (NAV-06).
 */
export function DialogContent({
  className,
  children,
  blocking = false,
  showClose = !blocking,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  blocking?: boolean;
  showClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onEscapeKeyDown={blocking ? (e) => e.preventDefault() : props.onEscapeKeyDown}
        onPointerDownOutside={blocking ? (e) => e.preventDefault() : props.onPointerDownOutside}
        onInteractOutside={blocking ? (e) => e.preventDefault() : props.onInteractOutside}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100vh-4rem)] w-dialog-sm max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto p-6",
          overlaySurface,
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 grid size-control-sm place-items-center text-ink hover:bg-surface-hover active:bg-surface-active"
          >
            <X size={18} strokeWidth={1.75} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-2 pr-8", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-h2 text-ink", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-body text-ink-2", className)} {...props} />
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2 pt-2", className)} {...props} />;
}

/**
 * Confirmation for destructive, irreversible, legally binding or outbound actions (Pine rule 9).
 * Title = verb + object as a question; one-sentence consequence; ghost Cancel then the verb.
 */
export const AlertDialog = AlertPrimitive.Root;
export const AlertDialogTrigger = AlertPrimitive.Trigger;

export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className={scrim} />
      <AlertPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-dialog-sm max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 p-6",
          overlaySurface,
          className,
        )}
        {...props}
      />
    </AlertPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Title>) {
  return <AlertPrimitive.Title className={cn("text-h2 text-ink", className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Description>) {
  return (
    <AlertPrimitive.Description className={cn("text-body text-ink-2", className)} {...props} />
  );
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />;
}

export function AlertDialogCancel({
  className,
  children = "Cancel",
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Cancel>) {
  return (
    <AlertPrimitive.Cancel
      className={cn(buttonVariants({ variant: "ghost" }), className)}
      {...props}
    >
      {children}
    </AlertPrimitive.Cancel>
  );
}

export function AlertDialogAction({
  className,
  danger,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Action> & { danger?: boolean }) {
  return (
    <AlertPrimitive.Action
      className={cn(buttonVariants({ variant: danger ? "danger" : "primary" }), className)}
      {...props}
    />
  );
}

/** Controlled confirm dialog used by useConfirm(). */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: React.ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  testId?: string;
  children?: React.ReactNode;
  /** Keeps the confirm button disabled until the dialog's own fields are complete. */
  disabled?: boolean;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent data-testid={props.testId}>
        <AlertDialogTitle>{props.title}</AlertDialogTitle>
        <AlertDialogDescription>{props.description}</AlertDialogDescription>
        {props.children}
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            danger={props.danger}
            onClick={props.onConfirm}
            disabled={props.disabled}
          >
            {props.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
