/** INV-FIN-05: every denial shows how long is left to appeal. Caution under 14 days, critical once past. */
export function deadlineChip(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return { label: "No deadline", tone: "outline" as const, days: null };
  const days = Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
  if (days < 0) return { label: "Past deadline", tone: "critical" as const, days };
  const label = days === 0 ? "Due today" : `${days} ${days === 1 ? "day" : "days"} left`;
  return {
    label,
    tone: days < 14 ? ("caution" as const) : ("neutral" as const),
    days,
  };
}
