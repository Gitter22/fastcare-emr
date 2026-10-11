import {
  fromCents,
  toCents,
  type RemittanceDetail,
  type RemittanceSummary,
} from "@agile-emr/shared";

type Line = RemittanceDetail["claimPayments"][number];

/** Posted-to-claims = Σ posted paid − Σ posted provider-level adjustments; balanced needs no gap and no unmatched line. */
export function remitTotals(r: RemittanceDetail) {
  const paid = r.claimPayments.reduce(
    (s, l) => s + (l.payment.posted ? toCents(l.payment.paid) : 0),
    0,
  );
  const plb = r.providerLevelAdjustments.reduce(
    (s, p) => s + (p.postedToClaimId ? toCents(p.amount) : 0),
    0,
  );
  const postedCents = paid - plb;
  const diffCents = toCents(r.paymentAmount) - postedCents;
  const unmatched = r.claimPayments.filter((l) => !l.payment.claimId).length;
  return {
    postedCents,
    diffCents,
    unmatched,
    balanced: diffCents === 0 && unmatched === 0,
  };
}

const codes = (l: Line, group: string) => {
  const a = l.adjustments.filter((x) => x.group === group);
  return {
    cents: a.reduce((s, x) => s + toCents(x.amount), 0),
    codes: [...new Set(a.map((x) => `${group}-${x.carc}`))].join(", "),
  };
};

export function linePresentation(l: Line) {
  const co = codes(l, "CO");
  const pr = codes(l, "PR");
  const base = {
    contractCents: co.cents,
    contractCodes: co.codes,
    patientCents: pr.cents,
    patientCodes: pr.codes,
  };
  if (!l.payment.claimId)
    return {
      ...base,
      kind: "unmatched" as const,
      note: "No claim matches this payment",
    };
  if (l.payment.claimStatusCode === "4") {
    const first = l.adjustments[0];
    return {
      ...base,
      kind: "denied" as const,
      note: first ? `${first.group}-${first.carc}` : undefined,
    };
  }
  if (l.payment.underpaidBy && toCents(l.payment.underpaidBy) > 0) {
    const contract = l.payment.allowed
      ? fromCents(toCents(l.payment.allowed) + toCents(l.payment.underpaidBy))
      : null;
    return {
      ...base,
      kind: "underpaid" as const,
      note: contract ? `Contract $${contract}` : `Short $${l.payment.underpaidBy}`,
    };
  }
  return { ...base, kind: "posted" as const, note: undefined };
}

export const plbClaimGuess = (claims: { id: string; number: string }[], ref?: string | null) => {
  if (!ref) return undefined;
  const k = ref.replace(/-/g, "").toLowerCase();
  return claims.find((c) => c.number.replace(/-/g, "").toLowerCase() === k)?.id;
};

export function eraStatusTag(r: RemittanceSummary): {
  label: string;
  tone: "caution" | "outline" | "neutral";
} {
  if (r.status === "POSTED") return { label: "Posted", tone: "neutral" };
  if (r.status === "EXCEPTION") return { label: "Needs review", tone: "caution" };
  return {
    label: r.status === "POSTING" ? "Posting" : "Received",
    tone: "outline",
  };
}

export function eraSummary(items: RemittanceSummary[]) {
  const review = items.filter((i) => i.status === "EXCEPTION").length;
  const auto = items.filter((i) => i.status === "POSTED").length;
  return `${items.length} remittances · ${auto} auto-posted · ${review} need review`;
}
