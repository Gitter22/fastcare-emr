import * as React from "react";
import {
  DropdownMenu as Menu,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { overlaySurface } from "./overlay";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  ...props
}: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 min-w-48 py-1", overlaySurface, className)}
        {...props}
      />
    </Menu.Portal>
  );
}

const itemClass =
  "relative flex h-control-sm cursor-pointer select-none items-center gap-2 px-3 text-body text-ink outline-none data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:text-ink-3";

export function DropdownMenuItem({
  className,
  danger,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { danger?: boolean }) {
  return <Menu.Item className={cn(itemClass, danger && "text-danger-ink", className)} {...props} />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(itemClass, "pl-8", className)} {...props}>
      <Menu.ItemIndicator className="absolute left-2.5">
        <Check size={16} strokeWidth={1.75} />
      </Menu.ItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label className={cn("px-3 pb-1 pt-2 text-caption text-ink-2", className)} {...props} />
  );
}

export function DropdownMenuSeparator() {
  // Group spacing instead of a rule (Pine rule 6).
  return <Menu.Separator className="h-2" />;
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  sideOffset = 4,
  align = "start",
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 p-4 outline-none", overlaySurface, className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn("z-50 max-w-72 px-3 py-2 text-small", overlaySurface)}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
