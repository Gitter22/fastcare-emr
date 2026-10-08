import * as React from "react";
import { toast } from "sonner";
import type { OperationId, ServiceRequestView } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { api, errorMessage } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Unavailable } from "@/components/ui/unavailable";

/** Reads that go stale whenever an order changes (encounter list, validation, chart list, summary counts). */
export const ORDER_INVALIDATES: OperationId[] = [
  "listEncounterOrders",
  "validateEncounterOrders",
  "listPatientServiceRequests",
  "getPatientSummary",
  "getSignPreflight",
];

export const PRIORITY_OPTIONS = [
  { value: "ROUTINE", label: "Routine" },
  { value: "URGENT", label: "Urgent" },
  { value: "ASAP", label: "ASAP" },
  { value: "STAT", label: "STAT" },
];

export const COLLECTION_OPTIONS = [
  { value: "IN_OFFICE", label: "In-office draw today" },
  { value: "PATIENT_SERVICE_CENTER", label: "Patient service center" },
  { value: "HOME_KIT", label: "Mail kit to patient" },
  { value: "NOT_APPLICABLE", label: "Not applicable" },
];

export const CATEGORY_LABEL: Record<string, string> = {
  LAB: "Lab",
  IMAGING: "Imaging",
  PROCEDURE: "Procedure",
  REFERRAL: "Referral",
  DME: "DME",
  OTHER: "Other",
};

/** "Lab · Quest" style type chip text. */
export const orderTypeText = (o: Pick<ServiceRequestView, "category" | "performerLab">) =>
  [
    CATEGORY_LABEL[o.category] ?? o.category,
    o.performerLab
      ? o.performerLab[0] + o.performerLab.slice(1).toLowerCase().replace(/_/g, " ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The lab interface is connected (Me.connectedGateways); labs go SENT on signing only then. */
export function useLabConnected() {
  const { me } = useAuth();
  return !!me?.connectedGateways.includes("LabGateway");
}

export function useRequisition() {
  const [pending, setPending] = React.useState<string | null>(null);
  const open = async (serviceRequestId: string) => {
    setPending(serviceRequestId);
    try {
      openBlob((await api("getRequisition", { params: { serviceRequestId } })) as unknown as Blob);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(null);
    }
  };
  return { open, pending };
}

/** Send (or resend) a signed lab order: disabled with a reason when the lab interface isn't connected. */
export function ResendButton({ order, testId }: { order: ServiceRequestView; testId?: string }) {
  const connected = useLabConnected();
  const send = useApiMutation("sendServiceRequest", {
    invalidates: ORDER_INVALIDATES,
    onSuccess: () => toast("Order sent to the lab."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const btn = (
    <Button
      size="sm"
      disabled={!connected || send.isPending}
      data-testid={testId}
      onClick={() => send.mutate({ params: { serviceRequestId: order.id } })}
    >
      {order.status === "SENT" ? "Resend to lab" : "Send to lab"}
    </Button>
  );
  return connected ? (
    btn
  ) : (
    <Unavailable reason="The lab interface isn't connected. Print the requisition instead.">
      {btn}
    </Unavailable>
  );
}

/** Cancel with a reason (cancelServiceRequest). */
export function CancelOrderDialog({
  order,
  onClose,
  defaultReason = "",
  title,
  action = "Cancel order",
}: {
  order: ServiceRequestView | null;
  onClose: () => void;
  defaultReason?: string;
  title?: string;
  action?: string;
}) {
  const [reason, setReason] = React.useState(defaultReason);
  React.useEffect(() => setReason(defaultReason), [order, defaultReason]);
  const cancel = useApiMutation("cancelServiceRequest", {
    invalidates: ORDER_INVALIDATES,
    onSuccess: (o) => (toast(`${o.display} cancelled.`), onClose()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open={!!order}
      onOpenChange={(o) => !o && onClose()}
      title={title ?? `Cancel ${order?.display ?? "order"}?`}
      description="Say why. The reason stays with the order."
      action={action}
      danger
      disabled={!reason.trim() || cancel.isPending}
      testId="cancel-order-dialog"
      onConfirm={() =>
        order && cancel.mutate({ params: { serviceRequestId: order.id }, body: { reason } })
      }
    >
      <FieldShell label="Reason" required className="my-3">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="cancel-reason"
        />
      </FieldShell>
    </ConfirmDialog>
  );
}
