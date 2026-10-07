import * as React from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { FileText, UserRound, Zap } from "lucide-react";
import type { ScreenId } from "@agile-emr/shared";
import { pathTo } from "@/app/routes";
import { isBuilt } from "@/app/registry";
import { useApi } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format";
import { overlaySurface, scrim } from "@/components/ui/overlay";

/**
 * global.command-bar (⌘K / Ctrl+K, NAV-08): any patient (name, DOB, MRN, phone), any screen the role may see, and
 * named actions. Every patient row shows DOB (INV-ID-01).
 */
const ACTION_TARGETS: Record<string, { screen: ScreenId; view?: string }> = {
  book: { screen: "schedule.calendar", view: "book" },
  "new-patient": { screen: "patients.registration" },
  "new-message": { screen: "inbox.tasks", view: "compose" },
  "new-task": { screen: "inbox.tasks", view: "compose" },
  "take-payment": { screen: "billing.payment-capture" },
};

export function CommandBar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const search = useApi("globalSearch", { query: { q: debounced } }, { enabled: open });
  const recent = useApi("listRecentPatients", undefined, { enabled: open && !debounced });
  const patients = debounced ? (search.data?.patients ?? []) : (recent.data ?? []);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={scrim} />
        <DialogPrimitive.Content
          className={`fixed left-1/2 top-24 z-50 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 ${overlaySurface}`}
          data-testid="global.command-bar"
          aria-label="Command bar"
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <Command shouldFilter={false} label="Search patients, screens and actions">
            <Command.Input
              value={q}
              onValueChange={setQ}
              autoFocus
              placeholder="Name, DOB, MRN, phone, screen or action"
              className="h-control-lg w-full border-b border-line bg-surface px-4 text-body-lg text-ink placeholder:text-ink-3 focus:outline-none"
            />
            <Command.List className="max-h-[420px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-body text-ink-2">
                {debounced.length >= 2 && search.isFetching ? "Searching…" : "No matches."}
              </Command.Empty>
              {patients.length ? (
                <Command.Group
                  heading={debounced ? "Patients" : "Recent patients"}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-2"
                >
                  {patients.map((p) => (
                    <Item
                      key={p.id}
                      value={`p-${p.id}`}
                      onSelect={() => go(pathTo("chart.summary", { patientId: p.id }))}
                    >
                      <UserRound size={18} strokeWidth={1.75} aria-hidden />
                      <span className="font-semibold">{p.name}</span>
                      <span className="tabular-nums text-ink-2">DOB {formatDate(p.birthDate)}</span>
                      <span className="ml-auto tabular-nums text-small text-ink-2">
                        MRN {p.mrn}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              ) : null}
              {(search.data?.screens ?? []).filter((s) => isBuilt(s.id as ScreenId)).length ? (
                <Command.Group
                  heading="Screens"
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-2"
                >
                  {search
                    .data!.screens.filter((s) => isBuilt(s.id as ScreenId))
                    .map((s) => (
                      <Item key={s.id} value={`s-${s.id}`} onSelect={() => go(s.route)}>
                        <FileText size={18} strokeWidth={1.75} aria-hidden />
                        {s.label}
                      </Item>
                    ))}
                </Command.Group>
              ) : null}
              {(search.data?.actions ?? []).filter(
                (a) => ACTION_TARGETS[a.id] && isBuilt(ACTION_TARGETS[a.id]!.screen),
              ).length ? (
                <Command.Group
                  heading="Actions"
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-2"
                >
                  {search
                    .data!.actions.filter(
                      (a) => ACTION_TARGETS[a.id] && isBuilt(ACTION_TARGETS[a.id]!.screen),
                    )
                    .map((a) => (
                      <Item
                        key={a.id}
                        value={`a-${a.id}`}
                        onSelect={() =>
                          go(pathTo(ACTION_TARGETS[a.id]!.screen, {}, ACTION_TARGETS[a.id]!.view))
                        }
                      >
                        <Zap size={18} strokeWidth={1.75} aria-hidden />
                        {a.label}
                      </Item>
                    ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Item({ children, ...props }: React.ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      {...props}
      className="flex h-row-default cursor-pointer items-center gap-3 px-3 text-body text-ink data-[selected=true]:bg-surface-hover"
    >
      {children}
    </Command.Item>
  );
}
