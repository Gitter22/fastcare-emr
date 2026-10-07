import { machines, type MachineId, type StateDef, type TransitionDef } from "@agile-emr/shared";
import { conflict, forbidden } from "./problem.js";

/**
 * Server-side transition guard: only transitions listed in spec/states.yaml are allowed, and only for the roles in
 * `by` (omitted = system or any role with access). Everything else is rejected (409 invalid_transition).
 */
export function findTransition(
  machine: MachineId,
  fromEnum: string | null,
  toId: string,
): TransitionDef | undefined {
  const states = machines[machine].states as readonly StateDef[];
  const fromId = fromEnum === null ? "new" : states.find((s) => s.enumValue === fromEnum)?.id;
  return (machines[machine].transitions as readonly TransitionDef[]).find(
    (t) => t.to === toId && fromId !== undefined && t.from.includes(fromId),
  );
}

export function assertTransition(
  machine: MachineId,
  fromEnum: string | null,
  toId: string,
  role: string | "system",
): TransitionDef {
  const t = findTransition(machine, fromEnum, toId);
  if (!t) {
    throw conflict(
      "invalid_transition",
      `A ${machine} cannot move from ${fromEnum ?? "new"} to ${toId}.`,
    );
  }
  // states.yaml outranks x-roles (docs/ehr-spec/CLAUDE.md precedence): an operation may list a role the machine's
  // `by` does not, and then the transition is refused. See OPEN-Q14.
  if (role !== "system" && t.by && t.by.length && !t.by.includes(role)) {
    throw forbidden("forbidden", `Your role cannot move a ${machine} to ${toId}.`);
  }
  return t;
}

export function toEnum(stateId: string): string {
  return stateId.toUpperCase().replace(/-/g, "_");
}
