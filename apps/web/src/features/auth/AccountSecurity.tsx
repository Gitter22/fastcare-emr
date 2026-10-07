import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import type { MfaEnrollmentChallenge } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDateTime, relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyServerErrors, TextField, useZodForm } from "@/components/ui/form";
import { Input, Label } from "@/components/ui/input";
import { Alert, Card, CardHeader, Page, PageHeader } from "@/components/ui/layout";
import { RadioGroup } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";

const S = "auth.account-security";

/** auth.account-security: password, MFA factors, recovery codes, sessions, recent sign-in activity (INV-SEC-04). */
export function AccountSecurityPage() {
  const [params, setParams] = useSearchParams();
  const sessions = useApi("listMySessions");
  const events = useApi("listMySecurityEvents", { query: { limit: 50 } });
  const me = useApi("getMe");
  const [confirm, setConfirm] = React.useState<
    null | { kind: "revoke"; id: string } | { kind: "revoke-all" } | { kind: "codes" }
  >(null);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const revoke = useApiMutation("revokeSession", {
    invalidates: ["listMySessions"],
    onSuccess: () => toast("Session signed out."),
  });
  const revokeAll = useApiMutation("revokeOtherSessions", {
    invalidates: ["listMySessions"],
    onSuccess: () => toast("Signed out everywhere else."),
  });
  const regen = useApiMutation("regenerateRecoveryCodes", {
    onSuccess: (r) => setCodes(r.codes),
    onError: (e) => toast(errorMessage(e)),
  });

  type SessionRow = NonNullable<typeof sessions.data>[number];
  type EventRow = NonNullable<typeof events.data>["data"][number];
  const sessionCols = React.useMemo<Col<SessionRow>[]>(
    () => [
      {
        id: "device",
        header: "Device",
        accessorFn: (s) => s.deviceName ?? "",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            {row.original.deviceName ?? "Browser"}
            {row.original.current ? <Tag tone="active">This device</Tag> : null}
          </span>
        ),
      },
      {
        id: "ip",
        header: "IP address",
        enableSorting: false,
        cell: ({ row }) => <span className="tabular-nums">{row.original.ipAddress ?? "—"}</span>,
      },
      {
        id: "created",
        header: "Signed in",
        accessorFn: (s) => s.createdAt,
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        id: "seen",
        header: "Last active",
        accessorFn: (s) => s.lastSeenAt,
        cell: ({ row }) => relativeTime(row.original.lastSeenAt),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) =>
          row.original.current ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirm({ kind: "revoke", id: row.original.id })}
              data-testid={tid(S, "revoke-session")}
            >
              Sign out
            </Button>
          ),
      },
    ],
    [],
  );
  const eventCols = React.useMemo<Col<EventRow>[]>(
    () => [
      {
        id: "at",
        header: "When",
        accessorFn: (e) => e.at,
        cell: ({ row }) => formatDateTime(row.original.at),
      },
      {
        id: "what",
        header: "Event",
        accessorFn: (e) => e.action,
        cell: ({ row }) =>
          row.original.outcome === "SUCCESS" ? (
            eventText(row.original.action)
          ) : (
            <Tag tone="caution">
              {eventText(row.original.action)} · {enumLabel(row.original.outcome)}
            </Tag>
          ),
      },
      {
        id: "ip",
        header: "IP address",
        enableSorting: false,
        cell: ({ row }) => <span className="tabular-nums">{row.original.ipAddress ?? "—"}</span>,
      },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader
        title="Account security"
        actions={
          <Button
            onClick={() => setParams({ view: "password" })}
            data-testid={tid(S, "change-password")}
          >
            Change password
          </Button>
        }
      />
      <Factors onAdded={() => void me.refetch()} onNewCodes={() => setConfirm({ kind: "codes" })} />
      <Card>
        <CardHeader
          title="Where you're signed in"
          actions={
            (sessions.data?.length ?? 0) > 1 ? (
              <Button
                size="sm"
                onClick={() => setConfirm({ kind: "revoke-all" })}
                data-testid={tid(S, "revoke-all")}
              >
                Sign out everywhere else
              </Button>
            ) : null
          }
        />
        <DataTable
          columns={sessionCols}
          data={sessions.data}
          loading={sessions.isLoading}
          error={sessions.error}
          getRowId={(s) => s.id}
          testId={tid(S, "sessions")}
        />
      </Card>
      <Card>
        <CardHeader title="Recent sign-in activity" />
        <DataTable
          columns={eventCols}
          data={events.data?.data}
          loading={events.isLoading}
          error={events.error}
          empty="No activity in the last 30 days"
          getRowId={(e) => e.id}
          testId={tid(S, "recent-activity")}
          compact
        />
      </Card>
      <PasswordDialog
        open={params.get("view") === "password"}
        onOpenChange={(o) => !o && setParams({})}
      />
      <ConfirmDialog
        open={confirm?.kind === "revoke"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Sign out this session?"
        description="That device will need to sign in again."
        action="Sign out"
        onConfirm={() =>
          confirm?.kind === "revoke" && revoke.mutate({ params: { sessionId: confirm.id } })
        }
      />
      <ConfirmDialog
        open={confirm?.kind === "revoke-all"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Sign out everywhere else?"
        description="Every other device signed in to your account is signed out now."
        action="Sign out"
        onConfirm={() => revokeAll.mutate({})}
      />
      <ConfirmDialog
        open={confirm?.kind === "codes"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Replace your recovery codes?"
        description="Your old recovery codes stop working as soon as new ones are made."
        action="Replace codes"
        onConfirm={() => regen.mutate({})}
      />
      <Dialog open={!!codes} onOpenChange={(o) => !o && setCodes(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New recovery codes</DialogTitle>
          </DialogHeader>
          <p className="text-body text-ink">Save these now. They won't be shown again.</p>
          <ul className="grid grid-cols-2 gap-2 bg-surface-muted p-4 font-semibold tabular-nums">
            {codes?.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="primary" onClick={() => setCodes(null)}>
              I saved them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

const eventText = (a: string) =>
  ({
    LOGIN: "Signed in",
    LOGOUT: "Signed out",
    LOGIN_FAILED: "Sign-in failed",
    MFA: "Two-step check",
  })[a] ?? enumLabel(a);

/** Sign-in methods. Factor list comes from the current user's MFA enrolment (startMfaEnrollment works signed in). */
function Factors({ onAdded, onNewCodes }: { onAdded: () => void; onNewCodes: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [method, setMethod] = React.useState<"TOTP" | "SMS">("TOTP");
  const [phone, setPhone] = React.useState("");
  const [challenge, setChallenge] = React.useState<MfaEnrollmentChallenge | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const start = async () => {
    setError(null);
    try {
      setChallenge(
        await api("startMfaEnrollment", {
          body: {
            type: method,
            ...(method === "SMS" ? { phone: `+1${phone.replace(/\D/g, "").slice(-10)}` } : {}),
          },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const confirmCode = async () => {
    setError(null);
    try {
      await api("confirmMfaEnrollment", {
        params: { factorId: challenge!.factorId },
        body: { code },
      });
      toast("Sign-in method added.");
      setAdding(false);
      setChallenge(null);
      setCode("");
      onAdded();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader
        title="Two-step sign-in"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onNewCodes}
              data-testid={tid(S, "regen-codes")}
            >
              New recovery codes
            </Button>
            <Button size="sm" onClick={() => setAdding(true)} data-testid={tid(S, "add-factor")}>
              Add method
            </Button>
          </>
        }
      />
      <p className="text-body text-ink" data-testid={tid(S, "factors")}>
        Two-step sign-in is on for your account. Keep at least one method and your recovery codes.
      </p>
      <Dialog
        open={adding}
        onOpenChange={(o) => (setAdding(o), !o && (setChallenge(null), setCode("")))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a sign-in method</DialogTitle>
          </DialogHeader>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          {!challenge ? (
            <>
              <RadioGroup<"TOTP" | "SMS">
                orientation="vertical"
                value={method}
                onValueChange={setMethod}
                options={[
                  { value: "TOTP", label: "Authenticator app" },
                  { value: "SMS", label: "Text message" },
                ]}
              />
              {method === "SMS" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="add-phone">Mobile number</Label>
                  <Input
                    id="add-phone"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              ) : null}
              <DialogFooter>
                <Button variant="primary" onClick={start}>
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {challenge.qrCodeDataUrl ? (
                <img
                  src={challenge.qrCodeDataUrl}
                  alt="QR code for your authenticator app"
                  className="size-44"
                />
              ) : (
                <p className="text-body">We sent a code to {challenge.codeSentTo}.</p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="add-code">6-digit code</Label>
                <Input
                  id="add-code"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="tabular-nums"
                />
              </div>
              <DialogFooter>
                <Button variant="primary" onClick={confirmCode} disabled={code.length < 6}>
                  Verify
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const pwSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    next: z.string().min(12, "Use at least 12 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ["confirm"], message: "Passwords don't match." });

function PasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const form = useZodForm(pwSchema, { defaultValues: { current: "", next: "", confirm: "" } });
  const [error, setError] = React.useState<string | null>(null);
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api("changePassword", { body: { currentPassword: v.current, newPassword: v.next } });
      toast("Password changed. Other sessions were signed out.");
      form.reset();
      onOpenChange(false);
    } catch (e) {
      const rest = applyServerErrors(form, e, {
        currentPassword: "current",
        password: "next",
        newPassword: "next",
      });
      if (rest.length) setError(rest[0]!);
      else if (!(e instanceof Error && "problem" in e)) setError(errorMessage(e));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
          </DialogHeader>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <TextField
            form={form}
            name="current"
            label="Current password"
            type="password"
            autoComplete="current-password"
            testId={tid(S, "current")}
          />
          <TextField
            form={form}
            name="next"
            label="New password"
            type="password"
            autoComplete="new-password"
            testId={tid(S, "next")}
          />
          <TextField
            form={form}
            name="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={form.formState.isSubmitting}
              data-testid={tid(S, "save")}
            >
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
