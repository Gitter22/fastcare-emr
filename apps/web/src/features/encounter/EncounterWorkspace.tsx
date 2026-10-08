import * as React from "react";
import { NavLink, useParams } from "react-router-dom";
import type { EncounterDetail, ScreenId } from "@agile-emr/shared";
import { screens } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { ApiError } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { formatDate, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingRows, PermissionDenied } from "@/components/ui/layout";
import { StatusChip } from "@/components/domain/StatusChip";

/**
 * pattern encounter-workspace: one visit. Chart nav collapses; encounter header and section tabs across the top;
 * each section renders its own body with a context drawer on the right and a sticky action bar.
 */
interface EncounterCtx {
  patientId: string;
  encounterId: string;
  encounter: EncounterDetail;
  /** Last successful autosave (INV-SEC-04: drafts survive). */
  autosavedAt: Date | null;
  setAutosavedAt: (d: Date | null) => void;
}
const Ctx = React.createContext<EncounterCtx | null>(null);

export function useEncounter(): EncounterCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useEncounter outside EncounterWorkspace");
  return c;
}

const TABS: Array<{ id: string; label: string; screen: ScreenId }> = [
  { id: "tab-prechart", label: "Pre-chart", screen: "encounter.prechart" },
  { id: "tab-rooming", label: "Rooming", screen: "encounter.rooming" },
  { id: "tab-note", label: "Note", screen: "encounter.note" },
  { id: "tab-orders", label: "Orders", screen: "encounter.orders" },
  { id: "tab-rx", label: "Rx", screen: "encounter.rx" },
  { id: "tab-dx", label: "Dx & coding", screen: "encounter.dx-coding" },
  { id: "tab-charges", label: "Charges", screen: "encounter.charges" },
  { id: "tab-avs", label: "AVS", screen: "encounter.avs" },
  { id: "tab-sign", label: "Sign", screen: "encounter.sign" },
];
const S = "encounter.note";

export function EncounterWorkspace({ children }: { children: React.ReactNode }) {
  const { patientId = "", encounterId = "" } = useParams();
  const { role } = useAuth();
  const enc = useApi("getEncounter", { params: { encounterId } }, { refetchInterval: 60_000 });
  const [autosavedAt, setAutosavedAt] = React.useState<Date | null>(null);
  if (enc.error instanceof ApiError && enc.error.status === 403) return <PermissionDenied />;
  if (enc.error) return <ErrorState onRetry={() => void enc.refetch()} />;
  if (!enc.data)
    return (
      <div className="p-8">
        <LoadingRows rows={6} />
      </div>
    );
  const e = enc.data;
  // INV-ID-03 in the UI: the encounter must belong to the chart it is opened in.
  if (e.patient.id !== patientId)
    return (
      <ErrorState message="This encounter belongs to a different patient. Open it from that patient's chart." />
    );
  const a = e.appointment;
  const tabs = TABS.filter(
    (t) =>
      isBuilt(t.screen) &&
      (screens[t.screen].accessRoles as readonly string[]).includes(role ?? ""),
  );
  return (
    <Ctx.Provider value={{ patientId, encounterId, encounter: e, autosavedAt, setAutosavedAt }}>
      <div className="flex min-h-full flex-col">
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-6 pb-1 pt-4"
          data-testid={tid(S, "encounter-header")}
        >
          <h2 className="text-h3" data-testid={tid(S, "enc-visit-type")}>
            {a
              ? `${a.visitType.name} visit`
              : e.class === "PHONE"
                ? "Phone encounter"
                : e.class === "VR"
                  ? "Video visit"
                  : e.class === "ASYNC"
                    ? "Portal encounter"
                    : "Office visit"}
          </h2>
          <span className="text-body text-ink-2" data-testid={tid(S, "enc-meta")}>
            {[
              a?.practitioner.name,
              a?.location.name,
              a?.room?.name,
              formatDate(e.periodStart ?? a?.start ?? e.createdAt),
              a ? formatTime(a.start) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {a ? (
            <span className="flex items-center gap-1 text-small text-ink-2">
              Appt{" "}
              <StatusChip
                machine="appointment"
                value={a.status}
                testId={tid(S, "enc-appt-status")}
              />
            </span>
          ) : null}
          {e.note ? (
            <span className="flex items-center gap-1 text-small text-ink-2">
              Note{" "}
              <StatusChip machine="note" value={e.note.status} testId={tid(S, "enc-note-status")} />
            </span>
          ) : null}
          <span
            className="ml-auto text-small text-ink-2"
            data-testid={tid(S, "enc-autosave")}
            aria-live="polite"
          >
            {autosavedAt ? `Autosaved ${formatTime(autosavedAt.toISOString())}` : ""}
          </span>
        </div>
        <nav className="flex gap-1 bg-surface px-4" aria-label="Encounter sections">
          {tabs.map((t) => (
            <NavLink
              key={t.id}
              to={pathTo(t.screen, { patientId, encounterId })}
              data-testid={tid(S, t.id)}
              className={({ isActive }) =>
                cn(
                  "flex h-12 items-center px-4 text-body text-ink-2 transition-colors duration-fast hover:text-ink",
                  isActive && "font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]",
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Section body: main column, optional context drawer, sticky action bar under the main column. */
export function EncounterBody({
  children,
  drawer,
  actionBar,
}: {
  children: React.ReactNode;
  drawer?: React.ReactNode;
  actionBar?: React.ReactNode;
}) {
  return (
    <div className={cn("grid flex-1", drawer ? "grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-1")}>
      <div className="flex min-w-0 flex-col">
        <div className="grid flex-1 content-start gap-6 bg-canvas p-6">{children}</div>
        {actionBar ? (
          <div
            className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 bg-surface px-6 py-3 shadow-sticky"
            data-testid="action-bar"
          >
            {actionBar}
          </div>
        ) : null}
      </div>
      {drawer ? (
        <aside className="bg-surface" aria-label="Context">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto p-5">{drawer}</div>
        </aside>
      ) : null}
    </div>
  );
}
