import { screens, type ScreenId } from "@agile-emr/shared";

/**
 * Routes come from spec/ui (screen catalog), never hard-coded per screen. `pathTo("chart.summary", {patientId})`.
 * Views open on top of their screen and are linkable with ?view=<name> (NAV-03).
 */
export function routeOf(id: ScreenId): string {
  const r = screens[id].route;
  if (!r) throw new Error(`${id} has no route`);
  return r;
}

export function pathTo(
  id: ScreenId,
  params: Record<string, string> = {},
  view?: string,
  query: Record<string, string | undefined> = {},
): string {
  const path = routeOf(id).replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k];
    if (!v) throw new Error(`${id}: missing ${k}`);
    return encodeURIComponent(v);
  });
  const q = new URLSearchParams();
  if (view) q.set("view", view);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Target of a `go` with by_role (nav.yaml). */
export const homeByRole: Record<string, ScreenId> = {
  frontdesk: "home.frontdesk-board",
  ma: "home.clinical-daylist",
  provider: "home.provider-worklist",
  biller: "home.rcm-queues",
  manager: "home.practice-kpis",
};

export const inboxByRole: Record<string, ScreenId> = {
  frontdesk: "inbox.previsit-queue",
  ma: "inbox.patient-messages",
  provider: "inbox.results",
  biller: "inbox.tasks",
  manager: "inbox.tasks",
};

/** data-testid for a spec/ui element: "<screen>/<element>" (docs/ehr-spec/CLAUDE.md). */
export const tid = (screen: ScreenId | string, element: string) => `${screen}/${element}`;
