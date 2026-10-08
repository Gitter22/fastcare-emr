import type { Tx } from "../db.js";
import { conflict } from "./problem.js";

/**
 * Re-sending an InterfaceMessage (INV-OPS-01, admin.interfaces). Each gateway registers how to re-run a message type
 * with the SAME idempotency key (normally by calling recordCall again with the stored business key, which upserts the
 * same row). The monitor never invents a send: a message type with no resender cannot be resent.
 */
export interface ResendableMessage {
  id: string;
  practiceId: string;
  connectionId: string;
  messageType: string;
  idempotencyKey: string;
  attempts: number;
  correlationType: string | null;
  correlationId: string | null;
}

export type Resender = (tx: Tx, message: ResendableMessage) => Promise<void>;

const resenders = new Map<string, Resender>();

export function registerResender(messageType: string, fn: Resender): void {
  resenders.set(messageType, fn);
}

export function canResend(messageType: string): boolean {
  return resenders.has(messageType);
}

/** Runs the registered resender; guarantees attempts went up by one for this call (idempotent: same row, same key). */
export async function resendMessage(tx: Tx, message: ResendableMessage): Promise<void> {
  const fn = resenders.get(message.messageType);
  if (!fn)
    throw conflict(
      "cannot_resend",
      `Messages of type ${message.messageType} can't be resent from here yet. Resend it from the record it came from.`,
    );
  await fn(tx, message);
  const after = await tx.interfaceMessage.findUniqueOrThrow({
    where: { id: message.id },
    select: { attempts: true },
  });
  if (after.attempts <= message.attempts)
    await tx.interfaceMessage.update({
      where: { id: message.id },
      data: { attempts: message.attempts + 1 },
    });
}
