import { toast } from "sonner";
import type { Condition, OrderCatalogItem } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { SearchCombobox, type SearchResult } from "@/components/ui/combobox";
import { Label } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { ORDER_INVALIDATES, CATEGORY_LABEL } from "./orderParts";

const S = "encounter.orders";
const CATEGORY: Record<string, "LAB" | "IMAGING" | "PROCEDURE" | "REFERRAL"> = {
  lab: "LAB",
  imaging: "IMAGING",
  procedure: "PROCEDURE",
  referral: "REFERRAL",
};
const CODE_SYSTEM = {
  LAB: "LOINC",
  IMAGING: "CPT",
  PROCEDURE: "CPT",
  REFERRAL: "SNOMEDCT",
} as const;

function useCatalog(q: string): SearchResult<OrderCatalogItem> {
  const r = useApi("searchOrderCatalog", { query: { q } }, { enabled: !!q, staleTime: 60_000 });
  return {
    items: (r.data ?? []).filter((i) => i.kind !== "order-set"),
    loading: r.isFetching,
    error: r.error ? errorMessage(r.error) : null,
  };
}

/** Left column of encounter.orders: order search, order sets, and the encounter's diagnoses. */
export function OrderCatalogPanel({
  patientId,
  encounterId,
  diagnoses,
  editable,
  onAddProblem,
}: {
  patientId: string;
  encounterId: string;
  diagnoses: Condition[];
  editable: boolean;
  onAddProblem: () => void;
}) {
  const { can } = useAuth();
  const sets = useApi("listOrderSets");
  const create = useApiMutation("createServiceRequest", {
    invalidates: ORDER_INVALIDATES,
    onSuccess: (o) => toast(`${o.display} added to this visit's orders.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const apply = useApiMutation("applyOrderSet", {
    invalidates: ORDER_INVALIDATES,
    onSuccess: (list) => toast(`${list.length} orders added from the set.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const add = (item: OrderCatalogItem | null) => {
    const category = item && CATEGORY[item.kind];
    if (!item || !category) return;
    create.mutate({
      params: { encounterId },
      body: {
        patientId,
        category,
        codeSystem: CODE_SYSTEM[category],
        code: item.code,
        display: item.display,
        ...(category === "LAB" ? { labCompendiumItemId: item.id } : {}),
        reasonConditionIds: [],
      },
    });
  };
  return (
    <div className="grid content-start gap-6" data-testid={tid(S, "catalog")}>
      {editable && can("createServiceRequest") ? (
        <div className="grid gap-1.5">
          <Label>Search orders</Label>
          <SearchCombobox<OrderCatalogItem>
            value={null}
            onChange={add}
            useSearch={useCatalog}
            itemKey={(i) => `${i.kind}:${i.id}`}
            ariaLabel="Search orders"
            placeholder="Lab, imaging, referral, procedure"
            testId={tid(S, "order-search")}
            renderItem={(i) => (
              <span className="flex items-baseline justify-between gap-3">
                <span>{i.display}</span>
                <span className="shrink-0 text-small text-ink-2">
                  {CATEGORY_LABEL[CATEGORY[i.kind] ?? "OTHER"]}
                  {i.lab ? ` · ${i.lab[0]}${i.lab.slice(1).toLowerCase()}` : ""}
                  {i.aoe.length ? " · questions" : ""}
                </span>
              </span>
            )}
            renderValue={(i) => i.display}
          />
        </div>
      ) : null}
      {editable && can("applyOrderSet") ? (
        <section className="grid gap-2" data-testid={tid(S, "order-sets")}>
          <h4 className="text-caption uppercase text-ink-2">Order sets</h4>
          {(sets.data ?? []).length ? (
            sets.data!.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <span className="text-body">{s.name}</span>
                <Button
                  size="sm"
                  disabled={apply.isPending}
                  data-testid={tid(S, "order-set")}
                  onClick={() => apply.mutate({ params: { encounterId, orderSetId: s.id } })}
                >
                  Add set
                </Button>
              </div>
            ))
          ) : (
            <p className="text-small text-ink-2">No order sets yet.</p>
          )}
        </section>
      ) : null}
      <section className="grid gap-2" data-testid={tid(S, "encounter-dx")}>
        <h4 className="text-caption uppercase text-ink-2">Encounter diagnoses</h4>
        {diagnoses.length ? (
          <ul className="grid gap-1 text-body">
            {diagnoses.map((d) => (
              <li key={d.id}>
                <span className="tabular-nums text-ink-2">{d.icd10Code}</span> {d.display}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-ink-2">None on this visit yet.</p>
        )}
        {editable ? (
          <Button size="sm" className="justify-self-start" onClick={onAddProblem}>
            + Add problem
          </Button>
        ) : null}
      </section>
      {create.isPending ? <Tag tone="outline">Adding…</Tag> : null}
    </div>
  );
}
