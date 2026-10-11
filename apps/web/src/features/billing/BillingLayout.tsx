import * as React from "react";
import type { ScreenId } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { Page, PageHeader } from "@/components/ui/layout";
import { RouteTabs } from "@/components/ui/tabs";
import { type NavEntry, visible } from "@/shell/patterns";

/**
 * Pattern billing-page: nav.yaml#billing-nav above a worklist or detail. Tabs show only built screens the role may
 * open (NAV-09). billing.patient-account needs a patient, so it is reached from claims, statements and ERA rows.
 */
const BILLING_NAV: NavEntry[] = [
  { id: "bnav-eligibility", label: "Eligibility", screen: "billing.eligibility" },
  { id: "bnav-estimates", label: "Estimates", screen: "billing.estimates" },
  { id: "bnav-payments", label: "Payments", screen: "billing.payment-capture" },
  { id: "bnav-charge-review", label: "Charge review", screen: "billing.charge-review" },
  { id: "bnav-claims", label: "Claims", screen: "billing.claims" },
  { id: "bnav-rejections", label: "Rejections", screen: "billing.rejections" },
  { id: "bnav-era", label: "ERA posting", screen: "billing.era-posting" },
  { id: "bnav-denials", label: "Denials", screen: "billing.denials" },
  { id: "bnav-statements", label: "Statements", screen: "billing.statements" },
  { id: "bnav-day-close", label: "Day close", screen: "billing.day-close" },
];

const MONEY_ROLES = ["biller", "manager"];

/** Worklist counts on the tabs (bind: count). Fetched only for roles that can open those lists. */
function useBillingCounts(): Partial<Record<ScreenId, number>> {
  const { role } = useAuth();
  const enabled = MONEY_ROLES.includes(role ?? "");
  const opts = { enabled, refetchInterval: 60_000 };
  const held = useApi("listHeldCharges", { query: {} }, opts);
  const rejections = useApi("listRejections", { query: {} }, opts);
  const era = useApi("listRemittances", { query: { status: ["EXCEPTION"] } }, opts);
  const denials = useApi("listDenials", { query: {} }, opts);
  return {
    "billing.charge-review": held.data?.data.length,
    "billing.rejections": rejections.data?.data.length,
    "billing.era-posting": era.data?.data.length,
    "billing.denials": denials.data?.data.length,
  };
}

export function BillingLayout({
  title,
  subtitle,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { role } = useAuth();
  const counts = useBillingCounts();
  const entries = visible(BILLING_NAV, role);
  return (
    <div className="grid min-w-0 content-start">
      {entries.length > 1 ? (
        <div className="border-b border-line bg-surface px-8 pt-3">
          <RouteTabs
            items={entries.map((e) => ({
              to: pathTo(e.screen),
              label: e.label,
              count: counts[e.screen],
              testId: e.id,
            }))}
          />
        </div>
      ) : null}
      <Page>
        <div className="grid gap-1">
          <PageHeader title={title} actions={actions} />
          {subtitle ? <p className="text-body text-ink-2">{subtitle}</p> : null}
        </div>
        {children}
      </Page>
    </div>
  );
}
