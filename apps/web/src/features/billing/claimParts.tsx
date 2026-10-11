import type { ClaimEvent } from "@agile-emr/shared";
import { formatDateTime, todayIso } from "@/lib/format";
import { Tag } from "@/components/ui/tag";

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Whole days from today to a business date (negative once past). */
export function daysLeft(deadline: string): number {
  return Math.round((utc(deadline.slice(0, 10)) - utc(todayIso())) / DAY);
}

/** Filing deadline chip with days left (INV-FIN-05); caution inside 30 days. */
export function DeadlineChip({ deadline, testId }: { deadline: string; testId?: string }) {
  const n = daysLeft(deadline);
  const text = n < 0 ? `Filing deadline passed ${-n} d ago` : `Filing deadline in ${n} days`;
  return (
    <Tag tone={n <= 30 ? "caution" : "outline"} data-testid={testId}>
      {text}
    </Tag>
  );
}

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Claim created",
  SUBMITTED: "Submitted to clearinghouse",
  ACK_999: "Clearinghouse acknowledgment (999)",
  ACK_277CA: "Payer acknowledgment (277CA)",
  STATUS_277: "Payer status (277)",
  REMIT_835: "Remittance (835)",
  CORRECTED: "Corrected",
  VOIDED: "Voided",
  NOTE: "Note",
};

/** Claim events, newest first (cd-history / rj-history). */
export function ClaimTimeline({ events, testId }: { events: ClaimEvent[]; testId?: string }) {
  const rows = [...events].sort((a, b) => b.at.localeCompare(a.at));
  if (!rows.length) return <p className="text-body text-ink-2">No events yet.</p>;
  return (
    <ol className="grid gap-2" data-testid={testId}>
      {rows.map((e) => (
        <li key={e.id} className="grid gap-0.5 text-body">
          <span>
            <b className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</b>
            {e.statusCode ? (
              <span className="tabular-nums text-ink-2"> · {e.statusCode}</span>
            ) : null}
          </span>
          {e.description ? <span className="text-small text-ink-2">{e.description}</span> : null}
          <span className="text-small tabular-nums text-ink-2">{formatDateTime(e.at)}</span>
        </li>
      ))}
    </ol>
  );
}
