import * as React from "react";
import { NavLink } from "react-router-dom";
import type { ScreenId } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo } from "@/app/routes";
import { cn } from "@/lib/utils";
import { RouteTabs } from "@/components/ui/tabs";
import { screens } from "@agile-emr/shared";

/** Sub-navigation blocks from nav.yaml, filtered to built screens the role may open (NAV-09). */
type NavEntry = { id: string; label: string; screen: ScreenId };

function visible(entries: NavEntry[], role: string | null) {
  return entries.filter(
    (e) =>
      isBuilt(e.screen) &&
      (screens[e.screen].accessRoles as readonly string[]).includes(role ?? ""),
  );
}

const ADMIN_NAV: Array<{ group: string; items: NavEntry[] }> = [
  {
    group: "Organisation",
    items: [
      { id: "anav-locations", label: "Practice & locations", screen: "admin.locations" },
      { id: "anav-users", label: "Users & roles", screen: "admin.users-roles" },
      { id: "anav-providers", label: "Providers", screen: "admin.providers" },
    ],
  },
  {
    group: "Scheduling & billing",
    items: [
      { id: "anav-visit-types", label: "Visit types", screen: "admin.visit-types" },
      { id: "anav-online-booking", label: "Online booking", screen: "admin.online-booking" },
      { id: "anav-payers", label: "Payers & fees", screen: "admin.payers-fees" },
    ],
  },
  {
    group: "Clinical content",
    items: [
      { id: "anav-templates", label: "Templates", screen: "admin.templates" },
      { id: "anav-order-sets", label: "Order sets", screen: "admin.order-sets" },
      { id: "anav-forms", label: "Forms", screen: "admin.forms" },
      { id: "anav-cds", label: "Alert rules", screen: "admin.cds-rules" },
    ],
  },
  {
    group: "Security & interfaces",
    items: [
      { id: "anav-security", label: "Security policy", screen: "admin.security" },
      { id: "anav-audit", label: "Audit log", screen: "admin.audit-log" },
      { id: "anav-interfaces", label: "Interfaces", screen: "admin.interfaces" },
      { id: "anav-portal", label: "Portal settings", screen: "admin.portal-settings" },
    ],
  },
];

/** pattern settings: admin side navigation (nav.yaml#admin-nav), then the screen's list + edit pane. */
export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  return (
    <div className="grid min-h-full grid-cols-[220px_minmax(0,1fr)] gap-8 p-8">
      <nav aria-label="Admin" className="grid content-start gap-0.5">
        {ADMIN_NAV.map((g) => {
          const items = visible(g.items, role);
          if (!items.length) return null;
          return (
            <div key={g.group} className="grid gap-0.5">
              <div className="px-3 pb-2 pt-4 text-caption text-ink-2 first:pt-0">{g.group}</div>
              {items.map((i) => (
                <SideLink key={i.id} to={pathTo(i.screen)} testId={i.id}>
                  {i.label}
                </SideLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="grid min-w-0 content-start gap-6">{children}</div>
    </div>
  );
}

export function SideLink({
  to,
  children,
  testId,
  end,
}: {
  to: string;
  children: React.ReactNode;
  testId?: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          "flex h-row-compact items-center gap-2 px-3 text-body font-medium text-ink-2 transition-colors duration-fast hover:bg-surface-hover hover:text-ink",
          isActive && "bg-pine-50 font-semibold text-pine-700 hover:bg-pine-50 hover:text-pine-700",
        )
      }
    >
      {children}
    </NavLink>
  );
}

const PATIENTS_NAV: NavEntry[] = [
  { id: "pnav-search", label: "Search", screen: "patients.search" },
  { id: "pnav-lists", label: "Lists & panels", screen: "patients.lists" },
  { id: "pnav-registries", label: "Registries", screen: "patients.registries" },
  { id: "pnav-merge", label: "Duplicates", screen: "patients.merge-review" },
];

const SCHEDULE_NAV: NavEntry[] = [
  { id: "snav-calendar", label: "Calendar", screen: "schedule.calendar" },
  { id: "snav-flow", label: "Flow board", screen: "schedule.flow-board" },
  { id: "snav-rooms", label: "Rooms", screen: "schedule.room-board" },
  { id: "snav-waitlist", label: "Waitlist", screen: "schedule.waitlist" },
  { id: "snav-recalls", label: "Recalls", screen: "schedule.recall-list" },
];

export function SubNav({ which }: { which: "patients" | "schedule" }) {
  const { role } = useAuth();
  const entries = visible(which === "patients" ? PATIENTS_NAV : SCHEDULE_NAV, role);
  if (entries.length < 2) return null;
  return (
    <RouteTabs
      items={entries.map((e) => ({
        to: pathTo(e.screen),
        label: e.label,
        testId: e.id,
        end: true,
      }))}
    />
  );
}

/** pattern form-page: stepper on the left, form sections, optional aside, sticky action bar. */
export function FormPage({
  steps,
  aside,
  actions,
  status,
  children,
}: {
  steps: React.ReactNode;
  aside?: React.ReactNode;
  actions: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <div
        className={cn(
          "grid flex-1 content-start gap-8 px-8 pb-8",
          aside ? "grid-cols-[200px_minmax(0,1fr)_340px]" : "grid-cols-[200px_minmax(0,1fr)]",
        )}
      >
        <aside className="grid content-start gap-4">{steps}</aside>
        <div className="grid min-w-0 content-start gap-6">{children}</div>
        {aside ? <aside className="grid content-start gap-4">{aside}</aside> : null}
      </div>
      <div className="sticky bottom-0 z-20 flex items-center gap-3 bg-surface px-8 py-3">
        <div className="text-small text-ink-2">{status}</div>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
