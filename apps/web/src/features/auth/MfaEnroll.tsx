import * as React from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { MfaEnrollmentChallenge } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, errorMessage, tokenStore } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Alert } from "@/components/ui/layout";
import { Checkbox, RadioGroup } from "@/components/ui/select";
import { PublicCard } from "@/shell/PublicCard";
import { useLandAfterSignIn, type SignInState } from "./SignIn";

const S = "auth.mfa-enroll";
type Method = "TOTP" | "SMS";

/**
 * auth.mfa-enroll: first sign-in sets up a second factor before any session exists (INV-SEC-04). Recovery codes are
 * shown once. Security keys are hidden until WebAuthn is built (OPEN-Q16).
 */
export function MfaEnrollPage() {
  const state = useLocation().state as SignInState | null;
  const land = useLandAfterSignIn();
  const [method, setMethod] = React.useState<Method>("TOTP");
  const [phone, setPhone] = React.useState("");
  const [challenge, setChallenge] = React.useState<MfaEnrollmentChallenge | null>(null);
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [accessToken, setAccessToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!tokenStore.get("enrollment")) return <Navigate to={pathTo("auth.sign-in")} replace />;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const e164 =
        method === "SMS" ? `+1${phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")}` : undefined;
      setChallenge(
        await api("startMfaEnrollment", {
          body: { type: method, ...(e164 ? { phone: e164 } : {}) },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api("confirmMfaEnrollment", {
        params: { factorId: challenge.factorId },
        body: { code },
      });
      setCodes(r.recoveryCodes ?? []);
      setAccessToken(r.session?.accessToken ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!accessToken) return;
    setBusy(true);
    await land(accessToken, state?.next ?? null);
  };

  return (
    <PublicCard title="Set up two-step sign-in">
      {error ? <Alert tone="caution">{error}</Alert> : null}
      {!challenge ? (
        <div className="grid gap-4">
          <p className="text-body text-ink">
            Every staff account needs a second step at sign-in. Choose how you'll get codes.
          </p>
          <RadioGroup<Method>
            orientation="vertical"
            testId={tid(S, "method")}
            aria-label="Method"
            value={method}
            onValueChange={setMethod}
            options={[
              { value: "TOTP", label: "Authenticator app (recommended)" },
              { value: "SMS", label: "Text message" },
            ]}
          />
          {method === "SMS" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="enroll-phone">Mobile number</Label>
              <Input
                id="enroll-phone"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid={tid(S, "sms-phone")}
              />
            </div>
          ) : null}
          <Button
            variant="primary"
            onClick={start}
            loading={busy}
            disabled={method === "SMS" && phone.replace(/\D/g, "").length < 10}
          >
            Continue
          </Button>
        </div>
      ) : !codes ? (
        <form onSubmit={confirm} className="grid gap-4">
          {challenge.type === "TOTP" ? (
            <>
              <p className="text-body text-ink">
                Scan this code with your authenticator app, then enter the 6-digit code it shows.
              </p>
              {challenge.qrCodeDataUrl ? (
                <img
                  src={challenge.qrCodeDataUrl}
                  alt="QR code for your authenticator app"
                  className="size-48"
                  data-testid={tid(S, "totp-qr")}
                />
              ) : null}
              <p className="text-small text-ink-2">
                Can't scan? Enter this key:{" "}
                <span className="select-all break-all font-semibold tabular-nums text-ink">
                  {challenge.secretBase32}
                </span>
              </p>
            </>
          ) : (
            <p className="text-body text-ink">We sent a code to {challenge.codeSentTo}.</p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="enroll-code">Enter the 6-digit code</Label>
            <Input
              id="enroll-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="tabular-nums"
              data-testid={tid(S, "totp-confirm")}
              autoFocus
            />
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>
            Verify code
          </Button>
        </form>
      ) : (
        <div className="grid gap-4">
          <p className="text-body text-ink">
            Save these recovery codes somewhere safe. Each one signs you in once if you lose your
            phone. They won't be shown again.
          </p>
          <ul
            className="grid grid-cols-2 gap-2 bg-surface-muted p-4 text-body font-semibold tabular-nums"
            data-testid={tid(S, "recovery-codes")}
          >
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Checkbox
            checked={saved}
            onCheckedChange={(c) => setSaved(c === true)}
            label="I saved my recovery codes"
            data-testid={tid(S, "recovery-saved")}
          />
          <Button
            variant="primary"
            onClick={finish}
            loading={busy}
            disabled={!saved}
            data-testid={tid(S, "finish")}
          >
            Finish setup
          </Button>
        </div>
      )}
    </PublicCard>
  );
}
