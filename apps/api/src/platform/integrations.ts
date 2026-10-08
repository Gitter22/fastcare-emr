import { getEnv } from "../env.js";
import { isStediConfigured } from "../gateways/clearinghouse/stediClient.js";
import { isLabConnected } from "../gateways/lab/index.js";
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

const DISPLAY: Record<IntegrationKind, string> = {
  STEDI: "Stedi clearinghouse",
  LOGICOY: "LogiCoy e-prescribing",
  HEALTH_GORILLA: "Lab interface (Health Gorilla)",
  LABCORP: "LabCorp (direct)",
  QUEST: "Quest Diagnostics (direct)",
  TWILIO: "Twilio SMS",
  SMTP: "Email (SMTP)",
  NPPES: "NPPES NPI registry",
  RXNAV: "NLM RxNav",
  IIS: "State immunization registry",
  PDMP: "State PDMP",
  DIRECT: "Direct secure messaging",
  FAX: "Fax",
  MFA: "Two-factor service",
  PAYMENT: "Card payments",
  VIDEO: "Telehealth video",
  HIE: "Health information exchange",
};

export const integrationDisplayName = (kind: IntegrationKind) => DISPLAY[kind];

export async function connectionFor(tx: Tx, practiceId: string, kind: IntegrationKind) {
  const existing = await tx.integrationConnection.findFirst({ where: { kind } });
  if (existing) return existing;
  return tx.integrationConnection.create({
    data: {
      practiceId,
      kind,
      gateway: GATEWAY_FOR[kind],
      displayName: DISPLAY[kind],
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

/**
 * Gateways that can reach their vendor now (Me.connectedGateways). The UI shows actions that need any other gateway
 * disabled with the reason, instead of faking them. Messaging is split by channel because SMS and email are
 * configured separately. Vendors without credentials here (e-prescribing, labs, registry, HIE, fax, video, card
 * processing -- OPEN-Q2) are not connected until their slice wires them.
 */
export function connectedGateways(): string[] {
  const env = getEnv();
  const out = ["ReferenceDataGateway"];
  if (isStediConfigured()) out.push("ClearinghouseGateway");
  // Simulated lab outside production (gateways/lab); a contracted vendor replaces it.
  if (isLabConnected()) out.push("LabGateway");
  const test = env.NODE_ENV === "test";
  if (test || (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER))
    out.push("MessagingGateway:sms");
  if (test || (env.GMAIL_USER && env.GMAIL_APP_PASSWORD)) out.push("MessagingGateway:email");
  return out;
}
