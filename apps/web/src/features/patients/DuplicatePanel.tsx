import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import type { DuplicateCheckResult } from "@agile-emr/shared";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tag } from "@/components/ui/tag";

const S = "patients.registration";

const MATCH_TEXT: Record<string, string> = {
  dob: "same DOB",
  "dob-transposed": "DOB with day and month swapped",
  lastName: "same last name",
  "lastName-similar": "similar last name",
  firstName: "same first name",
  "firstName-similar": "similar first name",
  phone: "same phone",
  email: "same email",
  ssn4: "same SSN last 4",
};

/** patients.registration aside: possible existing patients, side-by-side (INV-ID-02). */
export function DuplicatePanel({
  result,
  entering,
  overridden,
  onNotSame,
}: {
  result: DuplicateCheckResult;
  entering: { name: string; birthDate?: string; phone?: string; address?: string };
  overridden: boolean;
  onNotSame: () => void;
}) {
  const navigate = useNavigate();
  const top = result.candidates[0]!;
  const strong = result.blocking;
  return (
    <Card data-testid={tid(S, "dup-panel")} className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="text-h3 text-ink">Possible existing patient</h3>
        <div className="flex flex-wrap items-center gap-1">
          <Tag tone={strong ? "caution" : "neutral"}>
            {strong ? "Strong match" : "Possible match"}
          </Tag>
          <span className="text-small text-ink-2">
            {top.matchedOn.map((m) => MATCH_TEXT[m] ?? m).join(" · ")}
          </span>
        </div>
      </div>
      <div className="grid gap-0.5">
        <span className="text-body font-semibold text-ink">{top.patient.name}</span>
        <span className="text-small tabular-nums text-ink-2">
          MRN {top.patient.mrn} · DOB {formatDate(top.patient.birthDate)}
        </span>
      </div>
      <Table>
        <TableHeader>
          <tr>
            <TableHead />
            <TableHead>Entering</TableHead>
            <TableHead>On file</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell compact className="text-ink-2">
              Name
            </TableCell>
            <TableCell compact>{entering.name || "—"}</TableCell>
            <TableCell compact>{top.patient.name}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell compact className="text-ink-2">
              DOB
            </TableCell>
            <TableCell compact className="tabular-nums">
              {formatDate(entering.birthDate)}
            </TableCell>
            <TableCell compact className="tabular-nums">
              <span className="inline-flex items-center gap-1 font-semibold">
                {formatDate(top.patient.birthDate)}
                {top.matchedOn.includes("dob") ? (
                  <Check size={16} strokeWidth={1.75} aria-label="matches" />
                ) : null}
              </span>
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell compact className="text-ink-2">
              Phone
            </TableCell>
            <TableCell compact className="tabular-nums">
              {entering.phone || "—"}
            </TableCell>
            <TableCell compact className="tabular-nums">
              <span className="inline-flex items-center gap-1">
                {top.patient.phoneMasked ?? "—"}
                {top.matchedOn.includes("phone") ? (
                  <Check size={16} strokeWidth={1.75} aria-label="matches" />
                ) : null}
              </span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {result.candidates.length > 1 ? (
        <p className="text-small text-ink-2">
          {result.candidates.length - 1} more possible match
          {result.candidates.length > 2 ? "es" : ""}.
        </p>
      ) : null}
      <div className="grid gap-2">
        {isBuilt("chart.summary") ? (
          <Button
            onClick={() => navigate(pathTo("chart.summary", { patientId: top.patient.id }))}
            data-testid={tid(S, "dup-use-existing")}
          >
            Use existing record
          </Button>
        ) : (
          <Button
            onClick={() =>
              navigate(pathTo("patients.search", {}, undefined, { q: top.patient.mrn }))
            }
            data-testid={tid(S, "dup-use-existing")}
          >
            Use existing record
          </Button>
        )}
        {overridden ? (
          <p className="text-small text-ink">
            Marked as a different person. The new record will be queued for duplicate review.
          </p>
        ) : (
          <Button variant="ghost" onClick={onNotSame} data-testid={tid(S, "dup-not-same")}>
            Not the same person · create new
          </Button>
        )}
        <p className="text-small text-ink-2">
          Creating a new record anyway is logged and sent to the duplicate review queue.
        </p>
      </div>
    </Card>
  );
}
