import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-6", className)} {...props} />;
}

const tabClass =
  "relative inline-flex h-10 items-center gap-2 whitespace-nowrap text-body font-semibold text-ink-2 transition-colors duration-fast hover:text-ink data-[state=active]:text-ink aria-[current=page]:text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 data-[state=active]:after:bg-pine-600 aria-[current=page]:after:bg-pine-600";

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(tabClass, className)} {...props} />;
}

export const TabsContent = TabsPrimitive.Content;

/** Tab row whose tabs are sibling routes (encounter section tabs, billing nav, schedule nav). */
export function RouteTabs({
  items,
  className,
}: {
  items: Array<{
    to: string;
    label: React.ReactNode;
    count?: number;
    testId?: string;
    end?: boolean;
  }>;
  className?: string;
}) {
  return (
    <nav className={cn("flex gap-6 overflow-x-auto", className)}>
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} data-testid={t.testId} className={tabClass}>
          {t.label}
          {t.count ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-muted px-1.5 text-caption tabular-nums text-ink">
              {t.count}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
