import {
  operations,
  roles as roleDefs,
  roleFromEnum,
  type OperationMeta,
  type StaffRoleId,
} from "@agile-emr/shared";
import type { Role, Tx } from "../../db.js";
import { implementedOperations } from "../../platform/http/capabilities.js";

/** Roles, practitioner link and locations for a staff user (session start, getMe). */
export async function loadStaffProfile(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { roles: true, locations: true, practitioner: true, mfaFactors: true },
  });
  return user;
}

export function pickActiveRole(held: Role[], preferred: Role | null | undefined): Role | null {
  if (preferred && held.includes(preferred)) return preferred;
  return held[0] ?? null;
}

/** Operation ids the role may call that are implemented: the UI's capability list (hidden, not disabled: NAV-09). */
export function permissionsFor(role: StaffRoleId): string[] {
  return (Object.values(operations) as OperationMeta[])
    .filter(
      (o) =>
        o.security.includes("staffAuth") &&
        implementedOperations.has(o.id) &&
        (!o.roles || o.roles.includes(role)),
    )
    .map((o) => o.id);
}

export function canSignFor(role: StaffRoleId, epcsEnabled: boolean) {
  const can = roleDefs[role].can_sign as readonly string[];
  return {
    notes: can.includes("note"),
    orders: can.includes("order"),
    prescriptions: can.includes("prescription"),
    controlledSubstances: can.includes("prescription") && epcsEnabled,
  };
}

export const homeScreenFor = (role: StaffRoleId) => roleDefs[role].home;
export const toRoleIds = (held: Role[]) => held.map(roleFromEnum);
