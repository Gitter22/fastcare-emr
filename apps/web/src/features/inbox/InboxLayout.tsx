import * as React from "react";
import { NavLink } from "react-router-dom";
import type { ScreenId } from "@agile-emr/shared";
import { foldersFor } from "@/app/inboxFolders";
import { useMe } from "@/app/auth";
import { pathTo } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { Page, PageHeader } from "@/components/ui/layout";

/**
 * Inbox pattern: folders | items | detail (inbox.yaml). Badges come from getInboxCounts where it has the count;
 * folders whose count comes from the open list pass it in `counts`.
 */
export function InboxLayout({
  counts = {},
  children,
}: {
  counts?: Partial<Record<ScreenId, number>>;
  children: React.ReactNode;
}) {
  const me = useMe();
  const inbox = useApi("getInboxCounts", undefined, { refetchInterval: 60_000 });
  const fromServer: Partial<Record<ScreenId, number>> = {
    "inbox.results": inbox.data?.results,
    "inbox.cosign": inbox.data?.cosign,
    "inbox.rx-requests": inbox.data?.rxRequests,
    "inbox.patient-messages": inbox.data?.messages,
    "inbox.tasks": inbox.data?.tasks,
    "inbox.documents": inbox.data?.documents,
  };
  return (
    <Page>
      <PageHeader title="Inbox" />
      <div className="grid grid-cols-[200px_340px_minmax(0,1fr)] items-start gap-6">
        <nav aria-label="Inbox folders" className="grid gap-0.5">
          {foldersFor(me.role).map((f) => {
            const n = counts[f.id] ?? fromServer[f.id];
            return (
              <NavLink
                key={f.id}
                to={pathTo(f.id)}
                className={({ isActive }) =>
                  cn(
                    "flex h-row-compact items-center justify-between px-3 text-body",
                    isActive
                      ? "bg-pine-50 font-semibold text-pine-700"
                      : "text-ink-2 hover:bg-surface-hover",
                  )
                }
              >
                {f.label}
                {n ? <span className="tabular-nums">{n}</span> : null}
              </NavLink>
            );
          })}
        </nav>
        {children}
      </div>
    </Page>
  );
}
