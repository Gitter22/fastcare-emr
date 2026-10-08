import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { IntegrationHealth, IntegrationView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatDateTime, relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, EmptyState, LoadingRows, PageHeader } from "@/components/ui/layout";
import { Switch } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { SettingsLayout } from "@/shell/patterns";

const S = "admin.interfaces";

/** The list adds the gateway name and last error to IntegrationView. */
type Row = IntegrationView & { gateway?: string; lastError?: string };

const HEALTH_LABEL: Record<IntegrationHealth, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  DOWN: "Down",
  DISABLED: "Disabled",
};
const HEALTH_TONE: Record<IntegrationHealth, "active" | "caution" | "critical" | "neutral"> = {
  HEALTHY: "active",
  DEGRADED: "caution",
  DOWN: "critical",
  DISABLED: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT: "Sent",
  ACKNOWLEDGED: "Acknowledged",
  FAILED: "Failed",
  RETRYING: "Retrying",
  DEAD: "Dead",
};
const STATUS_TONE: Record<string, "active" | "caution" | "critical" | "neutral"> = {
  ACKNOWLEDGED: "active",
  SENT: "active",
  RETRYING: "caution",
  FAILED: "critical",
  DEAD: "critical",
};

const HealthTag = ({ health }: { health: IntegrationHealth }) => (
  <Tag tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Tag>
);

const isConnected = (connected: string[], gateway: string | undefined) =>
  !!gateway && connected.some((g) => g === gateway || g.startsWith(`${gateway}:`));

/** admin.interfaces: connection health, queues and retries (INV-OPS-01). */
export function InterfacesPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const list = useApi("listIntegrations");
  const selectedId = params.get("connection");
  const connected = me?.connectedGateways ?? [];

  const columns = React.useMemo<Col<Row>[]>(
    () => [
      {
        id: "name",
        header: "Interface",
        accessorFn: (c) => c.name,
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-semibold">{row.original.name}</span>
            <span className="text-small text-ink-2">{row.original.gateway}</span>
          </span>
        ),
      },
      {
        id: "health",
        header: "Health",
        accessorFn: (c) => c.health,
        // A gateway without vendor credentials has no health to report; say so instead of "Healthy".
        cell: ({ row }) =>
          isConnected(connected, row.original.gateway) ? (
            <HealthTag health={row.original.health} />
          ) : (
            <Tag tone="neutral">Not connected</Tag>
          ),
      },
      {
        id: "enabled",
        header: "Enabled",
        accessorFn: (c) => c.enabled,
        cell: ({ row }) => (row.original.enabled ? "On" : "Off"),
      },
      {
        id: "last",
        header: "Last success",
        accessorFn: (c) => c.lastSuccessAt ?? "",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.lastSuccessAt ? relativeTime(row.original.lastSuccessAt) : "—"}
          </span>
        ),
      },
      {
        id: "failures",
        header: "Failures (24h)",
        accessorFn: (c) => c.failures24h,
        cell: ({ row }) => <span className="tabular-nums">{row.original.failures24h}</span>,
      },
      {
        id: "queue",
        header: "Queue",
        accessorFn: (c) => c.queueDepth,
        cell: ({ row }) => <span className="tabular-nums">{row.original.queueDepth}</span>,
      },
    ],
    [connected],
  );

  return (
    <SettingsLayout>
      <PageHeader title="Interfaces" />
      <div
        className={selectedId ? "grid grid-cols-[minmax(0,1fr)_460px] items-start gap-6" : "grid"}
      >
        <Card>
          <DataTable
            columns={columns}
            data={list.data as Row[] | undefined}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty="No interfaces configured"
            getRowId={(c) => c.id}
            selectedId={selectedId}
            onRowClick={(c) => setParams({ connection: c.id })}
            testId={tid(S, "if-card")}
          />
        </Card>
        {selectedId ? (
          <Detail
            key={selectedId}
            id={selectedId}
            connected={connected}
            onClose={() => setParams({})}
          />
        ) : null}
      </div>
    </SettingsLayout>
  );
}

function Detail({
  id,
  connected,
  onClose,
}: {
  id: string;
  connected: string[];
  onClose: () => void;
}) {
  const { can } = useAuth();
  const detail = useApi("getIntegration", { params: { integrationConnectionId: id } });
  const messages = useApi("listInterfaceMessages", {
    params: { integrationConnectionId: id },
    query: { limit: 25 },
  });
  const [error, setError] = React.useState<string | null>(null);
  const [rotate, setRotate] = React.useState(false);
  const [secret, setSecret] = React.useState("");
  const inv = ["listIntegrations", "getIntegration", "listInterfaceMessages"] as const;
  const onError = (e: Error) => setError(errorMessage(e));
  const done = (text: string) => () => (setError(null), toast(text));
  const test = useApiMutation("testIntegration", {
    invalidates: [...inv],
    onSuccess: done("Connection tested."),
    onError,
  });
  const retry = useApiMutation("retryIntegration", {
    invalidates: [...inv],
    onSuccess: done("Failed messages sent again."),
    onError,
  });
  const resend = useApiMutation("resendInterfaceMessage", {
    invalidates: [...inv],
    onSuccess: done("Message sent again."),
    onError,
  });
  const update = useApiMutation("updateIntegration", {
    invalidates: [...inv],
    onSuccess: done("Saved."),
    onError,
  });
  const rotateSecret = useApiMutation("rotateIntegrationSecret", {
    invalidates: [...inv],
    onSuccess: () => (setSecret(""), setRotate(false), done("Credentials replaced.")()),
    onError,
  });

  if (detail.isLoading)
    return (
      <Card>
        <LoadingRows />
      </Card>
    );
  if (!detail.data)
    return (
      <Card>
        <EmptyState title="Interface not found" />
      </Card>
    );
  const d = detail.data;
  const version = (d as unknown as { version: number }).version;
  const live = isConnected(connected, d.gateway);
  const reason = `${d.displayName} isn't connected: no vendor credentials are configured.`;
  const params = { integrationConnectionId: id };
  const rows = messages.data?.data ?? d.recentMessages;
  const failed = rows.filter((m) => m.status === "FAILED" || m.status === "DEAD").length;
  const queued = rows.filter((m) => ["QUEUED", "SENDING", "RETRYING"].includes(m.status)).length;

  const retryButton = (
    <Button
      variant="primary"
      disabled={!live || !d.enabled}
      loading={retry.isPending}
      onClick={() => retry.mutate({ params })}
      data-testid={tid(S, "if-retry")}
    >
      Retry failed
    </Button>
  );

  return (
    <Card className="grid content-start gap-5" data-testid={tid(S, "detail")}>
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1">
          <h3 className="text-h3 text-ink">{d.displayName}</h3>
          <span className="text-small text-ink-2">
            {d.gateway} · since {formatDateTime(d.healthSince)}
          </span>
        </div>
        <HealthTag health={d.health} />
      </div>
      {error ? <Alert tone="caution">{error}</Alert> : null}
      {!live ? (
        <Alert tone="neutral">Not connected: no vendor credentials configured.</Alert>
      ) : null}
      {d.lastError ? <Alert tone="caution">Last error: {d.lastError}</Alert> : null}
      <div className="grid grid-cols-3 gap-3" data-testid={tid(S, "if-stats")}>
        <Stat label="Failed" value={failed} />
        <Stat label="Queued" value={queued} />
        <Stat label="Last success" text={d.lastSuccessAt ? relativeTime(d.lastSuccessAt) : "—"} />
      </div>
      <FieldShell label="Enabled">
        {can("updateIntegration") ? (
          <Switch
            checked={d.enabled}
            disabled={update.isPending}
            aria-label="Enabled"
            label={d.enabled ? "On" : "Off"}
            onCheckedChange={(enabled) =>
              update.mutate({ params, body: { enabled, version }, version })
            }
            data-testid={tid(S, "enable")}
          />
        ) : (
          <span>{d.enabled ? "On" : "Off"}</span>
        )}
      </FieldShell>
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          retryButton
        ) : (
          <Unavailable reason={reason} testId={tid(S, "if-retry-unavailable")}>
            {retryButton}
          </Unavailable>
        )}
        <Button
          loading={test.isPending}
          onClick={() => test.mutate({ params })}
          data-testid={tid(S, "test")}
        >
          Test connection
        </Button>
        {can("rotateIntegrationSecret") ? (
          <Button onClick={() => setRotate(true)} data-testid={tid(S, "rotate")}>
            Rotate secret
          </Button>
        ) : null}
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-small text-ink-2">
        Credentials: {d.secretsSet.length ? "set (write-only)" : "not set"}
      </p>
      <div className="grid gap-2">
        <h4 className="text-h4 text-ink">Recent messages</h4>
        {rows.length ? (
          <ul className="grid gap-2" data-testid={tid(S, "if-errors")}>
            {rows.map((m) => {
              const canResend =
                m.direction === "OUTBOUND" && (m.status === "FAILED" || m.status === "DEAD");
              const btn = (
                <Button
                  size="sm"
                  disabled={!live}
                  onClick={() => resend.mutate({ params: { interfaceMessageId: m.id } })}
                  aria-label={`Resend ${m.messageType}`}
                >
                  Resend
                </Button>
              );
              return (
                <li key={m.id} className="flex items-start gap-3 bg-surface-muted p-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{m.messageType}</span>
                      <Tag tone={STATUS_TONE[m.status] ?? "neutral"}>
                        {STATUS_LABEL[m.status] ?? m.status}
                      </Tag>
                    </span>
                    <span className="text-small text-ink-2">
                      {formatDateTime(m.createdAt)} · {m.attempts}{" "}
                      {m.attempts === 1 ? "attempt" : "attempts"}
                    </span>
                    {m.error ? <span className="text-small text-danger-ink">{m.error}</span> : null}
                  </div>
                  {canResend ? live ? btn : <Unavailable reason={reason}>{btn}</Unavailable> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-body text-ink-2">No messages yet.</p>
        )}
      </div>
      <ConfirmDialog
        open={rotate}
        onOpenChange={(o) => (setRotate(o), !o && setSecret(""))}
        title={`Rotate credentials for ${d.displayName}?`}
        description="The new value is stored encrypted and can't be read back. You will be asked to confirm your password."
        action="Replace credentials"
        disabled={!secret.trim()}
        onConfirm={() => rotateSecret.mutate({ params, body: { value: secret } })}
      >
        <Input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          aria-label="New credential"
          placeholder="New credential"
          data-testid={tid(S, "secret")}
        />
      </ConfirmDialog>
    </Card>
  );
}

function Stat({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="grid gap-0.5 bg-surface-muted p-3">
      <span className="text-caption text-ink-2">{label}</span>
      <span className="text-h3 tabular-nums text-ink">{text ?? value}</span>
    </div>
  );
}
