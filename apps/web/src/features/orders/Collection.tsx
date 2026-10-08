import * as React from "react";
import { toast } from "sonner";
import type { CollectionItem } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { formatDate, formatShortDate, pluralize, todayIso } from "@/lib/format";
import { useView } from "@/lib/useView";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/domain/StatusChip";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Card, CardHeader, LoadingRows } from "@/components/ui/layout";
import { Checkbox, Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { InboxLayout } from "@/features/inbox/InboxLayout";
import { Pressable } from "@/components/ui/pressable";

const S = "orders.collection";

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** orders.collection: signed in-office lab orders needing a specimen (flow:results/02). */
export function CollectionPage() {
  const v = useView();
  const [date, setDate] = React.useState(todayIso());
  const q = useApi("listCollectionQueue", { query: { date } }, { refetchInterval: 60_000 });
  const items = q.data?.data ?? [];
  const groups = React.useMemo(() => {
    const m = new Map<string, CollectionItem[]>();
    for (const i of items) m.set(i.patient.id, [...(m.get(i.patient.id) ?? []), i]);
    return [...m.values()];
  }, [items]);
  const selected = groups.find((g) => g[0]!.patient.id === v.id) ?? groups[0] ?? null;
  return (
    <InboxLayout counts={{ "orders.collection": items.length }}>
      <Card className="p-0" data-testid={tid(S, "col-item")}>
        <h2 className="px-5 pb-2 pt-5 text-h3">Specimens to collect</h2>
        <div className="px-5 pb-3">
          <DateInput
            value={date}
            onChange={(d) => d && setDate(d)}
            aria-label="Collection date"
            fromYear={2020}
          />
        </div>
        {q.isLoading ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : null}
        {!q.isLoading && !groups.length ? (
          <p className="px-5 pb-5 text-body text-ink-2">No specimens waiting.</p>
        ) : null}
        <ul>
          {groups.map((g) => {
            const p = g[0]!.patient;
            return (
              <li key={p.id}>
                <Pressable
                  type="button"
                  onClick={() => v.open("patient", p.id)}
                  className={cn(
                    "grid w-full gap-0.5 px-5 py-3 text-left hover:bg-surface-hover",
                    selected?.[0]?.patient.id === p.id && "bg-pine-50",
                  )}
                >
                  <b className="font-semibold">{p.name}</b>
                  <span className="text-small tabular-nums text-ink-2">
                    DOB {formatDate(p.birthDate)} · MRN {p.mrn}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-small text-ink-2">
                    {g.map((i) => i.serviceRequest.display).join(", ")}
                    {g.some((i) => i.fasting) ? <Tag tone="caution">Fasting</Tag> : null}
                  </span>
                </Pressable>
              </li>
            );
          })}
        </ul>
      </Card>
      {selected ? <CollectDetail key={selected[0]!.patient.id} group={selected} /> : <span />}
    </InboxLayout>
  );
}

const SPECIMEN_TYPES = ["Serum", "Whole blood", "Plasma", "Urine", "Swab"].map((t) => ({
  value: t,
  label: t,
}));

function CollectDetail({ group }: { group: CollectionItem[] }) {
  const p = group[0]!.patient;
  const [picked, setPicked] = React.useState<Set<string>>(
    () => new Set(group.map((i) => i.serviceRequest.id)),
  );
  const [confirmed, setConfirmed] = React.useState(false);
  const [at, setAt] = React.useState(localNow());
  const [type, setType] = React.useState("Serum");
  const [container, setContainer] = React.useState("");
  const [printLabels, setPrintLabels] = React.useState(true);
  const ids = group.map((i) => i.serviceRequest.id).filter((id) => picked.has(id));
  const rec = useApiMutation("recordSpecimenCollection", {
    invalidates: ["listCollectionQueue", "getClinicalDayList"],
    onSuccess: () => toast(`${pluralize(ids.length, "order")} marked collected.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const print = async (kind: "getSpecimenLabels" | "getRequisition") => {
    try {
      for (const id of ids)
        openBlob((await api(kind, { params: { serviceRequestId: id } })) as unknown as Blob);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <Card data-testid={tid(S, "col-patient")}>
      <CardHeader title={p.name} />
      <p className="mb-4 text-small tabular-nums text-ink-2">
        DOB {formatDate(p.birthDate)} · MRN {p.mrn}
      </p>
      <div className="grid gap-5">
        <ul className="grid gap-2" data-testid={tid(S, "col-tests")}>
          {group.map((i) => (
            <li key={i.serviceRequest.id} className="flex items-start gap-3">
              <Checkbox
                checked={picked.has(i.serviceRequest.id)}
                onCheckedChange={(c) => toggle(i.serviceRequest.id, c === true)}
                aria-label={`Collect ${i.serviceRequest.display}`}
              />
              <span className="grid gap-0.5 text-body">
                <span className="flex items-center gap-2">
                  <b className="font-semibold">{i.serviceRequest.display}</b>
                  <StatusChip machine="order" value={i.serviceRequest.status} />
                  {i.fasting ? <Tag tone="caution">Fasting</Tag> : null}
                </span>
                <span className="text-small text-ink-2">
                  {[
                    i.tube,
                    i.serviceRequest.performerLab,
                    i.serviceRequest.placerOrderNumber &&
                      `Order ${i.serviceRequest.placerOrderNumber}`,
                    i.dueAt && `Due ${formatShortDate(i.dueAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!ids.length}
            onClick={() => void print("getSpecimenLabels")}
            data-testid={tid(S, "col-labels")}
          >
            Print labels
          </Button>
          <Button
            size="sm"
            disabled={!ids.length}
            onClick={() => void print("getRequisition")}
            data-testid={tid(S, "col-requisition")}
          >
            Print requisition
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldShell label="Collected at" htmlFor="col-time">
            <Input
              id="col-time"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              data-testid={tid(S, "col-time")}
            />
          </FieldShell>
          <FieldShell label="Specimen type" htmlFor="col-type">
            <Select id="col-type" value={type} onValueChange={setType} options={SPECIMEN_TYPES} />
          </FieldShell>
          <FieldShell label="Container" htmlFor="col-container">
            <Input
              id="col-container"
              value={container}
              onChange={(e) => setContainer(e.target.value)}
            />
          </FieldShell>
        </div>
        <Checkbox
          checked={printLabels}
          onCheckedChange={(c) => setPrintLabels(c === true)}
          label="Print labels when recording"
        />
        <Checkbox
          checked={confirmed}
          onCheckedChange={(c) => setConfirmed(c === true)}
          label={`I confirmed the patient is ${p.name}, born ${formatDate(p.birthDate)}.`}
          id="col-confirm"
        />
        {rec.error ? <Alert tone="caution">{errorMessage(rec.error)}</Alert> : null}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!ids.length || !confirmed || !at || rec.isPending}
            onClick={() =>
              rec.mutate({
                params: { serviceRequestId: ids[0]! },
                body: {
                  serviceRequestIds: ids,
                  collectedAt: new Date(at).toISOString(),
                  type,
                  container: container.trim() || undefined,
                  printLabels,
                },
              })
            }
            data-testid={tid(S, "col-done")}
          >
            Mark collected
          </Button>
        </div>
      </div>
    </Card>
  );
}
