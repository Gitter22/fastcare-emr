import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import type { LoginResult, ScreenId } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, tokenStore } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { TextField, useZodForm } from "@/components/ui/form";
import { Alert } from "@/components/ui/layout";
import { PublicCard } from "@/shell/PublicCard";

const S = "auth.sign-in";
const schema = z.object({
  email: z.string().trim().email("Enter your work email."),
  password: z.string().min(1, "Enter your password."),
});

export interface SignInState {
  login: LoginResult;
  next: string | null;
}

/** auth.sign-in: email + password, then MFA (INV-SEC-04). Errors never say which field was wrong. */
export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const form = useZodForm(schema, { defaultValues: { email: "", password: "" } });
  const [error, setError] = React.useState<string | null>(null);
  const expired = params.get("expired") === "1";

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const login = await api("login", { body: v });
      const state: SignInState = { login, next: params.get("next") };
      if (login.next === "enroll") {
        tokenStore.set("enrollment", login.enrollmentToken ?? null);
        navigate(pathTo("auth.mfa-enroll"), { state });
      } else navigate(pathTo("auth.mfa-challenge"), { state });
    } catch (e) {
      if (e instanceof ApiError && e.code === "account_locked")
        setError(
          "Your account is locked after too many attempts. Try again in 15 minutes or ask your practice manager.",
        );
      else if (e instanceof ApiError && e.status === 401)
        setError("Email or password is incorrect.");
      else setError("We couldn't sign you in. Try again.");
    }
  });

  return (
    <PublicCard
      title="Sign in"
      footer={
        <p className="text-body text-ink-2">
          <Link
            to={pathTo("portal.sign-in")}
            className="underline underline-offset-4 hover:text-ink"
            data-testid={tid(S, "patient-link")}
          >
            Patient? Sign in to the portal
          </Link>
        </p>
      }
    >
      {expired ? (
        <Alert testId={tid(S, "session-expired")}>
          You were signed out after inactivity. Your drafts were saved.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="caution" testId={tid(S, "error")}>
          {error}
        </Alert>
      ) : null}
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <TextField
          form={form}
          name="email"
          label="Work email"
          type="email"
          autoComplete="username"
          testId={tid(S, "email")}
        />
        <TextField
          form={form}
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          testId={tid(S, "password")}
        />
        <Button
          type="submit"
          variant="primary"
          loading={form.formState.isSubmitting}
          data-testid={tid(S, "sign-in")}
        >
          Sign in
        </Button>
      </form>
      <Link
        to={pathTo("auth.forgot-password")}
        className="text-body text-ink underline underline-offset-4 hover:text-pine-700"
        data-testid={tid(S, "forgot")}
      >
        Forgot password?
      </Link>
    </PublicCard>
  );
}

/** Where to land after sign-in: the saved route (NAV-10), else the role home. */
export function useLandAfterSignIn() {
  const navigate = useNavigate();
  const auth = useAuth();
  return async (accessToken: string, next: string | null) => {
    const me = await auth.signedIn(accessToken);
    navigate(
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : pathTo(me.homeScreen as ScreenId),
      { replace: true },
    );
  };
}
