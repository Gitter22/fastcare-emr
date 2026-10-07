import { Tag } from "@/components/ui/tag";

/**
 * Eligibility chip: "Not verified" is never shown as inactive (a payer outage is not a coverage answer).
 * `selfPay` is explicit: a coverage that was never checked has no status and reads "Not checked", never "Self-pay".
 */
export function EligibilityChip({
  status,
  selfPay = false,
  testId,
}: {
  status?: string | null;
  selfPay?: boolean;
  testId?: string;
}) {
  if (selfPay)
    return (
      <span className="text-ink-2" data-testid={testId}>
        Self-pay
      </span>
    );
  if (status === "ACTIVE") return <span data-testid={testId}>Eligible</span>;
  if (status === "INACTIVE")
    return (
      <Tag tone="caution" data-testid={testId}>
        Coverage inactive
      </Tag>
    );
  if (status === "ERROR")
    return (
      <Tag tone="caution" data-testid={testId}>
        Not verified
      </Tag>
    );
  if (status === "PENDING")
    return (
      <span className="text-ink-2" data-testid={testId}>
        Checking…
      </span>
    );
  return (
    <Tag tone="outline" data-testid={testId}>
      Not checked
    </Tag>
  );
}
