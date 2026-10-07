import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import type { ScreenId } from "@agile-emr/shared";
import { ApiError } from "@/lib/api/client";
import { TooltipProvider } from "@/components/ui/menu";
import { AppShell } from "@/shell/AppShell";
import { StepUpProvider } from "@/shell/StepUp";
import { AuthProvider, useAuth } from "./auth";
import { RequireStaff, ScreenGate } from "./guards";
import { builtScreens, isBuilt } from "./registry";
import { pathTo, routeOf } from "./routes";
import { publicScreens, staffScreens } from "./screens";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

for (const id of [...Object.keys(publicScreens), ...Object.keys(staffScreens)])
  builtScreens.add(id as ScreenId);

/** Root: staff app under the shell, public auth screens outside it. Routes come from spec/ui. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <AuthProvider>
            <StepUpProvider>
              <Routes>
                {Object.entries(publicScreens).map(([id, Component]) => (
                  <Route key={id} path={routeOf(id as ScreenId)} element={<Component />} />
                ))}
                <Route
                  element={
                    <RequireStaff>
                      <AppShell />
                    </RequireStaff>
                  }
                >
                  <Route index element={<HomeRedirect />} />
                  {Object.entries(staffScreens).map(([id, Component]) => (
                    <Route
                      key={id}
                      path={routeOf(id as ScreenId)}
                      element={
                        <ScreenGate id={id as ScreenId}>
                          <Component />
                        </ScreenGate>
                      }
                    />
                  ))}
                  <Route path="*" element={<HomeRedirect />} />
                </Route>
              </Routes>
            </StepUpProvider>
          </AuthProvider>
        </BrowserRouter>
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: "!rounded-none !shadow-overlay !border-0 !bg-surface !text-ink !text-body",
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** Role home (nav.yaml rail-home), or the first built screen while a home is still being built. */
function HomeRedirect() {
  const { me } = useAuth();
  const home = me?.homeScreen as ScreenId | undefined;
  const target: ScreenId = home && isBuilt(home) ? home : "patients.search";
  return <Navigate to={pathTo(target)} replace />;
}

export type ScreenComponent = React.ComponentType;
