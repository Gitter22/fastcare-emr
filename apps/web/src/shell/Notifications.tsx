import { useNavigate } from "react-router-dom";
import { OctagonAlert } from "lucide-react";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingRows } from "@/components/ui/layout";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** global.notifications (drawer): critical results, escalations, interface alerts. Titles carry no PHI. */
export function NotificationsTray({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const list = useApi("listNotifications", { query: { limit: 50 } }, { enabled: open });
  const markRead = useApiMutation("markNotificationsRead", { invalidates: ["listNotifications"] });
  const items = list.data?.data ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="w-[420px]" data-testid="global.notifications">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-1">
          {items.some((n) => !n.readAt) ? (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => markRead.mutate({ body: { all: true } })}
            >
              Mark all read
            </Button>
          ) : null}
          {list.isLoading ? <LoadingRows /> : null}
          {!list.isLoading && !items.length ? <EmptyState title="Nothing new" /> : null}
          {items.map((n) => {
            const critical = n.type === "CRITICAL_RESULT" || n.type === "TASK_ESCALATED";
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  markRead.mutate({ body: { ids: [n.id] } });
                  onOpenChange(false);
                  navigate(n.linkRoute);
                }}
                className={cn(
                  "grid gap-1 px-3 py-3 text-left hover:bg-surface-hover",
                  !n.readAt && "bg-surface-muted",
                )}
              >
                <span
                  className={cn(
                    "flex items-center gap-2 text-body",
                    !n.readAt && "font-semibold",
                    critical && "text-danger-ink",
                  )}
                >
                  {critical ? (
                    <OctagonAlert size={16} strokeWidth={1.75} aria-label="Critical" />
                  ) : null}
                  {n.title}
                </span>
                <span className="text-small text-ink-2">{relativeTime(n.createdAt)}</span>
              </button>
            );
          })}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
