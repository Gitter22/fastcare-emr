import * as React from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import type { MfaFactorInfo } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { PublicCard } from "@/shell/PublicCard";
import { useLandAfterSignIn, type SignInState } from "./SignIn";

const S = "auth.mfa-challenge";

const prompt = (f: MfaFactorInfo | undefined) =>
  !f
    ? "Enter your code"
    : f.type === "TOTP"
      ? "Enter the code from your authenticator app"
      : f.type === "SMS"
        ? `Enter the code we texted to ${f.maskedTarget ?? "your phone"}`
        : f.type === "EMAIL"
          ? `Enter the code we emailed to ${f.maskedTarget ?? "you"}`
          : "Verify it's you";

/** auth.mfa-challenge: TOTP, SMS/email code or recovery code (INV-SEC-04). */
export function MfaChallengePage() {
  const state = useLocation().state as SignInState | null;
  const land = useLandAfterSignIn();
  const [factorId, setFactorId] = React.useState(state?.login.defaultFactorId);
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!state?.login.challengeId) return <Navigate to={pathTo("auth.sign-in")} replace />;
  const factors = state.login.factors ?? [];
  const factor = factors.find((f) => f.id === factorId);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tokens = await api("verifyMfa", {
        body: recovery
          ? { challengeId: state.login.challengeId!, recoveryCode: code }
          : { challengeId: state.login.challengeId!, factorId, code },
      });
      await land(tokens.accessToken, state.next);
    } catch (err) {
      if (err instanceof ApiError && err.code === "too_many_attempts")
        setError("Too many wrong codes. Sign in again.");
      else if (err instanceof ApiError && err.code === "challenge_expired")
        setError("This sign-in expired. Sign in again.");
      else if (err instanceof ApiError && err.status === 401)
        setError("That code didn't work. Check it and try again.");
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  const resend = async (id = factorId) => {
    setError(null);
    try {
      await api("resendMfaCode", { body: { challengeId: state.login.challengeId!, factorId: id } });
      setNotice("We sent a new code.");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <PublicCard title="Verify it's you">
      <p className="text-body-lg text-ink" data-testid={tid(S, "factor-prompt")}>
        {recovery ? "Enter one of your recovery codes" : prompt(factor)}
      </p>
      {error ? <Alert tone="caution">{error}</Alert> : null}
      {notice ? <Alert>{notice}</Alert> : null}
      <form onSubmit={verify} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="mfa-code">{recovery ? "Recovery code" : "6-digit code"}</Label>
          <Input
            id="mfa-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={recovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            className="tabular-nums"
            data-testid={tid(S, "code")}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!code.trim()}
          data-testid={tid(S, "verify")}
        >
          Verify
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {factor && factor.type !== "TOTP" && !recovery ? (
          <Button variant="link" onClick={() => void resend()} data-testid={tid(S, "resend")}>
            Send a new code
          </Button>
        ) : null}
        {factors.length > 1 && !recovery ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="link" data-testid={tid(S, "other-method")}>
                Use another method
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {factors.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() => {
                    setFactorId(f.id);
                    setCode("");
                    if (f.type !== "TOTP") void resend(f.id);
                  }}
                >
                  {f.label}
                  {f.maskedTarget ? ` · ${f.maskedTarget}` : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant="link"
          onClick={() => (setRecovery((r) => !r), setCode(""))}
          data-testid={tid(S, "recovery")}
        >
          {recovery ? "Use a code instead" : "Use a recovery code"}
        </Button>
        <Link
          to={pathTo("auth.sign-in")}
          className="text-body text-ink underline underline-offset-4"
          data-testid={tid(S, "back-to-sign-in")}
        >
          Back
        </Link>
      </div>
    </PublicCard>
  );
}
