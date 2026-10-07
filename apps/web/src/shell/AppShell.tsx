import * as React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bell,
  CalendarDays,
  Home,
  Inbox,
  Receipt,
  Search,
  Settings,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { ScreenId } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { homeByRole, inboxByRole, pathTo } from "@/app/routes";
import { isBuilt } from "@/app/registry";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { CommandBar } from "./CommandBar";
import { NotificationsTray } from "./Notifications";
import { useCharts } from "./charts";

/** pattern app-shell: left rail (nav.yaml#rail) and top bar (nav.yaml#topbar) around the content. */
interface RailItem {
  id: string;
  label: string;
  icon: LucideIcon;
  target: (role: string) => ScreenId | null;
  count?: "inbox";
}

const byRole = (m: Record<string, ScreenId>) => (role: string) => m[role] ?? null;
const RAIL: RailItem[] = [
  { id: "rail-home", label: "Home", icon: Home, target: byRole(homeByRole) },
  { id: "rail-schedule", label: "Schedule", icon: CalendarDays, target: () => "schedule.calendar" },
  { id: "rail-patients", label: "Patients", icon: Users, target: () => "patients.search" },
  { id: "rail-inbox", label: "Inbox", icon: Inbox, target: byRole(inboxByRole), count: "inbox" },
  {
    id: "rail-billing",
    label: "Billing",
    icon: Receipt,
    target: byRole({
      frontdesk: "billing.eligibility",
      biller: "billing.charge-review",
      manager: "billing.day-close",
    }),
  },
  {
    id: "rail-reports",
    label: "Reports",
    icon: BarChart3,
    target: byRole({
      provider: "reports.quality",
      biller: "reports.ar-aging",
      manager: "reports.quality",
      frontdesk: "reports.no-shows",
      ma: "reports.care-gaps",
    }),
  },
  {
    id: "rail-telehealth",
    label: "Telehealth",
    icon: Video,
    target: (r) => (r === "ma" || r === "provider" ? "telehealth.waiting-room" : null),
  },
  {
    id: "rail-admin",
    label: "Admin",
    icon: Settings,
    target: (r) => (r === "manager" ? "admin.users-roles" : null),
  },
];

/** First built screen for a rail item: its role target, else the first built screen in the same module. */
function railTarget(item: RailItem, role: string): ScreenId | null {
  const t = item.target(role);
  return t && isBuilt(t) ? t : null;
}

export function AppShell() {
  const me = useMe();
  const { pathname } = useLocation();
  const counts = useApi("getInboxCounts", undefined, { refetchInterval: 60_000 });
  const setLastNonChart = useCharts((s) => s.setLastNonChart);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);

  React.useEffect(() => {
    if (!pathname.startsWith("/patient/")) setLastNonChart(pathname);
  }, [pathname, setLastNonChart]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inboxTotal = counts.data?.tasks ?? 0;
  return (
    <div className="grid min-h-full grid-cols-[var(--spacing-sidebar)_minmax(0,1fr)] bg-canvas">
      <nav
        className="sticky top-0 grid h-screen content-start gap-0.5 overflow-y-auto bg-surface px-3 py-4"
        aria-label="Main"
      >
        <div className="px-3 pb-4 text-[18px] font-extrabold leading-6 tracking-[-0.02em] text-ink">
          Agile EMR
        </div>
        {RAIL.map((item) => {
          const target = railTarget(item, me.role);
          if (!target) return null;
          const to = pathTo(target);
          const module = target.split(".")[0];
          const active =
            pathname.startsWith(`/${module}`) ||
            (item.id === "rail-home" && pathname.startsWith("/home")) ||
            (item.id === "rail-inbox" &&
              (pathname.startsWith("/inbox") ||
                pathname.startsWith("/orders") ||
                pathname.startsWith("/referrals")));
          return (
            <NavLink
              key={item.id}
              to={to}
              data-testid={item.id}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-row-compact items-center gap-3 px-3 text-body font-medium text-ink-2 transition-colors duration-fast hover:bg-surface-hover hover:text-ink",
                active &&
                  "bg-pine-50 font-semibold text-pine-700 hover:bg-pine-50 hover:text-pine-700",
              )}
            >
              <item.icon size={18} strokeWidth={1.75} aria-hidden />
              {item.label}
              {item.count === "inbox" && inboxTotal > 0 ? (
                <span
                  className={cn(
                    "ml-auto text-caption tabular-nums",
                    active ? "text-pine-700" : "text-ink-2",
                  )}
                >
                  {inboxTotal}
                </span>
              ) : null}
            </NavLink>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-col">
        <Topbar
          onCommand={() => setCommandOpen(true)}
          onNotifications={() => setNotificationsOpen(true)}
          inboxTotal={inboxTotal}
        />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <CommandBar open={commandOpen} onOpenChange={setCommandOpen} />
      <NotificationsTray open={notificationsOpen} onOpenChange={setNotificationsOpen} />
    </div>
  );
}

function Topbar({
  onCommand,
  onNotifications,
  inboxTotal,
}: {
  onCommand: () => void;
  onNotifications: () => void;
  inboxTotal: number;
}) {
  const me = useMe();
  const auth = useAuth();
  const navigate = useNavigate();
  const unread = useApi("listNotifications", { query: { limit: 50 } }, { refetchInterval: 60_000 });
  const unreadCount = unread.data?.data.filter((n) => !n.readAt).length ?? 0;
  const resetCharts = useCharts((s) => s.reset);

  const switchRole = async (role: string) => {
    const { api } = await import("@/lib/api/client");
    const next = await api("switchActiveRole", { body: { role: role as never } });
    auth.setMe(next);
    navigate(pathTo(next.homeScreen as ScreenId));
  };
  const switchLocation = async (locationId: string) => {
    const { api } = await import("@/lib/api/client");
    auth.setMe(await api("switchActiveRole", { body: { role: me.activeRole, locationId } }));
  };
  const inboxTarget = inboxByRole[me.role];

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 bg-surface px-6 shadow-sticky">
      <span className="text-body font-semibold text-ink" data-testid="practice-name">
        {me.practice.name}
      </span>
      {me.locations.length > 1 ? (
        <Select
          aria-label="Location"
          testId="location-switch"
          className="h-control-sm w-44"
          value={me.activeLocationId ?? ""}
          onValueChange={switchLocation}
          options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
        />
      ) : null}
      <button
        type="button"
        onClick={onCommand}
        data-testid="command-bar-trigger"
        className="flex h-control-sm min-w-0 max-w-xl flex-1 items-center gap-2 border border-line-strong bg-surface px-3 text-left text-body text-ink-2 hover:border-ink-2"
      >
        <Search size={16} strokeWidth={1.75} aria-hidden />
        <span className="flex-1 truncate">Search patients, screens, actions</span>
        <kbd className="bg-surface-muted px-1.5 text-caption text-ink">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-2">
        {inboxTarget && isBuilt(inboxTarget) ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(pathTo(inboxTarget))}
            data-testid="inbox-count"
          >
            Inbox <span className="tabular-nums">{inboxTotal}</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Notifications, ${unreadCount} unread`}
          onClick={onNotifications}
          data-testid="notifications-bell"
          className="relative"
        >
          <Bell size={18} strokeWidth={1.75} />
          {unreadCount > 0 ? (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-caption leading-none text-on-primary">
              {unreadCount}
            </span>
          ) : null}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="user-menu" className="gap-3">
              <span className="text-right leading-tight">
                <span className="block text-body font-semibold">{me.user.name}</span>
                <span className="block text-caption text-ink-2">{roleLabel(me.role)}</span>
              </span>
              <span className="grid size-8 place-items-center rounded-full bg-surface-muted text-caption text-ink">
                {initials(me.user.name)}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {me.roles.length > 1 ? (
              <>
                <DropdownMenuLabel>Act as</DropdownMenuLabel>
                {me.roles.map((r) => (
                  <DropdownMenuItem
                    key={r}
                    onSelect={() => void switchRole(r)}
                    className={r === me.activeRole ? "bg-pine-50 text-pine-700" : undefined}
                  >
                    {roleLabel(r.toLowerCase())}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onSelect={() => navigate(pathTo("auth.account-security"))}
              data-testid="user-security"
            >
              Account security
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                resetCharts();
                await auth.signOut();
                navigate("/sign-in");
              }}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export const roleLabel = (r: string) =>
  ({
    frontdesk: "Front desk",
    ma: "MA / nurse",
    provider: "Provider",
    biller: "Biller",
    manager: "Practice manager",
  })[r] ?? r;
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
