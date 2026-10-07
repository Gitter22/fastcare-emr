import * as React from "react";
import { setApiHooks, api, ApiError, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import { tid } from "@/app/routes";

/**
 * auth.step-up (blocking-modal): re-authenticate before signing, controlled-substance prescribing, exports and
 * security changes. The API client calls it on 403 step_up_required and retries the original request.
 */
type Pending = { purpose: string; resolve: (ok: boolean) => void };

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [codeSent, setCodeSent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setApiHooks({
      onStepUpRequired: (purpose) =>
        new Promise<boolean>((resolve) => {
          setPassword("");
          setCode("");
          setError(null);
          setCodeSent(null);
          setPending({ purpose, resolve });
        }),
    });
  }, []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("stepUp", {
        body: {
          password,
          code: code || undefined,
          purpose: pending?.purpose ?? "sensitive action",
        },
      });
      close(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_code_sent")
        setCodeSent(err.problem.detail ?? "We sent you a code.");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Dialog open={!!pending} onOpenChange={(o) => (!o ? close(false) : undefined)}>
        <DialogContent blocking data-testid="auth.step-up">
          <form onSubmit={confirm} className="grid gap-4">
            <DialogHeader>
              <DialogTitle data-testid={tid("auth.step-up", "reason")}>
                Confirm it's you
              </DialogTitle>
              <DialogDescription>
                Re-enter your password and a code to continue: {pending?.purpose.toLowerCase()}.
              </DialogDescription>
            </DialogHeader>
            {error ? <Alert tone="caution">{error}</Alert> : null}
            {codeSent ? <Alert>{codeSent}</Alert> : null}
            <div className="grid gap-1.5">
              <Label htmlFor="su-password">Password</Label>
              <Input
                id="su-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid={tid("auth.step-up", "password")}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="su-code">Verification code</Label>
              <Input
                id="su-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="tabular-nums"
                data-testid={tid("auth.step-up", "code")}
              />
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => close(false)}
                data-testid={tid("auth.step-up", "cancel")}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!password}
                data-testid={tid("auth.step-up", "confirm")}
              >
                Confirm
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
