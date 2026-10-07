import type { IntegrationHealth, IntegrationKind, Tx } from "../db.js";
import { notifyRole } from "./notify.js";
import { createTask } from "./tasks.js";

/**
 * Interface monitoring (INV-OPS-01, admin.interfaces). Every vendor call is an InterfaceMessage with an
 * idempotency key derived from the business key. Connection health follows recent outcomes; going DOWN alerts
 * managers and creates an INTERFACE_FAILURE work item, so no failure is only a log line.
 */
export const GATEWAY_FOR: Record<IntegrationKind, string> = {
  STEDI: "ClearinghouseGateway",
  LOGICOY: "ErxGateway",
  HEALTH_GORILLA: "LabGateway",
  LABCORP: "LabGateway",
  QUEST: "LabGateway",
  TWILIO: "MessagingGateway",
  SMTP: "MessagingGateway",
  NPPES: "ReferenceDataGateway",
  RXNAV: "ReferenceDataGateway",
  IIS: "IisGateway",
  PDMP: "PdmpGateway",
  DIRECT: "DirectGateway",
  FAX: "FaxGateway",
  MFA: "MfaGateway",
  PAYMENT: "PaymentGateway",
  VIDEO: "VideoGateway",
  HIE: "HieGateway",
};

const DISPLAY: Partial<Record<IntegrationKind, string>> = {
  STEDI: "Stedi clearinghouse",
  LOGICOY: "LogiCoy e-prescribing",
  HEALTH_GORILLA: "Health Gorilla labs",
  TWILIO: "Twilio SMS",
  SMTP: "Email (SMTP)",
  NPPES: "NPPES NPI registry",
  RXNAV: "NLM RxNav",
  PAYMENT: "Card payments",
};

export async function connectionFor(tx: Tx, practiceId: string, kind: IntegrationKind) {
  const existing = await tx.integrationConnection.findFirst({ where: { kind } });
  if (existing) return existing;
  return tx.integrationConnection.create({
    data: {
      practiceId,
      kind,
      gateway: GATEWAY_FOR[kind],
      displayName: DISPLAY[kind] ?? kind,
      config: {},
      secretRef: `env:${kind}`,
      baaOnFile: false,
    },
  });
}

export interface CallOptions<T> {
  practiceId: string;
  kind: IntegrationKind;
  messageType: string;
  idempotencyKey: string;
  correlationType?: string;
  correlationId?: string;
  /** Classify a returned value as a failure (e.g. eligibility "Error" from an outage) without throwing. */
  failed?: (result: T) => string | null;
  vendorRef?: (result: T) => string | null;
}

/** Runs one outbound call and records it. A repeated idempotency key returns the stored outcome state. */
export async function recordCall<T>(
  tx: Tx,
  opts: CallOptions<T>,
  call: () => Promise<T>,
): Promise<T> {
  const conn = await connectionFor(tx, opts.practiceId, opts.kind);
  const msg = await tx.interfaceMessage.upsert({
    where: { idempotencyKey: opts.idempotencyKey },
    create: {
      practiceId: opts.practiceId,
      connectionId: conn.id,
      direction: "OUTBOUND",
      messageType: opts.messageType,
      idempotencyKey: opts.idempotencyKey,
      status: "SENDING",
      attempts: 1,
      correlationType: opts.correlationType ?? null,
      correlationId: opts.correlationId ?? null,
    },
    update: { attempts: { increment: 1 }, status: "SENDING" },
  });
  let result: T;
  try {
    result = await call();
  } catch (e) {
    await finish(
      tx,
      conn.id,
      msg.id,
      opts.practiceId,
      (e as { code?: string }).code ?? "CALL_FAILED",
    );
    throw e;
  }
  const failure = opts.failed?.(result) ?? null;
  if (failure) await finish(tx, conn.id, msg.id, opts.practiceId, failure);
  else {
    await tx.interfaceMessage.update({
      where: { id: msg.id },
      data: {
        status: "ACKNOWLEDGED",
        completedAt: new Date(),
        vendorRef: opts.vendorRef?.(result) ?? null,
        error: null,
      },
    });
    await setHealth(tx, conn.id, opts.practiceId, true);
  }
  return result;
}

async function finish(
  tx: Tx,
  connectionId: string,
  messageId: string,
  practiceId: string,
  error: string,
) {
  await tx.interfaceMessage.update({
    where: { id: messageId },
    data: { status: "FAILED", error: error.slice(0, 200) },
  });
  await setHealth(tx, connectionId, practiceId, false, error);
}

async function setHealth(
  tx: Tx,
  connectionId: string,
  practiceId: string,
  ok: boolean,
  error?: string,
) {
  const conn = await tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const recent = await tx.interfaceMessage.findMany({
    where: { connectionId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { status: true },
  });
  const failures = recent.filter((m) => m.status === "FAILED" || m.status === "DEAD").length;
  const next: IntegrationHealth =
    ok && failures <= 1
      ? "HEALTHY"
      : failures >= 3
        ? "DOWN"
        : failures >= 1
          ? "DEGRADED"
          : "HEALTHY";
  await tx.integrationConnection.update({
    where: { id: connectionId },
    data: {
      health: next,
      ...(next !== conn.health ? { healthSince: new Date() } : {}),
      ...(ok ? { lastSuccessAt: new Date() } : { lastError: error?.slice(0, 200) ?? null }),
    },
  });
  if (next === "DOWN" && conn.health !== "DOWN") {
    await notifyRole(tx, practiceId, "MANAGER", {
      type: "INTERFACE_DOWN",
      title: `${conn.displayName} is not responding`,
      linkRoute: "/admin/interfaces",
    });
    await createTask(tx, practiceId, {
      type: "INTERFACE_FAILURE",
      title: `${conn.displayName} is down`,
      description:
        "Recent messages failed. Check the interface monitor; queued messages retry automatically.",
      focusType: "IntegrationConnection",
      focusId: conn.id,
      poolKind: "front-desk",
      priority: "HIGH",
    });
  }
}
