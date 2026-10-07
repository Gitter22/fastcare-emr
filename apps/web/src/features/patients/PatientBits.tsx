import * as React from "react";
import { Link } from "react-router-dom";
import type { PatientSummary } from "@agile-emr/shared";
import { isBuilt } from "@/app/registry";
import { pathTo } from "@/app/routes";
import { formatDate } from "@/lib/format";
import { Tag } from "@/components/ui/tag";

/** Patient name that opens the chart context when the chart is built (NAV-04). */
export function PatientLink({
  patient,
  testId,
  children,
}: {
  patient: Pick<PatientSummary, "id" | "name">;
  testId?: string;
  children?: React.ReactNode;
}) {
  const label = children ?? <span className="font-semibold">{patient.name}</span>;
  if (!isBuilt("chart.summary")) return <span data-testid={testId}>{label}</span>;
  return (
    <Link
      to={pathTo("chart.summary", { patientId: patient.id })}
      data-testid={testId}
      className="underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  );
}

const FLAG_TEXT: Record<
  string,
  { label: string; tone: "neutral" | "caution" | "critical" | "outline" }
> = {
  deceased: { label: "Deceased", tone: "neutral" },
  restricted: { label: "Restricted", tone: "caution" },
  part2: { label: "Part 2", tone: "caution" },
  inactive: { label: "Inactive", tone: "neutral" },
  merged: { label: "Merged", tone: "neutral" },
  minor: { label: "Minor", tone: "outline" },
  interpreter: { label: "Interpreter", tone: "outline" },
  "self-pay": { label: "Self-pay", tone: "outline" },
  "balance-due": { label: "Balance due", tone: "outline" },
};

export function PatientFlags({ flags }: { flags: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags
        .filter((f) => FLAG_TEXT[f])
        .map((f) => (
          <Tag key={f} tone={FLAG_TEXT[f]!.tone}>
            {FLAG_TEXT[f]!.label}
          </Tag>
        ))}
    </span>
  );
}

/** Identity line used wherever a patient is picked: name, DOB, MRN (INV-ID-01). */
export function PatientIdentity({ p }: { p: PatientSummary }) {
  return (
    <span className="grid gap-0.5">
      <span className="font-semibold text-ink">
        {p.name}
        {p.preferredName ? (
          <span className="font-normal text-ink-2"> "{p.preferredName}"</span>
        ) : null}
      </span>
      <span className="text-small tabular-nums text-ink-2">
        DOB {formatDate(p.birthDate)} · MRN {p.mrn}
        {p.phoneMasked ? ` · ${p.phoneMasked}` : ""}
      </span>
    </span>
  );
}
