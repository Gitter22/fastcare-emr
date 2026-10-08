import * as React from "react";
import { toast } from "sonner";
import type { ImmunizationForecastItem, VaccineLot } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { formatShortDate, formatTime, todayIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";

const S = "encounter.rooming";
const SITES = ["Left deltoid", "Right deltoid", "Left thigh", "Right thigh"];
const ROUTE_FOR_SITE = "IM";

/**
 * Standing-order vaccines (flow:checkin/05). Expired or empty lots can't be chosen, and the API refuses them too.
 * Reporting to the state registry (IisGateway) is shown disabled until that connection exists.
 */
export function StandingOrders({
  due,
  patientId,
  encounterId,
  orderedById,
  disabled,
}: {
  due: ImmunizationForecastItem[];
  patientId: string;
  encounterId: string;
  orderedById: string;
  disabled?: boolean;
}) {
  const given = useApi("listImmunizations", { params: { patientId }, query: {} });
  const today = given.data?.filter((i) => i.encounterId === encounterId) ?? [];
  if (!due.length && !today.length) return null;
  return (
    <Card data-testid={tid(S, "standing-orders")}>
      <CardHeader
        title="Standing orders"
        actions={<span className="text-small text-ink-2">Protocol: adult immunizations</span>}
      />
      <ul>
        {today.map((i) => (
          <li
            key={i.id}
            className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-0"
          >
            <span className="grid">
              <b className="font-semibold">{i.display}</b>
              <span className="text-small text-ink-2">
                Given {formatTime(i.occurrenceAt)} · lot {i.lotNumber} · {i.site}
              </span>
            </span>
            <span className="text-small text-ink-2">Recorded</span>
          </li>
        ))}
        {due.map((d) => (
          <VaccineRow
            key={d.vaccineGroup}
            item={d}
            encounterId={encounterId}
            orderedById={orderedById}
            disabled={disabled}
          />
        ))}
      </ul>
    </Card>
  );
}

function VaccineRow({
  item,
  encounterId,
  orderedById,
  disabled,
}: {
  item: ImmunizationForecastItem;
  encounterId: string;
  orderedById: string;
  disabled?: boolean;
}) {
  const { can } = useAuth();
  const me = useMe();
  const lots = useApi("listVaccineLots", {
    query: me.activeLocationId ? { locationId: me.activeLocationId } : {},
  });
  const options = (lots.data ?? []).filter((l) => item.cvxOptions.includes(l.cvxCode));
  const [lotId, setLotId] = React.useState("");
  const [site, setSite] = React.useState(SITES[0]!);
  const [vis, setVis] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [report, setReport] = React.useState(true);
  const iis = me.connectedGateways.includes("IisGateway");
  const lot = options.find((l) => l.id === lotId);
  const usable = (l: VaccineLot) => l.expirationDate >= todayIso() && l.quantityOnHand > 0;
  const give = useApiMutation("administerImmunization", {
    invalidates: ["listImmunizations", "getRooming", "listVaccineLots", "getPatientSummary"],
    onSuccess: (i) => (toast(`${i.display} recorded.`), setConfirm(false)),
    onError: (e) => (toast.error(errorMessage(e)), setConfirm(false)),
  });
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-x-3 gap-y-2 border-b border-line py-4 last:border-0"
      data-testid={tid(S, "vaccine-due")}
    >
      <span className="col-span-full grid">
        <b className="font-semibold">
          {item.vaccineGroup} vaccine{item.doseNumber ? `, dose ${item.doseNumber}` : ""}
        </b>
        <span className="text-small text-ink-2">
          {item.overdue ? "Overdue" : "Due"} {formatShortDate(item.dueDate)} · no contraindications
          recorded
        </span>
      </span>
      <FieldShell label="Lot">
        <Select
          value={lotId}
          onValueChange={setLotId}
          aria-label="Lot"
          placeholder={options.length ? "Choose lot" : "None in stock"}
          disabled={disabled || !options.length}
          testId={tid(S, "vaccine-lot")}
          options={options.map((l) => ({
            value: l.id,
            disabled: !usable(l),
            label: `${l.lotNumber} · exp ${l.expirationDate.slice(5, 7)}/${l.expirationDate.slice(0, 4)}${l.expirationDate < todayIso() ? " · expired" : l.quantityOnHand < 1 ? " · none left" : ""}`,
          }))}
        />
      </FieldShell>
      <FieldShell label="Site">
        <Select
          value={site}
          onValueChange={setSite}
          aria-label="Site"
          disabled={disabled}
          testId={tid(S, "vaccine-site")}
          options={SITES.map((s) => ({ value: s, label: s }))}
        />
      </FieldShell>
      <FieldShell label="VIS edition date">
        <DateInput
          value={vis}
          onChange={setVis}
          aria-label="VIS edition date"
          disabled={disabled}
        />
      </FieldShell>
      {can("administerImmunization") ? (
        <Button
          disabled={disabled || !lot || !vis}
          onClick={() => setConfirm(true)}
          data-testid={tid(S, "vaccine-administer")}
        >
          Administer
        </Button>
      ) : (
        <span />
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Record ${item.vaccineGroup.toLowerCase()} vaccine as given?`}
        description={`Lot ${lot?.lotNumber ?? ""}, ${site.toLowerCase()}, ${ROUTE_FOR_SITE}. Confirm the VIS was given and there are no contraindications.`}
        action="Record dose"
        disabled={give.isPending}
        onConfirm={() =>
          lot &&
          vis &&
          give.mutate({
            params: { encounterId },
            body: {
              cvx: lot.cvxCode,
              vaccineLotId: lot.id,
              route: ROUTE_FOR_SITE,
              site,
              doseQuantity: 0.5,
              administeredAt: new Date().toISOString(),
              visGivenDate: todayIso(),
              visEditionDate: vis,
              fundingSource: lot.fundingSource === "VFC" ? "vfc" : "private",
              orderedById,
              reportToIis: iis && report,
              ...(item.doseNumber ? { doseNumber: item.doseNumber } : {}),
            },
          })
        }
      >
        {iis ? (
          <Checkbox
            checked={report}
            onCheckedChange={(v) => setReport(v === true)}
            label="Report to state registry"
          />
        ) : (
          <span className="grid gap-1">
            <Checkbox checked={false} disabled label="Report to state registry" />
            <span className="text-small text-ink-2">
              Reporting starts once the state registry connection is set up.
            </span>
          </span>
        )}
      </ConfirmDialog>
    </li>
  );
}
