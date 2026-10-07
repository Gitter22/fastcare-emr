import type { MachineId } from "@agile-emr/shared";
import { status } from "@/lib/format";
import { Tag } from "@/components/ui/tag";

/**
 * Status chip. Text comes only from spec/states.yaml labels (INV-DATA-03). Pine: colour is clinical only, so
 * states are neutral or "active" (pine-50); caution only where a person must act (no-show, rejected, denied).
 */
const ACTIVE: Record<string, string[]> = {
  appointment: ["ARRIVED", "ROOMED", "READY_FOR_PROVIDER", "WITH_PROVIDER", "CHECKOUT"],
  note: ["READY_TO_SIGN", "PENDING_COSIGN"],
  order: ["SIGNED", "SENT", "COLLECTED", "RESULTED_PRELIM", "RESULTED_FINAL"],
  claim: ["SUBMITTED", "ACCEPTED", "APPEALED"],
  task: ["IN_PROGRESS", "PENDED_TO_PROVIDER"],
  referral: ["SENT", "SCHEDULED", "AUTH_PENDING"],
};
const CAUTION: Record<string, string[]> = {
  appointment: ["NO_SHOW", "LEFT_WITHOUT_BEING_SEEN"],
  claim: ["REJECTED", "DENIED"],
  task: ["ESCALATED"],
};

export function StatusChip({
  machine,
  value,
  testId,
}: {
  machine: MachineId;
  value: string | null | undefined;
  testId?: string;
}) {
  const tone = CAUTION[machine]?.includes(value ?? "")
    ? "caution"
    : ACTIVE[machine]?.includes(value ?? "")
      ? "active"
      : "outline";
  return (
    <Tag tone={tone} data-testid={testId}>
      {status(machine, value)}
    </Tag>
  );
}
