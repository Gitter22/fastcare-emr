import type { NotificationType, Role, Tx } from "../db.js";

/**
 * Notifications tray (global.notifications). Titles carry no PHI beyond patient initials; the link opens the item.
 */
export async function notifyUsers(
  tx: Tx,
  practiceId: string,
  userIds: string[],
  n: { type: NotificationType; title: string; linkRoute: string },
) {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  await tx.notification.createMany({
    data: unique.map((userId) => ({ practiceId, userId, ...n })),
  });
}

export async function notifyRole(
  tx: Tx,
  practiceId: string,
  role: Role,
  n: { type: NotificationType; title: string; linkRoute: string },
) {
  const users = await tx.userRole.findMany({
    where: { role, user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  await notifyUsers(
    tx,
    practiceId,
    users.map((u) => u.userId),
    n,
  );
}

export async function notifyPool(
  tx: Tx,
  practiceId: string,
  poolId: string,
  n: { type: NotificationType; title: string; linkRoute: string },
) {
  const members = await tx.workPoolMember.findMany({ where: { poolId }, select: { userId: true } });
  await notifyUsers(
    tx,
    practiceId,
    members.map((m) => m.userId),
    n,
  );
}

export const initials = (p: { firstName: string; lastName: string }) =>
  `${p.firstName[0] ?? ""}.${p.lastName[0] ?? ""}.`;
