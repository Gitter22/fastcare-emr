import * as React from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { OctagonAlert, ShieldAlert, X } from "lucide-react";
import type { ScreenId } from "@agile-emr/shared";
import { screens } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { ApiError } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { formatDate, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingRows, Page, PermissionDenied } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { useCharts } from "./charts";

/**
 * pattern chart-context (ADR-001): chart tabs, the pinned identity banner (INV-ID-01: full name, DOB and MRN
 * never scroll away or truncate) and chart navigation. Every /patient/:patientId route renders inside it.
 */
const NAV: Array<{
  group?: string;
  items: Array<{ id: string; label: string; screen: ScreenId }>;
}> = [
  {
    items: [
      { id: "nav-summary", label: "Summary", screen: "chart.summary" },
      { id: "nav-timeline", label: "Timeline", screen: "chart.timeline" },
    ],
  },
  {
    group: "Clinical",
    items: [
      { id: "nav-problems", label: "Problems", screen: "chart.problems" },
      { id: "nav-medications", label: "Medications", screen: "chart.medications" },
      { id: "nav-allergies", label: "Allergies", screen: "chart.allergies" },
      { id: "nav-vitals", label: "Vitals", screen: "chart.vitals" },
      { id: "nav-results", label: "Results", screen: "chart.results" },
      { id: "nav-immunizations", label: "Immunizations", screen: "chart.immunizations" },
      { id: "nav-history", label: "History", screen: "chart.history" },
    ],
  },
  {
    group: "Care",
    items: [
      { id: "nav-orders", label: "Orders", screen: "chart.orders" },
      { id: "nav-referrals", label: "Referrals", screen: "chart.referrals" },
      { id: "nav-care-plan", label: "Care plan", screen: "chart.care-plan" },
      { id: "nav-care-gaps", label: "Care gaps", screen: "chart.care-gaps" },
    ],
  },
  {
    group: "Records",
    items: [
      { id: "nav-documents", label: "Documents", screen: "chart.documents" },
      { id: "nav-communications", label: "Communications", screen: "chart.communications" },
      { id: "nav-demographics", label: "Demographics", screen: "chart.demographics" },
      { id: "nav-consents", label: "Consents", screen: "chart.consents" },
      { id: "nav-account", label: "Account", screen: "chart.account" },
      { id: "nav-access-log", label: "Access log", screen: "chart.access-log" },
    ],
  },
];

export function ChartLayout({
  children,
  compactNav = false,
  patientId: forPatient,
}: {
  children: React.ReactNode;
  compactNav?: boolean;
  /** For chart-context screens whose route has no :patientId (schedule.checkout). */
  patientId?: string;
}) {
  const params = useParams();
  const patientId = forPatient ?? params.patientId ?? "";
  const { role, me } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const banner = useApi("getPatientBanner", { params: { patientId } });
  // Nav counts reuse the summary query (same cache entry as the Summary screen).
  const canSummary =
    isBuilt("chart.summary") &&
    (screens["chart.summary"].accessRoles as readonly string[]).includes(role ?? "");
  const summary = useApi(
    "getPatientSummary",
    { params: { patientId } },
    { enabled: canSummary && !compactNav },
  );
  const navCount = (screen: ScreenId): { text: string; isNew?: boolean } | null => {
    const s = summary.data;
    if (!s) return null;
    const n = (count: number, staged: number) =>
      staged ? { text: `${staged} new`, isNew: true } : count ? { text: String(count) } : null;
    if (screen === "chart.problems") return n(s.problems.length, s.staged.problems);
    if (screen === "chart.medications") return n(s.medications.length, s.staged.medications);
    if (screen === "chart.allergies") return n(s.allergies.length, s.staged.allergies);
    return null;
  };
  const { charts, open, close, rememberPath, relabel, setMax } = useCharts();

  React.useEffect(() => {
    // OPEN-Q9: max open charts from practice setting chart.maxOpenCharts (default 3).
    setMax(3);
  }, [setMax, me]);
  React.useEffect(() => {
    if (banner.data) {
      open({
        patientId,
        label: banner.data.name.split(" ").slice(0, 2).join(" ").replace(/,$/, ""),
      });
      relabel(patientId, banner.data.name.replace(/ [A-Z]$/, ""));
    }
  }, [banner.data, patientId, open, relabel]);
  React.useEffect(() => rememberPath(patientId, pathname), [patientId, pathname, rememberPath]);

  if (banner.error instanceof ApiError && banner.error.code === "merged") {
    const survivor = banner.error.problem.survivorId as string;
    return (
      <Page>
        <ErrorState message="This record was merged into another chart." />
        <Button
          className="justify-self-center"
          onClick={() =>
            navigate(
              pathTo(isBuilt("chart.summary") ? "chart.summary" : "chart.demographics", {
                patientId: survivor,
              }),
            )
          }
        >
          Open the kept record
        </Button>
      </Page>
    );
  }
  if (banner.error instanceof ApiError && banner.error.status === 404)
    return (
      <Page>
        <ErrorState message="This patient record doesn't exist or you can't see it." />
      </Page>
    );
  if (banner.error instanceof ApiError && banner.error.status === 403)
    return (
      <Page>
        <PermissionDenied />
      </Page>
    );

  const visibleNav = NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        isBuilt(i.screen) &&
        (screens[i.screen].accessRoles as readonly string[]).includes(role ?? "") &&
        (i.screen !== "chart.access-log" || role === "manager"),
    ),
  })).filter((g) => g.items.length);
  const b = banner.data;
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <div
        className="flex items-end gap-1 bg-canvas px-6 pt-3"
        role="tablist"
        aria-label="Open charts"
      >
        {charts.map((c) => {
          const active = c.patientId === patientId;
          return (
            <div
              key={c.patientId}
              className={cn(
                "flex h-10 items-center gap-2 pl-4 pr-1",
                active
                  ? "bg-surface font-semibold"
                  : "bg-surface-muted text-ink-2 hover:bg-surface-hover",
              )}
              data-testid="chart-tab"
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() =>
                  navigate(
                    c.lastPath ??
                      pathTo(isBuilt("chart.summary") ? "chart.summary" : "chart.demographics", {
                        patientId: c.patientId,
                      }),
                  )
                }
                className="text-body"
              >
                {c.label}
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Close chart ${c.label}`}
                data-testid="chart-tab-close"
                onClick={() => navigate(close(c.patientId) ?? "/")}
              >
                <X size={16} strokeWidth={1.75} />
              </Button>
            </div>
          );
        })}
      </div>
      <header
        className="sticky top-16 z-20 flex flex-wrap items-center gap-x-8 gap-y-3 bg-surface px-6 py-4 shadow-sticky"
        data-testid="patient-banner"
      >
        {b ? (
          <>
            <div className="flex min-w-0 items-center gap-4">
              <span
                className="grid size-12 shrink-0 place-items-center rounded-full bg-surface-muted text-body font-semibold"
                data-testid="banner-photo"
                aria-hidden
              >
                {b.name.split(",")[0]?.[0]}
                {b.name.split(",")[1]?.trim()[0]}
              </span>
              <div className="grid gap-0.5">
                <h1 className="text-h2 text-ink" data-testid="banner-name">
                  {b.name}
                  {b.preferredName ? (
                    <span className="font-normal text-ink-2"> "{b.preferredName}"</span>
                  ) : null}
                  {b.pronouns ? (
                    <span className="text-body font-normal text-ink-2"> · {b.pronouns}</span>
                  ) : null}
                </h1>
                <p className="whitespace-nowrap text-small tabular-nums text-ink-2">
                  <span data-testid="banner-dob">
                    DOB <b className="font-semibold text-ink">{formatDate(b.birthDate)}</b> ·{" "}
                    {b.age} ·{" "}
                    {b.sexForClinicalUse
                      ? b.sexForClinicalUse[0] + b.sexForClinicalUse.slice(1).toLowerCase()
                      : "Sex not recorded"}
                  </span>{" "}
                  ·{" "}
                  <span data-testid="banner-mrn">
                    MRN <b className="font-semibold text-ink">{b.mrn}</b>
                  </span>
                </p>
              </div>
            </div>
            <dl className="flex gap-8 text-small">
              <div data-testid="banner-pcp">
                <dt className="text-ink-2">PCP</dt>
                <dd className="text-body text-ink">{b.pcp ?? "None"}</dd>
              </div>
              <div data-testid="banner-coverage">
                <dt className="text-ink-2">Coverage</dt>
                <dd className="text-body text-ink">
                  {isBuilt("chart.demographics") ? (
                    <NavLink
                      to={pathTo("chart.demographics", { patientId })}
                      className="hover:underline"
                    >
                      {b.primaryCoverage ?? "Self-pay"}
                    </NavLink>
                  ) : (
                    (b.primaryCoverage ?? "Self-pay")
                  )}
                </dd>
              </div>
              <div data-testid="banner-balance">
                <dt className="text-ink-2">Balance</dt>
                <dd className="text-body tabular-nums text-ink">
                  {isBuilt("chart.account") ? (
                    <NavLink
                      to={pathTo("chart.account", { patientId })}
                      className="hover:underline"
                    >
                      {money(b.balance)}
                    </NavLink>
                  ) : (
                    money(b.balance)
                  )}
                </dd>
              </div>
            </dl>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {b.allergies.map((a) => (
                <Tag key={a.display} tone="critical" data-testid="banner-allergies">
                  <OctagonAlert size={16} strokeWidth={1.75} aria-hidden />
                  Allergy: {a.display}
                </Tag>
              ))}
              {!b.allergies.length ? (
                <Tag
                  tone={b.noKnownAllergies ? "outline" : "caution"}
                  data-testid="banner-allergies"
                >
                  {b.noKnownAllergies ? "No known allergies" : "Allergies not reviewed"}
                </Tag>
              ) : null}
              {b.codeStatus ? (
                <Tag tone="outline" data-testid="banner-code-status">
                  {codeStatusText(b.codeStatus)}
                </Tag>
              ) : null}
              {b.preferredLanguage && b.preferredLanguage !== "en" ? (
                <Tag tone="outline" data-testid="banner-language">
                  {languageName(b.preferredLanguage)}
                  {b.interpreterNeeded ? " · interpreter" : ""}
                </Tag>
              ) : null}
              {b.restricted ? (
                <Tag tone="caution" data-testid="banner-restricted">
                  <ShieldAlert size={16} strokeWidth={1.75} aria-hidden />
                  Restricted
                </Tag>
              ) : null}
            </div>
          </>
        ) : (
          <LoadingRows rows={2} />
        )}
      </header>
      <div
        className={cn(
          "grid flex-1",
          compactNav ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[220px_minmax(0,1fr)]",
        )}
      >
        {!compactNav ? (
          <nav aria-label="Chart" className="grid content-start gap-0.5 bg-surface px-3 py-4">
            {visibleNav.map((g, i) => (
              <div key={i} className="grid gap-0.5">
                {g.group ? (
                  <div className="px-3 pb-1 pt-4 text-caption text-ink-2">{g.group}</div>
                ) : null}
                {g.items.map((it) => (
                  <NavLink
                    key={it.id}
                    to={pathTo(it.screen, { patientId })}
                    data-testid={it.id}
                    className={({ isActive }) =>
                      cn(
                        "flex h-row-compact items-center px-3 text-body text-ink-2 hover:bg-surface-hover hover:text-ink",
                        isActive &&
                          "bg-pine-50 font-semibold text-pine-700 hover:bg-pine-50 hover:text-pine-700",
                      )
                    }
                  >
                    <span className="flex-1">{it.label}</span>
                    <NavCount count={navCount(it.screen)} />
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

function NavCount({ count }: { count: { text: string; isNew?: boolean } | null }) {
  if (!count) return null;
  return count.isNew ? (
    <Tag tone="outline" className="outline-dashed">
      {count.text}
    </Tag>
  ) : (
    <span className="text-caption tabular-nums text-ink-2">{count.text}</span>
  );
}

const codeStatusText = (c: string) =>
  ({ "full-code": "Full code", dnr: "DNR", dni: "DNI", polst: "POLST on file" })[c] ?? c;
const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export { tid };
