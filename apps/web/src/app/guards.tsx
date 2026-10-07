import * as React from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { screens, type ScreenId } from "@agile-emr/shared";
import { setApiHooks } from "@/lib/api/client";
import { PermissionDenied, LoadingRows, Page } from "@/components/ui/layout";
import { useAuth } from "./auth";
import { pathTo } from "./routes";

/** Signed-out users go to sign-in and come back to the same route afterwards (NAV-10, INV-SEC-04). */
export function RequireStaff({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  React.useEffect(() => {
    setApiHooks({
      onSessionEnded: (scheme) => {
        if (scheme !== "staff") return;
        const next = `${window.location.pathname}${window.location.search}`;
        navigate(`${pathTo("auth.sign-in")}?expired=1&next=${encodeURIComponent(next)}`, {
          replace: true,
        });
      },
    });
  }, [navigate]);

  if (auth.status === "loading")
    return (
      <Page>
        <LoadingRows />
      </Page>
    );
  if (auth.status === "signed-out") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`${pathTo("auth.sign-in")}?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Deep links to a screen the role can't use show permission-denied (NAV-09). */
export function ScreenGate({ id, children }: { id: ScreenId; children: React.ReactNode }) {
  const { role } = useAuth();
  const allowed = (screens[id].accessRoles as readonly string[]).includes(role ?? "");
  if (!allowed)
    return (
      <Page>
        <PermissionDenied />
      </Page>
    );
  return <>{children}</>;
}
