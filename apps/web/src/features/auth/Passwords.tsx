import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import type { InvitationInfo, PasswordCheckResult } from "@agile-emr/shared";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, errorMessage, tokenStore } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { TextField, useZodForm, applyServerErrors, CheckboxField } from "@/components/ui/form";
import { Alert, LoadingRows } from "@/components/ui/layout";
import { PublicCard } from "@/shell/PublicCard";
import { Check, X } from "lucide-react";

const FAILURE_TEXT: Record<string, string> = {
  minLength: "At least 12 characters",
  breached: "Not a known breached password",
  containsName: "Doesn't include your name or email",
  reused: "Not a password you used here before",
};

/** Live password policy checks (auth.reset-password/policy). */
function PolicyList({ password, email }: { password: string; email?: string }) {
  const [result, setResult] = React.useState<PasswordCheckResult | null>(null);
  React.useEffect(() => {
    if (!password) return setResult(null);
    const t = setTimeout(() => {
      api("checkPassword", { body: { password, ...(email ? { email } : {}) } })
        .then(setResult)
        .catch(() => setResult(null));
    }, 300);
    return () => clearTimeout(t);
  }, [password, email]);
  const failures = new Set(result?.failures ?? []);
  return (
    <ul className="grid gap-1 text-small" aria-live="polite">
      {(["minLength", "breached", "containsName"] as const).map((k) => {
        const ok = !!result && !failures.has(k);
        return (
          <li
            key={k}
            className={
              ok ? "flex items-center gap-2 text-ink" : "flex items-center gap-2 text-ink-2"
            }
          >
            {ok ? (
              <Check size={16} strokeWidth={1.75} aria-label="Met" />
            ) : (
              <X size={16} strokeWidth={1.75} aria-label="Not met" />
            )}
            {FAILURE_TEXT[k]}
          </li>
        );
      })}
    </ul>
  );
}

const newPasswordSchema = z
  .object({ password: z.string().min(12, "Use at least 12 characters."), confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords don't match.",
  });

/** auth.forgot-password: same response whether or not the account exists. */
export function ForgotPasswordPage() {
  const S = "auth.forgot-password";
  const form = useZodForm(z.object({ email: z.string().trim().email("Enter your work email.") }), {
    defaultValues: { email: "" },
  });
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = form.handleSubmit(async (v) => {
    try {
      await api("forgotPassword", { body: v });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  return (
    <PublicCard title="Reset password">
      {sent ? (
        <Alert testId={tid(S, "sent")}>
          If an account exists, a link is on its way. It expires in 1 hour.
        </Alert>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <TextField
            form={form}
            name="email"
            label="Work email"
            type="email"
            autoComplete="username"
            testId={tid(S, "email")}
          />
          <Button
            type="submit"
            variant="primary"
            loading={form.formState.isSubmitting}
            data-testid={tid(S, "send")}
          >
            Send reset link
          </Button>
        </form>
      )}
      <Link
        to={pathTo("auth.sign-in")}
        className="text-body text-ink underline underline-offset-4"
        data-testid={tid(S, "back")}
      >
        Back to sign-in
      </Link>
    </PublicCard>
  );
}

/** auth.reset-password: single-use link; revokes all sessions. */
export function ResetPasswordPage() {
  const S = "auth.reset-password";
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const form = useZodForm(newPasswordSchema, { defaultValues: { password: "", confirm: "" } });
  const [expired, setExpired] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pw = form.watch("password");
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api("resetPassword", { body: { token, newPassword: v.password } });
      navigate(pathTo("auth.sign-in"), { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_token") setExpired(true);
      else {
        const rest = applyServerErrors(form, e, { password: "password", newPassword: "password" });
        if (rest.length || !(e instanceof ApiError && e.problem.errors))
          setError(rest[0] ?? errorMessage(e));
      }
    }
  });
  return (
    <PublicCard title="Choose a new password">
      {expired ? (
        <Alert
          tone="caution"
          testId={tid(S, "expired")}
          action={
            <Link to={pathTo("auth.forgot-password")} className="font-semibold underline">
              Request a new link
            </Link>
          }
        >
          This link has expired.
        </Alert>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <TextField
            form={form}
            name="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            testId={tid(S, "new-password")}
          />
          <PolicyList password={pw} />
          <TextField
            form={form}
            name="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            testId={tid(S, "confirm-password")}
          />
          <Button
            type="submit"
            variant="primary"
            loading={form.formState.isSubmitting}
            data-testid={tid(S, "save")}
          >
            Set password
          </Button>
        </form>
      )}
    </PublicCard>
  );
}

/** auth.accept-invite: set a password, then enrol MFA. */
export function AcceptInvitePage() {
  const S = "auth.accept-invite";
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = React.useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const form = useZodForm(
    newPasswordSchema.and(
      z.object({ terms: z.literal(true, { message: "Accept the terms to continue." }) }),
    ),
    {
      defaultValues: { password: "", confirm: "", terms: false as unknown as true },
    },
  );
  const pw = form.watch("password");
  React.useEffect(() => {
    api("getInvitation", { params: { token } })
      .then(setInfo)
      .catch((e) => setLoadError(errorMessage(e)));
  }, [token]);

  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await api("acceptInvitation", {
        params: { token },
        body: { password: v.password, acceptTerms: true },
      });
      tokenStore.set("enrollment", r.enrollmentToken);
      navigate(pathTo("auth.mfa-enroll"), {
        state: { login: { next: "enroll", passwordExpired: false }, next: null },
      });
    } catch (e) {
      applyServerErrors(form, e, { password: "password" });
      if (!(e instanceof ApiError && e.problem.errors)) setLoadError(errorMessage(e));
    }
  });

  if (loadError && !info) {
    return (
      <PublicCard title="Invitation">
        <Alert tone="caution">{loadError}</Alert>
      </PublicCard>
    );
  }
  if (!info) {
    return (
      <PublicCard title="Invitation">
        <LoadingRows rows={3} />
      </PublicCard>
    );
  }
  return (
    <PublicCard title="Create your account">
      <p className="text-body text-ink" data-testid={tid(S, "invite-for")}>
        {info.practiceName} invited <span className="font-semibold">{info.email}</span>.
      </p>
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <TextField
          form={form}
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          testId={tid(S, "new-password")}
        />
        <PolicyList password={pw} email={info.email} />
        <TextField
          form={form}
          name="confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          testId={tid(S, "confirm-password")}
        />
        <CheckboxField
          form={form}
          name="terms"
          label="I accept the terms of use and the practice's security policy"
        />
        <Button
          type="submit"
          variant="primary"
          loading={form.formState.isSubmitting}
          data-testid={tid(S, "accept")}
        >
          Create account
        </Button>
      </form>
    </PublicCard>
  );
}
