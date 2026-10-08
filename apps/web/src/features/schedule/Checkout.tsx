import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { fromCents, toCents } from "@agile-emr/shared";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import {
  addDaysIso,
  formatDateTime,
  formatShortDate,
  formatTime,
  money,
  todayIso,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
} from "@/components/ui/layout";
import { RadioGroup, Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { StatusChip } from "@/components/domain/StatusChip";
import { AvsPreview, printAvs } from "@/features/encounter/AvsPage";
import { ChartLayout } from "@/shell/ChartLayout";

const S = "schedule.checkout";
type PayMethod = "cash" | "check" | "terminal" | "none";

/** "Return in 4 weeks" -> days from today (null when the instruction has no interval). */
export function followUpDays(text: string | undefined): number | null {
  const m = /(\d+)\s*(day|week|wk|month|mo)/i.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return /^d/i.test(m[2]!) ? n : /^w/i.test(m[2]!) ? n * 7 : n * 30;
}

/** schedule.checkout (flow:encounter/08): close the visit with the patient present. */
export function CheckoutPage() {
  const { appointmentId = "" } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const navigate = useNavigate();
  const co = useApi("getCheckout", { params: { appointmentId } });
  const visitTypes = useApi("listVisitTypes");
  const c = co.data;
  const a = c?.appointment;
  const fu = c?.followUps[0];
  const days = followUpDays(fu?.text);
  const followType =
    visitTypes.data?.find((v) => v.id === fu?.visitTypeId) ??
    visitTypes.data?.find((v) => v.name === "Follow-up");
  const from =
    days != null ? addDaysIso(todayIso(), Math.max(1, days - 3)) : addDaysIso(todayIso(), 1);
  const slots = useApi(
    "searchAvailability",
    {
      query: {
        visitTypeId: followType?.id,
        practitionerId: a?.practitioner.id,
        locationId: a?.location.id,
        fromDate: from,
        toDate: addDaysIso(from, 14),
      },
    },
    { enabled: !!a && !!followType && !!fu },
  );
  const sameTime = (s: { start: string }) => a && formatTime(s.start) === formatTime(a.start);
  const suggested = React.useMemo(() => {
    const all = slots.data?.slots ?? [];
    const first = all.find(sameTime);
    const rest = all.filter((s) => s !== first);
    const picks = [first, ...rest].filter(Boolean) as typeof all;
    // Different days first so the patient gets real choices.
    const out: typeof all = [];
    for (const s of picks)
      if (!out.some((o) => o.start.slice(0, 10) === s.start.slice(0, 10)) && out.length < 3)
        out.push(s);
    return out;
  }, [slots.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [slot, setSlot] = React.useState<string | null>(null);
  React.useEffect(() => setSlot((s) => s ?? suggested[0]?.start ?? null), [suggested]);
  const [method, setMethod] = React.useState<PayMethod>("cash");
  const [checkNumber, setCheckNumber] = React.useState("");
  const [language, setLanguage] = React.useState<string | null>(null);
  const [left, setLeft] = React.useState(false);
  const avsUpdate = useApiMutation("updateAfterVisitSummary", {
    invalidates: ["getCheckout"],
    onError: (e) => toast.error(errorMessage(e)),
  });
  const release = useApiMutation("releaseAfterVisitSummary", { invalidates: ["getCheckout"] });
  const complete = useApiMutation("completeCheckout", {
    invalidates: ["getFrontDeskBoard", "getFlowBoard", "getCheckout", "getPatientSummary"],
    onSuccess: () => {
      toast("Checkout complete.");
      navigate(
        isBuilt("home.frontdesk-board")
          ? pathTo("home.frontdesk-board")
          : pathTo("schedule.flow-board"),
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (co.error)
    return (
      <Page>
        <ErrorState message={errorMessage(co.error)} onRetry={() => void co.refetch()} />
      </Page>
    );
  if (!c || !a)
    return (
      <Page>
        <LoadingRows rows={8} />
      </Page>
    );
  const due = toCents(c.balance.patientDue);
  const chosen = suggested.find((s) => s.start === slot) ?? null;
  const avs = c.avs;

  const finish = (opts: { leftEarly?: boolean }) =>
    complete.mutate({
      params: { appointmentId },
      body: {
        version: a.version,
        ...(!opts.leftEarly && chosen && followType
          ? {
              followUpAppointment: {
                patientId: a.patient.id,
                visitTypeId: followType.id,
                practitionerId: chosen.practitionerId,
                locationId: chosen.locationId,
                start: chosen.start,
                modality: chosen.modality,
              },
            }
          : {}),
        ...(!opts.leftEarly && due > 0 && (method === "cash" || method === "check")
          ? {
              payment: {
                patientId: a.patient.id,
                amount: fromCents(due),
                method: method === "check" ? "CHECK" : "CASH",
                ...(method === "check" && checkNumber ? { checkNumber } : {}),
                idempotencyKey: `checkout-${appointmentId}`,
              },
            }
          : {}),
        avsDelivery: opts.leftEarly ? ["portal"] : ["print", "portal"],
      },
    });
  const completeLabel = chosen
    ? `Book ${formatShortDate(chosen.start)} & complete checkout`
    : "Complete checkout";

  return (
    <ChartLayout patientId={a.patient.id} compactNav>
      <Page>
        <PageHeader
          title="Checkout"
          crumbs={
            isBuilt("schedule.flow-board")
              ? [{ label: "Flow board", to: pathTo("schedule.flow-board") }, { label: "Checkout" }]
              : []
          }
          testId={tid(S, "checkout-title")}
        />
        <div className="-mt-3 flex flex-wrap items-center gap-2 text-body text-ink-2">
          {a.visitType.name} with {a.practitioner.name} · {formatTime(a.start)} ·
          <StatusChip machine="appointment" value={a.status} testId={tid(S, "checkout-status")} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader
                title="Book follow-up"
                actions={
                  fu ? (
                    <span className="text-body" data-testid={tid(S, "fu-request")}>
                      Provider asked: <b>{fu.text}</b>
                    </span>
                  ) : (
                    <span className="text-body text-ink-2">No follow-up requested</span>
                  )
                }
              />
              {fu ? (
                <div className="grid grid-cols-4 gap-3">
                  {suggested.map((s) => (
                    <button
                      key={s.start}
                      type="button"
                      aria-pressed={slot === s.start}
                      onClick={() => setSlot(slot === s.start ? null : s.start)}
                      className={cn(
                        "grid gap-0.5 bg-surface p-4 text-left shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-surface-hover",
                        slot === s.start && "shadow-[inset_0_0_0_2px_var(--color-ink)]",
                      )}
                      data-testid={tid(S, "fu-slot")}
                    >
                      <b className="font-semibold">
                        {new Date(s.start).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </b>
                      <span className="tabular-nums">
                        {formatTime(s.start)} · {s.practitionerName}
                      </span>
                      {sameTime(s) ? (
                        <span className="text-small text-ink-2">Same time as today</span>
                      ) : null}
                    </button>
                  ))}
                  {slots.isLoading ? <LoadingRows rows={2} /> : null}
                  {isBuilt("schedule.booking-drawer") ? (
                    <button
                      type="button"
                      className="grid gap-0.5 bg-surface p-4 text-left shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-surface-hover"
                      onClick={() =>
                        navigate(
                          pathTo("schedule.booking-drawer", {}, undefined, {
                            patientId: a.patient.id,
                          }),
                        )
                      }
                      data-testid={tid(S, "fu-other")}
                    >
                      <b className="font-semibold">Other time…</b>
                      <span className="text-ink-2">Open calendar</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {fu && !slots.isLoading && !suggested.length ? (
                <p className="mt-3 text-body text-ink-2">
                  No open times near that date. Use Other time.
                </p>
              ) : null}
            </Card>
            <Card data-testid={tid(S, "coord-item")}>
              <CardHeader
                title="Orders and referrals to coordinate"
                actions={<span className="text-small text-ink-2">From this visit</span>}
              />
              {c.ordersToSchedule.length || c.referrals.length ? null : (
                <p className="text-body text-ink-2">Nothing to coordinate from this visit.</p>
              )}
            </Card>
          </div>
          <div className="grid gap-6">
            <Card data-testid={tid(S, "avs-preview")}>
              <CardHeader
                title="After-visit summary"
                actions={avs?.releasedAt ? <Tag>Released to portal</Tag> : null}
              />
              {avs ? (
                <>
                  <div className="max-h-72 overflow-y-auto bg-surface-muted p-4">
                    <AvsPreview avs={avs} />
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <Button
                      onClick={() => void printAvs(avs.encounterId)}
                      data-testid={tid(S, "avs-print")}
                    >
                      Print
                    </Button>
                    {can("updateAfterVisitSummary") && !avs.releasedAt ? (
                      <Select
                        aria-label="Language"
                        value={language ?? avs.language}
                        onValueChange={(l) => (
                          setLanguage(l),
                          avsUpdate.mutate({
                            params: { encounterId: avs.encounterId },
                            body: { language: l },
                          })
                        )}
                        testId={tid(S, "avs-language")}
                        className="w-40"
                        options={[
                          { value: "en", label: "English" },
                          { value: "es", label: "Spanish" },
                        ]}
                      />
                    ) : (
                      <span className="text-body text-ink-2" data-testid={tid(S, "avs-language")}>
                        Language: {avs.language === "es" ? "Spanish" : "English"}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-body text-ink-2">Ready once the provider signs the note.</p>
              )}
            </Card>
            <Card data-testid={tid(S, "pay-summary")}>
              <CardHeader title="Payment" />
              <dl className="grid gap-2 text-body">
                <div className="flex justify-between">
                  <dt>Insurance pending</dt>
                  <dd className="tabular-nums">{money(c.balance.insurancePending)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Due now</dt>
                  <dd className="tabular-nums">{money(c.balance.patientDue)}</dd>
                </div>
              </dl>
              {due > 0 && can("createPayment") ? (
                <div className="mt-4 grid gap-3" data-testid={tid(S, "pay-collect")}>
                  <RadioGroup<PayMethod>
                    orientation="vertical"
                    value={method}
                    onValueChange={setMethod}
                    options={[
                      {
                        value: "terminal",
                        label: "Card terminal · available once the card processor is connected",
                        disabled: !me.connectedGateways.includes("PaymentGateway"),
                      },
                      { value: "cash", label: "Cash" },
                      { value: "check", label: "Check" },
                      { value: "none", label: "Bill later" },
                    ]}
                  />
                  {method === "check" ? (
                    <FieldShell label="Check number">
                      <Input
                        value={checkNumber}
                        onChange={(e) => setCheckNumber(e.target.value)}
                        className="max-w-48 tabular-nums"
                      />
                    </FieldShell>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-small text-ink-2">
                  Any remaining balance is billed after insurance pays.
                </p>
              )}
            </Card>
          </div>
        </div>
        <div className="sticky bottom-0 -mx-8 flex items-center gap-3 bg-surface px-8 py-3 shadow-sticky">
          <span className="mr-auto text-body text-ink-2">
            Completing sets the appointment to <b>Completed</b>. If the patient has left, the AVS
            stays in the portal.
            {avs?.releasedAt ? ` Released ${formatDateTime(avs.releasedAt)}.` : ""}
          </span>
          {a.status === "CHECKOUT" && can("completeCheckout") ? (
            <>
              <Button
                variant="ghost"
                onClick={() => setLeft(true)}
                data-testid={tid(S, "left-before-checkout")}
              >
                Patient left before checkout
              </Button>
              <Button
                variant="primary"
                disabled={complete.isPending || (due > 0 && method === "terminal")}
                onClick={() => finish({})}
                data-testid={tid(S, "checkout-complete")}
              >
                {due > 0 && (method === "cash" || method === "check")
                  ? `Collect ${money(fromCents(due))} · `
                  : ""}
                {completeLabel}
              </Button>
            </>
          ) : null}
        </div>
        <ConfirmDialog
          open={left}
          onOpenChange={setLeft}
          title="Complete checkout without the patient?"
          description="The after-visit summary is released to the patient portal and the visit is completed. No follow-up is booked and nothing is collected."
          action="Complete checkout"
          onConfirm={() =>
            avs && !avs.releasedAt
              ? release.mutate(
                  { params: { encounterId: avs.encounterId } },
                  {
                    onSuccess: () => finish({ leftEarly: true }),
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              : finish({ leftEarly: true })
          }
        />
      </Page>
    </ChartLayout>
  );
}
