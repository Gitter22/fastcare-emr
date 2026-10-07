import * as React from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { fromCents, toCents, type ConsentType } from "@agile-emr/shared";
import { tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { ageSex, formatDate, formatDateTime, formatTime, money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldShell } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, Field, LoadingRows } from "@/components/ui/layout";
import { Checkbox, RadioGroup } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tag } from "@/components/ui/tag";
import { EligibilityChip } from "@/components/domain/Eligibility";

const S = "home.frontdesk-board";
const REQUIRED: Array<{ type: ConsentType; label: string }> = [
  { type: "NOTICE_OF_PRIVACY_PRACTICES", label: "Notice of privacy practices" },
  { type: "FINANCIAL_POLICY", label: "Financial policy" },
];
type PayMethod = "card-on-file" | "terminal" | "cash" | "check" | "later";

/**
 * home.frontdesk-board#arrive (flow:checkin/01): verify photo ID and insurance, sign outstanding consents, collect
 * copay and prior balance, then arrive. A declined payment still arrives the patient and leaves the balance.
 */
export function ArriveDrawer({
  appointmentId,
  onClose,
}: {
  appointmentId: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!appointmentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="w-[600px]" data-testid={`${S}#arrive`}>
        {appointmentId ? <ArriveForm appointmentId={appointmentId} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ArriveForm({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const detail = useApi("getAppointment", { params: { appointmentId } });
  const a = detail.data?.appointment;
  const coverages = useApi(
    "listCoverages",
    { params: { patientId: a?.patient.id ?? "" } },
    { enabled: !!a },
  );
  const consents = useApi(
    "listConsents",
    { params: { patientId: a?.patient.id ?? "" } },
    { enabled: !!a },
  );
  const cards = useApi(
    "listPaymentMethods",
    { params: { patientId: a?.patient.id ?? "" } },
    { enabled: !!a },
  );
  const [idOk, setIdOk] = React.useState(false);
  const [signed, setSigned] = React.useState<ConsentType[]>([]);
  const [method, setMethod] = React.useState<PayMethod>("cash");
  const [checkNumber, setCheckNumber] = React.useState("");
  const [receipt, setReceipt] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const receiptSend = useApiMutation("sendPaymentReceipt");
  const idemKey = React.useMemo(() => crypto.randomUUID(), []);
  const recheck = useApiMutation("checkEligibility", {
    invalidates: ["listCoverages", "getAppointment", "getFrontDeskBoard"],
    onError: (e) => toast(errorMessage(e)),
  });
  const arrive = useApiMutation("arriveAppointment", {
    invalidates: [
      "getFrontDeskBoard",
      "getFlowBoard",
      "listAppointments",
      "getAppointment",
      "getPatientBanner",
    ],
    onSuccess: (r) => {
      for (const w of r.warnings) toast(w);
      toast(`${r.appointment.patient.name} arrived. The care team was notified.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  React.useEffect(() => {
    if (cards.data?.length) setMethod("card-on-file");
  }, [cards.data]);

  if (detail.isLoading || !a)
    return (
      <SheetBody className="pt-6">
        <LoadingRows />
      </SheetBody>
    );
  const primary = coverages.data?.find((c) => c.status === "active");
  const elig = primary?.lastEligibility;
  const missing = REQUIRED.filter(
    (r) => !consents.data?.some((c) => c.type === r.type && c.status === "ACTIVE" && !c.revokedAt),
  );
  const copay = toCents(a.copayDue);
  const prior = Math.max(0, toCents(a.balanceDue));
  const total = copay + prior;
  const allSigned = missing.every((m) => signed.includes(m.type));
  const card = cards.data?.[0];

  const submit = async () => {
    setError(null);
    const pay =
      total > 0 && method !== "later"
        ? {
            amount: fromCents(total),
            method:
              method === "card-on-file"
                ? ("CARD" as const)
                : method === "check"
                  ? ("CHECK" as const)
                  : ("CASH" as const),
            ...(method === "card-on-file" && card ? { paymentMethodId: card.id } : {}),
            ...(method === "check" && checkNumber ? { checkNumber } : {}),
            idempotencyKey: idemKey,
          }
        : undefined;
    const r = await arrive
      .mutateAsync({
        params: { appointmentId },
        body: {
          version: a.version,
          identityVerified: idOk,
          coverageVerified: elig?.status === "ACTIVE",
          consentsSigned: signed,
          ...(pay ? { copayCollected: pay } : {}),
        },
      })
      .catch(() => null);
    // Receipt by text (no clinical detail, INV-SEC-06); the server falls back to email without SMS consent.
    if (r?.paymentId && receipt)
      receiptSend.mutate({ params: { paymentId: r.paymentId }, body: { channel: "SMS" } });
  };

  return (
    <>
      <SheetHeader>
        <span className="text-small text-ink-2">Arrive patient</span>
        <SheetTitle data-testid={tid(S, "arrive-patient")}>{a.patient.name}</SheetTitle>
        <p className="text-small tabular-nums text-ink-2">
          DOB {formatDate(a.patient.birthDate)} ·{" "}
          {ageSex(a.patient.birthDate, a.patient.sexForClinicalUse)} · MRN {a.patient.mrn}
        </p>
        <p className="text-body text-ink">
          {formatTime(a.start)} · {a.visitType.name} · {a.practitioner.name} · {a.location.name}
        </p>
      </SheetHeader>
      <SheetBody className="grid content-start gap-6">
        {error ? <Alert tone="caution">{error}</Alert> : null}
        <Section n={1} done={idOk} title="Identity" note="Required">
          <Checkbox
            checked={idOk}
            onCheckedChange={(c) => setIdOk(c === true)}
            label="Photo ID matches the patient in person"
            data-testid={tid(S, "id-verified")}
          />
        </Section>
        <Section
          n={2}
          done={elig?.status === "ACTIVE"}
          title="Insurance"
          action={
            primary ? (
              <Button
                size="sm"
                variant="ghost"
                loading={recheck.isPending}
                onClick={() => recheck.mutate({ params: { coverageId: primary.id }, body: {} })}
                data-testid={tid(S, "ins-recheck")}
              >
                Re-check eligibility
              </Button>
            ) : null
          }
        >
          {primary ? (
            <div className="grid gap-3">
              <p className="text-body">
                <span className="font-semibold">{primary.plan?.name ?? primary.payer.name}</span> ·
                Primary · Member {primary.memberId}
              </p>
              <dl
                className="grid grid-cols-3 gap-4 bg-surface-muted p-4"
                data-testid={tid(S, "ins-result")}
              >
                <Field label="Status">
                  <EligibilityChip status={elig?.status} />
                </Field>
                <Field label="Office copay">
                  {elig?.copay ? <span className="tabular-nums">{money(elig.copay)}</span> : "—"}
                </Field>
                <Field label="Deductible left">
                  {elig?.deductibleRemaining ? (
                    <span className="tabular-nums">{money(elig.deductibleRemaining)}</span>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="Checked" className="col-span-3">
                  {elig?.respondedAt ? formatDateTime(elig.respondedAt) : "Not checked yet"}
                </Field>
              </dl>
            </div>
          ) : (
            <p className="text-body text-ink">
              No insurance on file. The visit is self-pay unless coverage is added.
            </p>
          )}
        </Section>
        <Section
          n={3}
          done={allSigned}
          title="Forms and consents"
          action={missing.length ? <Tag tone="caution">{missing.length} to sign</Tag> : null}
        >
          <ul className="grid gap-3">
            {REQUIRED.map((r) => {
              const has = consents.data?.find(
                (c) => c.type === r.type && c.status === "ACTIVE" && !c.revokedAt,
              );
              return (
                <li
                  key={r.type}
                  className="flex items-center justify-between gap-3"
                  data-testid={tid(S, "form-row")}
                >
                  <span className={has ? "text-body text-ink" : "text-body font-semibold text-ink"}>
                    {r.label}
                  </span>
                  {has ? (
                    <span className="text-small text-ink-2">
                      Signed {has.signedAt ? formatDate(has.signedAt.slice(0, 10)) : ""}
                    </span>
                  ) : (
                    <Checkbox
                      label="Signed on tablet now"
                      checked={signed.includes(r.type)}
                      onCheckedChange={(c) =>
                        setSigned((s) => (c ? [...s, r.type] : s.filter((x) => x !== r.type)))
                      }
                      data-testid={tid(S, "form-sign-tablet")}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
        <Section n={4} done={false} title="Payment">
          <ul className="grid gap-2 text-body" data-testid={tid(S, "pay-lines")}>
            <li className="flex justify-between">
              <span>Copay today</span>
              <span className="tabular-nums">{money(fromCents(copay))}</span>
            </li>
            <li className="flex justify-between">
              <span>Prior balance</span>
              <span className="tabular-nums">{money(fromCents(prior))}</span>
            </li>
            <li className="flex justify-between font-semibold">
              <span>Collect now</span>
              <span className="tabular-nums">{money(fromCents(total))}</span>
            </li>
          </ul>
          {total > 0 ? (
            <div className="mt-4 grid gap-3">
              <RadioGroup<PayMethod>
                orientation="vertical"
                testId={tid(S, "pay-method")}
                value={method}
                onValueChange={setMethod}
                options={[
                  ...(card
                    ? [
                        {
                          value: "card-on-file" as const,
                          label: `${card.brand} ending ${card.last4} (on file)`,
                        },
                      ]
                    : []),
                  {
                    value: "terminal" as PayMethod,
                    label: "Card terminal · available once the card processor is connected",
                    disabled: true,
                  },
                  { value: "cash", label: "Cash" },
                  { value: "check", label: "Check" },
                  { value: "later", label: "Collect later" },
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
              {method !== "later" ? (
                <Checkbox
                  checked={receipt}
                  onCheckedChange={(c) => setReceipt(c === true)}
                  label="Text a receipt"
                  data-testid={tid(S, "pay-receipt")}
                />
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-body text-ink-2">Nothing to collect today.</p>
          )}
        </Section>
      </SheetBody>
      <SheetFooter>
        <span className="mr-auto text-small text-ink-2">
          Status after arrive: Arrived · care team notified
        </span>
        <Button variant="ghost" onClick={onClose} data-testid={tid(S, "arrive-cancel")}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!idOk}
          loading={arrive.isPending}
          onClick={() => void submit()}
          data-testid={tid(S, "arrive-submit")}
        >
          {total > 0 && method !== "later"
            ? `Collect ${money(fromCents(total))} & arrive`
            : "Arrive"}
        </Button>
      </SheetFooter>
    </>
  );
}

function Section({
  n,
  title,
  done,
  note,
  action,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div className="flex items-center gap-3">
        <span
          className={
            done
              ? "grid size-7 place-items-center rounded-full bg-pine-600 text-on-primary"
              : "grid size-7 place-items-center rounded-full text-caption shadow-[inset_0_0_0_1.5px_var(--color-ink-2)]"
          }
        >
          {done ? <Check size={16} strokeWidth={2} aria-label="Done" /> : n}
        </span>
        <h3 className="text-h3 text-ink">{title}</h3>
        <span className="ml-auto flex items-center gap-2">
          {note ? <span className="text-small text-ink-2">{note}</span> : null}
          {action}
        </span>
      </div>
      <div className="pl-10">{children}</div>
    </section>
  );
}
