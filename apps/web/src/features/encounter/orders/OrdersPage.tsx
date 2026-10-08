import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/lib/api/client";
import type { ServiceRequestView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { pathTo, tid } from "@/app/routes";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { pluralize } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { ContextDrawer } from "../ContextDrawer";
import { EncounterBody, useEncounter } from "../EncounterWorkspace";
import { OrderCard } from "./OrderCard";
import { OrderCatalogPanel } from "./OrderCatalogPanel";
import { CancelOrderDialog, ORDER_INVALIDATES, useLabConnected } from "./orderParts";

const S = "encounter.orders";

/** encounter.orders (flow:encounter/04): add orders from the catalog or a set, fix issues, sign. Labs go to the lab on signing. */
export function OrdersPage() {
  const { encounter, patientId, encounterId } = useEncounter();
  const { can } = useAuth();
  const navigate = useNavigate();
  const labConnected = useLabConnected();
  const orders = useApi("listEncounterOrders", { params: { encounterId } });
  const validation = useApi("validateEncounterOrders", { params: { encounterId } });
  const dxQuery = useApi("listEncounterDiagnoses", { params: { encounterId } });
  const [ack, setAck] = React.useState<Set<string>>(new Set());
  const [abnSigned, setAbnSigned] = React.useState(false);
  const [removing, setRemoving] = React.useState<ServiceRequestView | null>(null);
  const [problem, setProblem] = React.useState<string[] | null>(null);
  const noteSigned =
    !!encounter.note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(encounter.note.status);
  const editable = can("createServiceRequest") && !noteSigned;

  const sign = useApiMutation("signOrders", {
    invalidates: [...ORDER_INVALIDATES, "getEncounter"],
    onSuccess: (list) => {
      setProblem(null);
      const sent = list.filter((o) => o.status === "SENT").length;
      toast(
        sent
          ? `${pluralize(list.length, "order")} signed; ${sent} sent to the lab.`
          : `${pluralize(list.length, "order")} signed.`,
      );
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "orders_not_ready") {
        const issues = (e.problem as { issues?: Array<{ text: string }> }).issues ?? [];
        setProblem(issues.map((i) => i.text));
      } else toast.error(errorMessage(e));
    },
  });

  const all = orders.data ?? [];
  const live = all.filter((o) => o.status !== "CANCELLED");
  const pended = live.filter((o) => o.status === "PENDED");
  const issuesFor = (id: string) =>
    (validation.data?.issues ?? []).filter((i) => i.serviceRequestId === id);
  const ackKeys = (o: ServiceRequestView) =>
    new Set([...ack].filter((k) => k.startsWith(`${o.id}:`)));
  const blocking = pended.filter((o) => issuesFor(o.id).some((i) => i.severity === "error"));
  const unacked = pended.flatMap((o) =>
    issuesFor(o.id).filter(
      (i) => i.severity === "warning" && i.code !== "abn" && !ack.has(`${o.id}:${i.code}`),
    ),
  );
  const abnNeeded = pended.some((o) => issuesFor(o.id).some((i) => i.code === "abn"));
  const toFix =
    blocking.length +
    pended.filter(
      (o) =>
        !blocking.includes(o) &&
        issuesFor(o.id).some((i) => i.code !== "abn" && !ack.has(`${o.id}:${i.code}`)),
    ).length;
  const canSign =
    pended.length > 0 && !blocking.length && !unacked.length && (!abnNeeded || abnSigned);
  const goDx = () => navigate(pathTo("encounter.dx-coding", { patientId, encounterId }));
  const nowSignable = can("signOrders");

  return (
    <EncounterBody
      drawer={<ContextDrawer />}
      actionBar={
        <>
          <span className="mr-auto text-small text-ink-2" data-testid={tid(S, "after-sign")}>
            {labConnected
              ? "After signing: labs go to the lab electronically; imaging and procedures are scheduled by the front desk; referrals go to the referrals worklist."
              : "After signing: the lab interface isn't connected, so labs stay signed. Print the requisition to send with the patient."}
          </span>
          {nowSignable && abnNeeded ? (
            <Checkbox
              checked={abnSigned}
              onCheckedChange={(v) => setAbnSigned(v === true)}
              label="ABN signed by patient"
              data-testid={tid(S, "abn-signed")}
            />
          ) : null}
          {nowSignable ? (
            <Button
              variant="primary"
              disabled={!canSign || sign.isPending}
              loading={sign.isPending}
              data-testid={tid(S, "sign-orders")}
              onClick={() =>
                sign.mutate({
                  params: { encounterId },
                  body: {
                    patientId,
                    ids: pended.map((o) => o.id),
                    ...(abnSigned ? { abnSigned: true } : {}),
                    acknowledgedWarnings: [...ack],
                  },
                })
              }
            >
              {!pended.length
                ? "Sign orders"
                : toFix
                  ? `Sign ${pluralize(pended.length, "order")} · fix ${toFix} ${toFix === 1 ? "item" : "items"} first`
                  : `Sign ${pluralize(pended.length, "order")}`}
            </Button>
          ) : (
            <span className="text-small text-ink-2">The provider signs orders.</span>
          )}
        </>
      }
    >
      {noteSigned ? <Alert>The note is signed, so this visit's orders are locked.</Alert> : null}
      <div className="grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
        <OrderCatalogPanel
          patientId={patientId}
          encounterId={encounterId}
          diagnoses={dxQuery.data ?? []}
          editable={editable}
          onAddProblem={goDx}
        />
        <div className="grid min-w-0 content-start gap-4" data-testid={tid(S, "cart")}>
          <div>
            <h2 className="text-h2">Orders this visit</h2>
            <p className="text-body text-ink-2" data-testid={tid(S, "cart-summary")}>
              {pluralize(live.length, "order")}
              {toFix ? ` · ${toFix} need attention before signing` : ""}
            </p>
          </div>
          {problem ? (
            <Alert
              tone="critical"
              title="These orders aren't ready to sign."
              testId={tid(S, "not-ready")}
            >
              {problem.join(" ")}
            </Alert>
          ) : null}
          {orders.isLoading ? null : all.length ? (
            all.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                diagnoses={dxQuery.data ?? []}
                issues={issuesFor(o.id)}
                acknowledged={ackKeys(o)}
                onAcknowledge={(k) => setAck((s) => new Set(s).add(k))}
                onRemove={setRemoving}
                onAddProblem={goDx}
                canEdit={editable}
              />
            ))
          ) : (
            <EmptyState title="No orders yet">Search for a test or add an order set.</EmptyState>
          )}
        </div>
      </div>
      <CancelOrderDialog
        order={removing}
        onClose={() => setRemoving(null)}
        defaultReason={
          removing && issuesFor(removing.id).some((i) => i.code === "duplicate")
            ? "Duplicate order"
            : ""
        }
        title={`Remove ${removing?.display ?? "order"}?`}
        action="Remove order"
      />
    </EncounterBody>
  );
}
