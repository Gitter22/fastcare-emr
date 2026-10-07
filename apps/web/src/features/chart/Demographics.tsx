import * as React from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import type { CoverageView, PatientDetail } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { enumLabel, formatDate, formatDateTime, money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  applyServerErrors,
  DateField,
  FieldShell,
  SelectField,
  TextField,
  useZodForm,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Alert,
  Card,
  CardHeader,
  Field,
  LoadingRows,
  Page,
  PageHeader,
} from "@/components/ui/layout";
import { Select } from "@/components/ui/select";
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
import {
  ADMIN_GENDER,
  ETHNICITY,
  GENDER_IDENTITY,
  LANGUAGES,
  PRONOUNS,
  RACE,
  RELATIONSHIPS,
  SEXUAL_ORIENTATION,
  SEX_CLINICAL,
} from "@/features/patients/registrationSchema";

const S = "chart.demographics";
const label = (list: Array<{ value: string; label: string }>, v?: string | null) =>
  v ? (list.find((x) => x.value === v)?.label ?? v) : "—";

/** chart.demographics: demographics, contacts, guarantor and coverage for one patient. */
export function DemographicsPage() {
  const { patientId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const patient = useApi("getPatient", { params: { patientId } });
  const coverages = useApi("listCoverages", { params: { patientId } });
  const [editing, setEditing] = React.useState(false);
  const p = patient.data;
  const coverageView = params.get("view") === "coverage";
  const coverageId = params.get("coverage");

  if (patient.isLoading || !p)
    return (
      <Page>
        <LoadingRows />
      </Page>
    );
  const phone = p.contactPoints.find((c) => c.system === "PHONE" || c.system === "SMS");
  const email = p.contactPoints.find((c) => c.system === "EMAIL");
  const addr = p.addresses[0];
  return (
    <Page>
      <PageHeader title="Demographics" />
      <div className="grid grid-cols-2 items-start gap-6">
        <Card data-testid={tid(S, "demo-identity")}>
          <CardHeader
            title="Identity and contact"
            actions={
              can("updatePatient") ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              ) : null
            }
          />
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Legal name">
              {[p.firstName, p.middleName, p.lastName, p.suffix].filter(Boolean).join(" ")}
            </Field>
            <Field label="Preferred name">{p.preferredName ?? "—"}</Field>
            <Field label="Date of birth">
              <span className="tabular-nums">{formatDate(p.birthDate)}</span>
            </Field>
            <Field label="Sex for clinical use">
              {label([...SEX_CLINICAL], p.sexForClinicalUse)}
            </Field>
            <Field label="Mobile">
              {phone ? (
                <span className="tabular-nums">
                  {phone.value}
                  {phone.smsOptOut ? " · texts opted out" : ""}
                </span>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Email">{email?.value ?? "—"}</Field>
            <Field label="Address" className="col-span-2">
              {addr
                ? `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""}, ${addr.city}, ${addr.state} ${addr.postalCode}`
                : "—"}
            </Field>
            <Field label="MRN">
              <span className="tabular-nums">{p.mrn}</span>
            </Field>
            <Field label="Administrative gender">
              {label([...ADMIN_GENDER], p.administrativeGender)}
            </Field>
          </dl>
        </Card>
        <Card data-testid={tid(S, "demo-uscdi")}>
          <CardHeader title="Demographics" />
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Race">
              {p.raceCodes.length
                ? p.raceCodes.map((c) => label(RACE, c)).join(", ")
                : "Not recorded"}
            </Field>
            <Field label="Ethnicity">
              {p.ethnicityCodes.length
                ? p.ethnicityCodes.map((c) => label(ETHNICITY, c)).join(", ")
                : "Not recorded"}
            </Field>
            <Field label="Language">
              {label(LANGUAGES, p.preferredLanguage)}
              {p.interpreterNeeded ? " · interpreter needed" : ""}
            </Field>
            <Field label="Pronouns">{p.pronouns ?? "—"}</Field>
            <Field label="Gender identity">{label(GENDER_IDENTITY, p.genderIdentity)}</Field>
            <Field label="Sexual orientation">
              {label(SEXUAL_ORIENTATION, p.sexualOrientation)}
            </Field>
          </dl>
        </Card>
        <Card data-testid={tid(S, "demo-contacts")}>
          <CardHeader title="Guarantor and contacts" />
          {p.relatedPersons.length ? (
            <ul className="grid gap-3">
              {p.relatedPersons.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3">
                  <span className="grid">
                    <span className="font-semibold">
                      {r.firstName} {r.lastName}
                    </span>
                    <span className="text-small text-ink-2">
                      {label(RELATIONSHIPS, r.relationship)}
                      {r.phone ? ` · ${r.phone}` : ""}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    {r.isGuarantor ? <Tag tone="active">Guarantor</Tag> : null}
                    {r.isEmergencyContact ? <Tag tone="outline">Emergency contact</Tag> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-ink">
              The patient is their own guarantor. No emergency contact on file.
            </p>
          )}
        </Card>
        <Card data-testid={tid(S, "demo-pharmacy")}>
          <CardHeader
            title="Preferred pharmacy"
            actions={
              <Button
                size="sm"
                disabled
                title="Pharmacy search needs the e-prescribing network (ErxGateway, OPEN-Q2)"
              >
                Change
              </Button>
            }
          />
          {p.preferredPharmacy ? (
            <p className="text-body">{p.preferredPharmacy.name}</p>
          ) : (
            <p className="text-body text-ink">None on file.</p>
          )}
          <p className="mt-2 text-small text-ink-2">
            Pharmacy search connects with the e-prescribing network.
          </p>
        </Card>
        <Card className="col-span-2" data-testid={tid(S, "demo-coverage")}>
          <CardHeader
            title="Insurance"
            actions={
              can("createCoverage") ? (
                <Button size="sm" onClick={() => setParams({ view: "coverage" })}>
                  Add insurance
                </Button>
              ) : null
            }
          />
          {coverages.isLoading ? <LoadingRows rows={2} /> : null}
          {coverages.data && !coverages.data.length ? (
            <p className="text-body text-ink">Self-pay. No insurance on file.</p>
          ) : null}
          <ul className="grid gap-4">
            {(coverages.data ?? []).map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-4">
                <div className="grid gap-0.5">
                  <span className="font-semibold">
                    {c.plan?.name ?? c.payer.name} ·{" "}
                    {c.order === 1 ? "Primary" : c.order === 2 ? "Secondary" : "Tertiary"}
                    {c.status !== "active" ? ` · ${enumLabel(c.status)}` : ""}
                  </span>
                  <span className="text-small tabular-nums text-ink-2">
                    Member {c.memberId}
                    {c.groupNumber ? ` · Group ${c.groupNumber}` : ""}
                    {c.periodEnd ? ` · ends ${formatDate(c.periodEnd)}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="grid justify-items-end gap-0.5">
                    <EligibilityChip status={c.lastEligibility?.status} />
                    <span className="text-small text-ink-2">
                      {c.lastEligibility
                        ? `Checked ${formatDateTime(c.lastEligibility.requestedAt)}${c.lastEligibility.copay ? ` · copay ${money(c.lastEligibility.copay)}` : ""}`
                        : "Not checked"}
                    </span>
                  </span>
                  {can("updateCoverage") ? (
                    <Button
                      size="sm"
                      onClick={() => setParams({ view: "coverage", coverage: c.id })}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="col-span-2" data-testid={tid(S, "demo-portal")}>
          <CardHeader title="Patient portal" />
          <p className="text-body">
            {
              (
                {
                  none: "No portal account yet.",
                  invited: "Invited. The patient hasn't activated the account.",
                  active: "Active.",
                  locked: "Locked after failed sign-ins.",
                } as const
              )[p.portalStatus]
            }
          </p>
        </Card>
      </div>
      <IdentityDialog
        open={editing}
        onOpenChange={setEditing}
        patient={p}
        onSaved={() => void patient.refetch()}
      />
      <CoverageDrawer
        open={coverageView}
        onClose={() => setParams({})}
        patientId={patientId}
        coverage={coverages.data?.find((c) => c.id === coverageId) ?? null}
      />
    </Page>
  );
}

const identitySchema = z.object({
  firstName: z.string().trim().min(1, "Enter the legal first name."),
  middleName: z.string().optional(),
  lastName: z.string().trim().min(1, "Enter the legal last name."),
  preferredName: z.string().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date of birth."),
  sexForClinicalUse: z.string().optional(),
  pronouns: z.string().optional(),
  preferredLanguage: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email("Enter a valid email.").optional().or(z.literal("")),
});

function IdentityDialog({
  open,
  onOpenChange,
  patient,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  patient: PatientDetail;
  onSaved: () => void;
}) {
  const phone = patient.contactPoints.find((c) => c.system === "PHONE" || c.system === "SMS");
  const email = patient.contactPoints.find((c) => c.system === "EMAIL");
  const form = useZodForm(identitySchema, {
    values: {
      firstName: patient.firstName,
      middleName: patient.middleName ?? "",
      lastName: patient.lastName,
      preferredName: patient.preferredName ?? "",
      birthDate: patient.birthDate,
      sexForClinicalUse: patient.sexForClinicalUse ?? "",
      pronouns: patient.pronouns ?? "",
      preferredLanguage: patient.preferredLanguage ?? "en",
      phone: phone?.value ?? "",
      email: email?.value ?? "",
    },
  });
  const [error, setError] = React.useState<string | null>(null);
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api("updatePatient", {
        params: { patientId: patient.id },
        version: patient.version,
        body: {
          firstName: v.firstName,
          middleName: v.middleName || null,
          lastName: v.lastName,
          preferredName: v.preferredName || null,
          birthDate: v.birthDate,
          ...(v.sexForClinicalUse ? { sexForClinicalUse: v.sexForClinicalUse as never } : {}),
          pronouns: v.pronouns || null,
          preferredLanguage: v.preferredLanguage || null,
        },
      });
      const others = patient.contactPoints.filter((c) => c !== phone && c !== email);
      const next = [
        ...(v.phone?.trim()
          ? [
              {
                patientId: patient.id,
                system: "PHONE" as const,
                use: "MOBILE" as const,
                value: v.phone.trim(),
                rank: 1,
                smsOptOut: phone?.smsOptOut ?? false,
              },
            ]
          : []),
        ...(v.email?.trim()
          ? [
              {
                patientId: patient.id,
                system: "EMAIL" as const,
                use: "HOME" as const,
                value: v.email.trim(),
                rank: 1,
              },
            ]
          : []),
        ...others.map((c) => ({
          patientId: patient.id,
          system: c.system,
          use: c.use ?? null,
          value: c.value,
          rank: c.rank,
          smsOptOut: c.smsOptOut,
        })),
      ];
      if ((v.phone ?? "") !== (phone?.value ?? "") || (v.email ?? "") !== (email?.value ?? ""))
        await api("replacePatientContactPoints", { params: { patientId: patient.id }, body: next });
      toast("Demographics saved.");
      onOpenChange(false);
      onSaved();
    } catch (e) {
      const rest = applyServerErrors(form, e);
      setError(rest[0] ?? errorMessage(e));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[640px]">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Edit identity and contact</DialogTitle>
          </DialogHeader>
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <div className="grid grid-cols-2 gap-4">
            <TextField form={form} name="firstName" label="Legal first name" required />
            <TextField form={form} name="lastName" label="Legal last name" required />
            <TextField form={form} name="middleName" label="Middle" />
            <TextField form={form} name="preferredName" label="Preferred name" />
            <DateField form={form} name="birthDate" label="Date of birth" required />
            <SelectField
              form={form}
              name="sexForClinicalUse"
              label="Sex for clinical use"
              options={[...SEX_CLINICAL]}
            />
            <SelectField form={form} name="pronouns" label="Pronouns" options={PRONOUNS} />
            <SelectField
              form={form}
              name="preferredLanguage"
              label="Language"
              options={LANGUAGES}
            />
            <TextField form={form} name="phone" label="Mobile phone" inputMode="tel" />
            <TextField form={form} name="email" label="Email" type="email" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** chart.demographics#coverage: add or update insurance, then verify eligibility (flow:access/03). */
function CoverageDrawer({
  open,
  onClose,
  patientId,
  coverage,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
  coverage: CoverageView | null;
}) {
  const payers = useApi("listPayers", { query: {} }, { enabled: open });
  const [payerId, setPayerId] = React.useState("");
  const [planId, setPlanId] = React.useState("");
  const [memberId, setMemberId] = React.useState("");
  const [groupNumber, setGroupNumber] = React.useState("");
  const [order, setOrder] = React.useState("1");
  const [end, setEnd] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const plans = useApi("listPayerPlans", { params: { payerId } }, { enabled: !!payerId });
  React.useEffect(() => {
    setPayerId(coverage?.payerId ?? "");
    setPlanId(coverage?.planId ?? "");
    setMemberId(coverage?.memberId ?? "");
    setGroupNumber(coverage?.groupNumber ?? "");
    setOrder(String(coverage?.order ?? 1));
    setEnd(coverage?.periodEnd ?? null);
    setError(null);
  }, [coverage, open]);
  const inv = ["listCoverages", "getPatientBanner", "getFrontDeskBoard"] as const;
  const verify = useApiMutation("checkEligibility", {
    invalidates: [...inv],
    onSuccess: (r) =>
      toast(
        r.status === "ACTIVE"
          ? "Coverage is active."
          : r.status === "INACTIVE"
            ? "The payer reports this coverage inactive."
            : "The payer couldn't be reached. The check will retry.",
      ),
    onError: (e) => setError(errorMessage(e)),
  });
  const save = async () => {
    setError(null);
    try {
      const saved = coverage
        ? await api("updateCoverage", {
            params: { coverageId: coverage.id },
            version: coverage.version,
            body: {
              payerId,
              planId: planId || null,
              memberId: memberId.trim(),
              groupNumber: groupNumber || null,
              order: Number(order),
              periodEnd: end,
            },
          })
        : await api("createCoverage", {
            params: { patientId },
            body: {
              patientId,
              payerId,
              planId: planId || null,
              memberId: memberId.trim(),
              groupNumber: groupNumber || null,
              order: Number(order),
              periodEnd: end,
            },
          });
      // Changed insurance re-runs eligibility (flow:access/06 failure path).
      await verify.mutateAsync({ params: { coverageId: saved.id }, body: {} }).catch(() => null);
      toast("Insurance saved.");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid={`${S}#coverage`}>
        <SheetHeader>
          <SheetTitle>{coverage ? "Edit insurance" : "Add insurance"}</SheetTitle>
        </SheetHeader>
        <SheetBody className="grid content-start gap-4">
          {error ? <Alert tone="caution">{error}</Alert> : null}
          <Button className="justify-self-start" disabled data-testid={tid(S, "cov-scan")}>
            Scan card
          </Button>
          <p className="-mt-2 text-small text-ink-2">
            Card scanning starts once a card-reading service is connected. Enter the details below.
          </p>
          <FieldShell label="Payer">
            <Select
              testId={tid(S, "cov-payer")}
              value={payerId}
              onValueChange={(v) => (setPayerId(v), setPlanId(""))}
              options={(payers.data ?? [])
                .filter((p) => p.active)
                .map((p) => ({ value: p.id, label: p.name }))}
            />
          </FieldShell>
          <FieldShell label="Plan">
            <Select
              value={planId}
              onValueChange={setPlanId}
              disabled={!payerId}
              placeholder={payerId ? "Choose plan" : "Choose a payer first"}
              options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </FieldShell>
          <FieldShell label="Member ID">
            <Input
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="tabular-nums"
              data-testid={tid(S, "cov-member")}
            />
          </FieldShell>
          <FieldShell label="Group">
            <Input value={groupNumber} onChange={(e) => setGroupNumber(e.target.value)} />
          </FieldShell>
          <FieldShell label="Order">
            <Select
              testId={tid(S, "cov-order")}
              value={order}
              onValueChange={setOrder}
              options={[
                { value: "1", label: "Primary" },
                { value: "2", label: "Secondary" },
                { value: "3", label: "Tertiary" },
              ]}
            />
          </FieldShell>
          <FieldShell label="End date" hint="Leave blank while the coverage is current.">
            <DateInput value={end} onChange={setEnd} testId={tid(S, "cov-end")} />
          </FieldShell>
          {coverage ? (
            <Button
              className="justify-self-start"
              loading={verify.isPending}
              onClick={() => verify.mutate({ params: { coverageId: coverage.id }, body: {} })}
              data-testid={tid(S, "cov-verify")}
            >
              Verify eligibility
            </Button>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!payerId || !memberId.trim()}
            onClick={() => void save()}
            data-testid={tid(S, "cov-save")}
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
