import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Plus, Search } from "lucide-react";
import type { Role, UserView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDateTime, relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/dialog";
import { applyServerErrors, FieldShell, TextField, useZodForm } from "@/components/ui/form";
import { Input, Textarea } from "@/components/ui/input";
import { Alert, Card, EmptyState, LoadingRows, PageHeader } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { SettingsLayout } from "@/shell/patterns";
import { roleLabel } from "@/shell/AppShell";

const S = "admin.users-roles";
const ROLES: Role[] = ["PROVIDER", "MA", "FRONTDESK", "BILLER", "MANAGER"];
const SIGN_TEXT: Record<Role, string | null> = {
  PROVIDER: "notes, orders, prescriptions, result reviews, referrals, addenda, co-signatures",
  MA: "standing-order immunizations and vitals",
  FRONTDESK: null,
  BILLER: null,
  MANAGER: null,
};

/** admin.users-roles: least-privilege access, MFA status, provider linkage (HIPAA workforce controls). */
export function UsersRolesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = React.useState("");
  const [role, setRole] = React.useState<Role | "">("");
  const [status, setStatus] = React.useState<string>("ACTIVE");
  const users = useApi("listUsers", {
    query: {
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(role ? { role } : {}),
      ...(status ? { status: [status as never] } : {}),
    },
  });
  const all = useApi("listUsers", { query: {} });
  const selectedId = params.get("user");
  const counts = React.useMemo(() => {
    const d = all.data?.data ?? [];
    return {
      active: d.filter((u) => u.status === "ACTIVE").length,
      locked: d.filter((u) => u.status === "LOCKED").length,
      deactivated: d.filter((u) => u.status === "DEACTIVATED").length,
    };
  }, [all.data]);

  const columns = React.useMemo<Col<UserView>[]>(
    () => [
      {
        id: "user",
        header: "User",
        accessorFn: (u) => u.name,
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-semibold">{row.original.name}</span>
            <span className="text-small text-ink-2">{row.original.email}</span>
          </span>
        ),
      },
      {
        id: "roles",
        header: "Roles",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.roles.map((r) => (
              <Tag key={r} tone="outline">
                {roleLabel(r.toLowerCase())}
              </Tag>
            ))}
          </span>
        ),
      },
      {
        id: "mfa",
        header: "MFA",
        accessorFn: (u) => u.mfaEnrolled,
        cell: ({ row }) => (row.original.mfaEnrolled ? "On" : <Tag tone="caution">Not set up</Tag>),
      },
      {
        id: "last",
        header: "Last sign-in",
        accessorFn: (u) => u.lastSignInAt ?? "",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.lastSignInAt ? relativeTime(row.original.lastSignInAt) : "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (u) => u.status,
        cell: ({ row }) => {
          const u = row.original;
          if (u.status === "LOCKED") return <Tag tone="caution">Locked</Tag>;
          if (u.status === "INVITED") return <Tag>Invited</Tag>;
          if (u.status === "DEACTIVATED") return <span className="text-ink-2">Deactivated</span>;
          return "Active";
        },
      },
    ],
    [],
  );

  return (
    <SettingsLayout>
      <PageHeader
        title="Users & roles"
        actions={
          can("inviteUser") ? (
            <Button
              variant="primary"
              onClick={() => setParams({ view: "invite" })}
              data-testid={tid(S, "invite")}
            >
              <Plus size={18} strokeWidth={1.75} />
              Invite user
            </Button>
          ) : null
        }
      />
      <div
        className={selectedId ? "grid grid-cols-[minmax(0,1fr)_420px] items-start gap-6" : "grid"}
      >
        <Card>
          <div className="mb-4 flex flex-wrap gap-2">
            <div className="relative min-w-60 flex-1">
              <Search
                size={18}
                strokeWidth={1.75}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
                aria-hidden
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search users"
                aria-label="Search users"
                className="pl-10"
                data-testid={tid(S, "list-search")}
              />
            </div>
            <Select
              aria-label="Role"
              className="w-44"
              value={role}
              onValueChange={(v) => setRole(v === "ALL" ? "" : (v as Role))}
              placeholder="All roles"
              options={[
                { value: "ALL", label: "All roles" },
                ...ROLES.map((r) => ({ value: r, label: roleLabel(r.toLowerCase()) })),
              ]}
            />
            <Select
              aria-label="Status"
              className="w-44"
              value={status}
              onValueChange={(v) => setStatus(v === "ALL" ? "" : v)}
              placeholder="Any status"
              options={[
                { value: "ALL", label: "Any status" },
                { value: "ACTIVE", label: "Active" },
                { value: "INVITED", label: "Invited" },
                { value: "LOCKED", label: "Locked" },
                { value: "DEACTIVATED", label: "Deactivated" },
              ]}
            />
            <span className="ml-auto self-center text-small tabular-nums text-ink-2">
              {counts.active} active · {counts.locked} locked · {counts.deactivated} deactivated
            </span>
          </div>
          <DataTable
            columns={columns}
            data={users.data?.data}
            loading={users.isLoading}
            error={users.error}
            onRetry={() => void users.refetch()}
            empty="No users match"
            getRowId={(u) => u.id}
            selectedId={selectedId}
            onRowClick={(u) => setParams({ user: u.id })}
            testId={tid(S, "user-table")}
          />
        </Card>
        {selectedId ? (
          <EditUser key={selectedId} userId={selectedId} onClose={() => setParams({})} />
        ) : null}
      </div>
      <InviteDrawer
        open={params.get("view") === "invite"}
        onOpenChange={(o) => !o && setParams({})}
      />
    </SettingsLayout>
  );
}

function EditUser({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { can, me } = useAuth();
  const user = useApi("getUser", { params: { userId } });
  const locations = useApi("listLocations");
  const [roles, setRoles] = React.useState<Role[] | null>(null);
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "deactivate" | "reset-mfa">(null);
  const [deactivateReason, setDeactivateReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inv = ["listUsers", "getUser"] as const;
  const onError = (e: Error) => setError(errorMessage(e));
  const saveRoles = useApiMutation("setUserRoles", {
    invalidates: [...inv],
    onSuccess: () => (
      toast("Roles saved. The user signs in again to pick them up."),
      setReason(""),
      setRoles(null)
    ),
    onError,
  });
  const unlock = useApiMutation("unlockUser", {
    invalidates: [...inv],
    onSuccess: () => toast("Account unlocked."),
    onError,
  });
  const resetMfa = useApiMutation("resetUserMfa", {
    invalidates: [...inv],
    onSuccess: () => toast("Sign-in methods removed. The user sets up MFA at next sign-in."),
    onError,
  });
  const deactivate = useApiMutation("deactivateUser", {
    invalidates: [...inv],
    onSuccess: () => (toast("User deactivated. All sessions ended."), onClose()),
    onError,
  });

  if (user.isLoading)
    return (
      <Card>
        <LoadingRows />
      </Card>
    );
  if (!user.data)
    return (
      <Card>
        <EmptyState title="User not found" />
      </Card>
    );
  const u = user.data;
  const current = roles ?? u.roles;
  const changed =
    roles !== null && (roles.length !== u.roles.length || roles.some((r) => !u.roles.includes(r)));
  const signs = current.map((r) => SIGN_TEXT[r]).filter(Boolean);
  const self = u.id === me?.user.id;

  return (
    <Card className="grid content-start gap-6" data-testid={tid(S, "edit-pane")}>
      <div className="flex items-start gap-4">
        <span className="grid size-12 place-items-center rounded-full bg-surface-muted text-body font-semibold">
          {u.name
            .split(" ")
            .map((p) => p[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div className="grid min-w-0">
          <h3 className="text-h3 text-ink">{u.name}</h3>
          <span className="truncate text-small text-ink-2">{u.email}</span>
        </div>
      </div>
      {error ? <Alert tone="caution">{error}</Alert> : null}
      {u.status === "LOCKED" ? (
        <Alert
          tone="caution"
          action={
            can("unlockUser") ? (
              <Button
                size="sm"
                onClick={() => unlock.mutate({ params: { userId: u.id } })}
                loading={unlock.isPending}
              >
                Unlock
              </Button>
            ) : null
          }
        >
          Locked after failed sign-ins
          {u.lockedUntil ? ` until ${formatDateTime(u.lockedUntil)}` : ""}.
        </Alert>
      ) : null}
      <FieldShell label="Roles">
        <div className="grid gap-2" data-testid={tid(S, "roles")}>
          {ROLES.map((r) => (
            <Checkbox
              key={r}
              label={roleLabel(r.toLowerCase())}
              disabled={!can("setUserRoles") || u.status === "DEACTIVATED"}
              checked={current.includes(r)}
              onCheckedChange={(c) =>
                setRoles(
                  c ? [...current.filter((x) => x !== r), r] : current.filter((x) => x !== r),
                )
              }
            />
          ))}
        </div>
      </FieldShell>
      <div className="bg-surface-muted p-4 text-body">
        {signs.length ? (
          <>
            <span className="font-semibold">Can sign:</span> {signs.join("; ")}.
          </>
        ) : (
          <span>These roles can prepare work but can't sign clinical items.</span>
        )}
        {current.includes("BILLER") ? (
          <span className="mt-1 block text-small text-ink-2">
            Billing roles never see clinical note text.
          </span>
        ) : null}
      </div>
      {changed ? (
        <FieldShell label="Reason for the change" required hint="Recorded in the audit log.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldShell>
      ) : null}
      <FieldShell label="Locations">
        <p className="text-body text-ink">
          {u.locations.length
            ? u.locations.map((l) => l.name).join(", ")
            : (locations.data ?? []).length
              ? "All locations"
              : "—"}
        </p>
      </FieldShell>
      <FieldShell label="Sign-in">
        <p className="text-body text-ink">
          {u.mfaEnrolled
            ? `Two-step sign-in on (${u.mfaTypes.map((t) => (t === "TOTP" ? "app" : t.toLowerCase())).join(", ")})`
            : "Two-step sign-in not set up yet"}
          {u.lastSignInAt ? ` · last signed in ${formatDateTime(u.lastSignInAt)}` : ""}
        </p>
      </FieldShell>
      <div className="flex flex-wrap items-center gap-2">
        {can("deactivateUser") && u.status !== "DEACTIVATED" && !self ? (
          <Button
            variant="ghost"
            onClick={() => setConfirm("deactivate")}
            data-testid={tid(S, "deactivate")}
          >
            Deactivate
          </Button>
        ) : null}
        {can("resetUserMfa") && u.mfaEnrolled && !self ? (
          <Button
            variant="ghost"
            onClick={() => setConfirm("reset-mfa")}
            data-testid={tid(S, "reset-mfa")}
          >
            Reset MFA
          </Button>
        ) : null}
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
        {can("setUserRoles") ? (
          <Button
            variant="primary"
            disabled={!changed || reason.trim().length < 3 || !current.length}
            loading={saveRoles.isPending}
            onClick={() =>
              saveRoles.mutate({
                params: { userId: u.id },
                body: { roles: current, reason: reason.trim() },
              })
            }
            data-testid={tid(S, "save")}
          >
            Save changes
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm === "deactivate"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Deactivate ${u.name}?`}
        description="Every session ends now and the user can't sign in. Their history is kept."
        action="Deactivate"
        danger
        onConfirm={() =>
          deactivate.mutate({
            params: { userId: u.id },
            body: { reason: deactivateReason || "Deactivated by practice manager" },
          })
        }
      >
        <Textarea
          value={deactivateReason}
          onChange={(e) => setDeactivateReason(e.target.value)}
          placeholder="Reason (for example: left the practice)"
          aria-label="Reason"
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "reset-mfa"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Reset MFA for ${u.name}?`}
        description="Their sign-in methods are removed and their sessions end. They set up MFA again at next sign-in."
        action="Reset MFA"
        danger
        onConfirm={() => resetMfa.mutate({ params: { userId: u.id } })}
      />
    </Card>
  );
}

const inviteSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's full name."),
  email: z.string().trim().email("Enter a work email."),
  roles: z.array(z.string()).min(1, "Choose at least one role."),
});

function InviteDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const form = useZodForm(inviteSchema, { defaultValues: { name: "", email: "", roles: [] } });
  const locations = useApi("listLocations", undefined, { enabled: open });
  const [locationIds, setLocationIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const roles = form.watch("roles");
  const invite = useApiMutation("inviteUser", {
    invalidates: ["listUsers"],
    onSuccess: (u) => {
      toast(`Invitation sent to ${u.email}.`);
      form.reset();
      setLocationIds([]);
      onOpenChange(false);
    },
    onError: (e) => {
      const rest = applyServerErrors(form, e);
      setError(rest[0] ?? errorMessage(e));
    },
  });
  const submit = form.handleSubmit((v) =>
    invite.mutate({
      body: { name: v.name, email: v.email, roles: v.roles as Role[], locationIds },
    }),
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <form onSubmit={submit} className="flex h-full flex-col" noValidate>
          <SheetHeader>
            <SheetTitle>Invite user</SheetTitle>
          </SheetHeader>
          <SheetBody className="grid content-start gap-4">
            {error ? <Alert tone="caution">{error}</Alert> : null}
            <TextField form={form} name="name" label="Full name" required />
            <TextField form={form} name="email" label="Work email" type="email" required />
            <FieldShell
              label="Roles"
              required
              error={form.formState.errors.roles?.message}
              hint="Give only what the job needs."
            >
              <div className="grid gap-2">
                {ROLES.map((r) => (
                  <Checkbox
                    key={r}
                    label={roleLabel(r.toLowerCase())}
                    checked={roles.includes(r)}
                    onCheckedChange={(c) =>
                      form.setValue("roles", c ? [...roles, r] : roles.filter((x) => x !== r), {
                        shouldValidate: true,
                      })
                    }
                  />
                ))}
              </div>
            </FieldShell>
            <FieldShell label="Locations" hint="Leave all unchecked to allow every location.">
              <div className="grid gap-2">
                {(locations.data ?? [])
                  .filter((l) => l.active)
                  .map((l) => (
                    <Checkbox
                      key={l.id}
                      label={l.name}
                      checked={locationIds.includes(l.id)}
                      onCheckedChange={(c) =>
                        setLocationIds((ids) =>
                          c ? [...ids, l.id] : ids.filter((x) => x !== l.id),
                        )
                      }
                    />
                  ))}
              </div>
            </FieldShell>
            <p className="text-small text-ink-2">
              The user sets a password from the emailed link, then must set up two-step sign-in
              before they can use the system.
            </p>
          </SheetBody>
          <SheetFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={invite.isPending}>
              Send invitation
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
