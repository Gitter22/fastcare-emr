import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Me, OperationId } from "@agile-emr/shared";
import { api, tokenStore, tryRestoreSession } from "@/lib/api/client";
import { setPracticeTimeZone } from "@/lib/format";

/**
 * Staff session: the access token is in memory (lib/api/client); the refresh cookie restores it after reload.
 * `can(operationId)` is the capability check: the server sends only operations the active role may call and that
 * are implemented, so the UI hides anything else (NAV-09: hidden, not disabled).
 */
interface AuthState {
  status: "loading" | "signed-out" | "signed-in";
  me: Me | null;
  role: string | null;
  can: (op: OperationId) => boolean;
  refreshMe: () => Promise<void>;
  signedIn: (accessToken: string) => Promise<Me>;
  signOut: () => Promise<void>;
  setMe: (me: Me) => void;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [me, setMeState] = React.useState<Me | null>(null);
  const [status, setStatus] = React.useState<AuthState["status"]>("loading");

  const setMe = React.useCallback((m: Me) => {
    setPracticeTimeZone(m.practice.timezone);
    setMeState(m);
    setStatus("signed-in");
  }, []);

  const refreshMe = React.useCallback(async () => {
    setMe(await api("getMe"));
  }, [setMe]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (await tryRestoreSession("staff")) {
        try {
          const m = await api("getMe");
          if (!cancelled) setMe(m);
          return;
        } catch {
          /* fall through */
        }
      }
      if (!cancelled) setStatus("signed-out");
    })();
    return () => {
      cancelled = true;
    };
  }, [setMe]);

  const value = React.useMemo<AuthState>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      status,
      me,
      role: me ? me.activeRole.toLowerCase() : null,
      can: (op) => perms.has(op),
      refreshMe,
      setMe,
      async signedIn(accessToken) {
        tokenStore.set("staff", accessToken);
        tokenStore.set("enrollment", null);
        const m = await api("getMe");
        qc.clear();
        setMe(m);
        return m;
      },
      async signOut() {
        try {
          await api("logout");
        } catch {
          /* already ended */
        }
        tokenStore.set("staff", null);
        qc.clear();
        setMeState(null);
        setStatus("signed-out");
      },
    };
  }, [me, status, refreshMe, setMe, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The signed-in staff user (screens under the app shell only). */
export function useMe(): Me & { role: string } {
  const { me } = useAuth();
  if (!me) throw new Error("useMe without a session");
  return { ...me, role: me.activeRole.toLowerCase() };
}
