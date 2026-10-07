import * as React from "react";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows, PageHeader } from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
import { SettingsLayout } from "@/shell/patterns";
import { useQueryClient } from "@tanstack/react-query";

const S = "admin.security";
const TIMEOUTS = [5, 10, 15, 20, 30, 45, 60].map((m) => ({
  value: String(m),
  label: `${m} minutes idle`,
}));
const ABSOLUTE = [4, 8, 10, 12, 16, 24].map((h) => ({ value: String(h), label: `${h} hours` }));
const BTG = [15, 30, 60, 120, 240].map((m) => ({
  value: String(m),
  label: m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`,
}));
const AGE = [
  { value: "0", label: "Never expire (length and breach checks only)" },
  { value: "90", label: "Every 90 days" },
  { value: "180", label: "Every 180 days" },
  { value: "365", label: "Every year" },
];

type Key =
  | "security.sessionTimeoutMinutes"
  | "security.absoluteTimeoutHours"
  | "security.breakGlassMinutes"
  | "security.passwordMaxAgeDays";

/** admin.security: MFA (always on), session timeouts, break-the-glass duration, password rules (INV-SEC-04). */
export function SecurityPolicyPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const settings = useApi("listSettings", { query: { prefix: "security." } });
  const [draft, setDraft] = React.useState<Partial<Record<Key, string>>>({});
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const value = (k: Key, def: number) =>
    draft[k] ??
    String((settings.data?.find((s) => s.key === k)?.value as number | undefined) ?? def);
  const changed = Object.keys(draft) as Key[];
  const editable = can("putSetting");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Each key is versioned and audited separately; step-up is requested once by the API client.
      for (const k of changed)
        await api("putSetting", {
          params: { key: k },
          body: { value: Number(draft[k]), reason: reason.trim() || undefined },
        });
      toast("Security policy saved.");
      setDraft({});
      setReason("");
      await qc.invalidateQueries({ queryKey: ["listSettings"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsLayout>
      <PageHeader title="Security policy" />
      {settings.isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : (
        <>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <Card>
            <CardHeader title="Sign-in" />
            <div className="grid max-w-2xl gap-5">
              <div
                className="flex items-start gap-3 bg-surface-muted p-4"
                data-testid={tid(S, "sec-mfa")}
              >
                <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
                <p className="text-body text-ink">
                  <span className="font-semibold">Two-step sign-in is required for all staff.</span>{" "}
                  It can't be turned off.
                </p>
              </div>
              <FieldShell
                label="Session timeout"
                hint="Staff are signed out after this much inactivity. Drafts are saved."
              >
                <Select
                  testId={tid(S, "sec-timeout")}
                  disabled={!editable}
                  value={value("security.sessionTimeoutMinutes", 15)}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, "security.sessionTimeoutMinutes": v }))
                  }
                  options={TIMEOUTS}
                />
              </FieldShell>
              <FieldShell
                label="Maximum session length"
                hint="Everyone signs in again after this long, even if active."
              >
                <Select
                  disabled={!editable}
                  value={value("security.absoluteTimeoutHours", 12)}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, "security.absoluteTimeoutHours": v }))
                  }
                  options={ABSOLUTE}
                />
              </FieldShell>
            </div>
          </Card>
          <Card>
            <CardHeader title="Emergency access" />
            <div className="grid max-w-2xl gap-5">
              <FieldShell
                label="Access lasts up to"
                hint="Each use needs a reason, alerts practice managers and is reviewed afterwards."
              >
                <Select
                  testId={tid(S, "sec-btg")}
                  disabled={!editable}
                  value={value("security.breakGlassMinutes", 60)}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, "security.breakGlassMinutes": v }))
                  }
                  options={BTG}
                />
              </FieldShell>
            </div>
          </Card>
          <Card>
            <CardHeader title="Passwords" />
            <div className="grid max-w-2xl gap-5" data-testid={tid(S, "sec-password")}>
              <ul className="grid gap-1 text-body text-ink">
                <li>At least 12 characters</li>
                <li>Checked against known breached passwords</li>
                <li>Can't contain the user's name or email</li>
                <li>Locked for 15 minutes after 5 failed attempts</li>
              </ul>
              <FieldShell label="Require a new password">
                <Select
                  disabled={!editable}
                  value={value("security.passwordMaxAgeDays", 0)}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, "security.passwordMaxAgeDays": v }))
                  }
                  options={AGE}
                />
              </FieldShell>
            </div>
          </Card>
          {editable && changed.length ? (
            <Card className="grid gap-4">
              <FieldShell
                label="Reason for the change"
                hint="Recorded with the new policy version."
              >
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </FieldShell>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDraft({})}>
                  Discard
                </Button>
                <Button
                  variant="primary"
                  loading={saving}
                  onClick={save}
                  data-testid={tid(S, "sec-save")}
                >
                  Save
                </Button>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </SettingsLayout>
  );
}
