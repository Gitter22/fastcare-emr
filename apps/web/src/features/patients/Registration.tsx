import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { DuplicateCheckResult, PatientCreateRequest } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  applyServerErrors,
  CheckboxField,
  DateField,
  FieldShell,
  RadioField,
  SelectField,
  TextField,
  useZodForm,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/input";
import { Alert, Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { Checkbox } from "@/components/ui/select";
import { FormPage } from "@/shell/patterns";
import { DuplicatePanel } from "./DuplicatePanel";
import {
  ADMIN_GENDER,
  CONTACT_PREF,
  ETHNICITY,
  GENDER_IDENTITY,
  LANGUAGES,
  PRONOUNS,
  RACE,
  RELATIONSHIPS,
  SEXUAL_ORIENTATION,
  SEX_CLINICAL,
  STEPS,
  US_STATES,
  ageYears,
  e164,
  registrationSchema,
  type RegistrationValues,
} from "./registrationSchema";

const S = "patients.registration";
const NIL = "00000000-0000-0000-0000-000000000000";

/**
 * patients.registration (flow:access/02): create a clean, unique patient. The duplicate check runs as identity is
 * typed (INV-ID-02); creating anyway needs a recorded reason and queues the pair for duplicate review.
 */
export function RegistrationPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "";
  const stepIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.view === view),
  );
  const seeded = seedFromQuery(params.get("q"));
  const form = useZodForm(registrationSchema, {
    defaultValues: {
      firstName: seeded.firstName,
      lastName: seeded.lastName,
      birthDate: seeded.birthDate,
      middleName: "",
      preferredName: "",
      phone: "",
      email: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      preferredLanguage: "en",
      contactPreference: "sms-email",
      administrativeGender: "UNKNOWN",
      raceCodes: [],
      guarantor: "self",
      subscriber: "self",
      selfPay: false,
      interpreterNeeded: false,
      consentNpp: false,
      consentFinancial: false,
      consentSms: false,
    } as unknown as RegistrationValues,
  });
  const v = form.watch();
  const [dups, setDups] = React.useState<DuplicateCheckResult | null>(null);
  const [override, setOverride] = React.useState<string | null>(null);
  const [askReason, setAskReason] = React.useState(false);
  const [reasonText, setReasonText] = React.useState("");
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const afterCreate = React.useRef<"chart" | "book">("chart");

  // Sex for clinical use pre-fills the administrative gender (editable) so step 1 stays short.
  React.useEffect(() => {
    const s = v.sexForClinicalUse;
    if (s === "FEMALE" || s === "MALE") form.setValue("administrativeGender", s);
  }, [v.sexForClinicalUse, form]);

  // INV-ID-02: duplicate check as you type (name + DOB + phone).
  const identityKey = `${v.firstName}|${v.lastName}|${v.birthDate}|${v.phone}|${v.email}`;
  React.useEffect(() => {
    if (
      !v.firstName?.trim() ||
      !v.lastName?.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.birthDate ?? "")
    ) {
      setDups(null);
      return;
    }
    const t = setTimeout(() => {
      api("checkDuplicates", {
        body: {
          firstName: v.firstName!.trim(),
          lastName: v.lastName!.trim(),
          birthDate: v.birthDate!,
          ...(e164(v.phone) ? { phone: e164(v.phone) } : {}),
          ...(v.email?.includes("@") ? { email: v.email.trim() } : {}),
        },
      })
        .then((r) => {
          setDups(r);
          setOverride(null);
        })
        .catch(() => setDups(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [form.formState.isDirty]);

  const payers = useApi("listPayers", undefined, { enabled: stepIndex === 3 || !!v.payerId });
  const plans = useApi(
    "listPayerPlans",
    { params: { payerId: v.payerId ?? "" } },
    { enabled: !!v.payerId },
  );
  const minor = (ageYears(v.birthDate) ?? 99) < 18;

  const goStep = async (i: number) => {
    if (i > stepIndex) {
      const ok = await form.trigger(STEPS[stepIndex]!.fields as never);
      if (!ok) return;
    }
    const next = STEPS[i]!;
    setParams(next.view ? { view: next.view } : {}, { replace: false });
  };

  const blocked = !!dups?.blocking && !override;

  const create = form.handleSubmit(async (vals) => {
    setSubmitError(null);
    if (blocked) {
      setSubmitError("Review the possible existing patient first.");
      return;
    }
    const body = toRequest(vals, override);
    try {
      const created = await api("createPatient", { body });
      form.reset(vals);
      toast("Patient created.");
      if (afterCreate.current === "book" && isBuilt("schedule.calendar"))
        navigate(pathTo("schedule.calendar", {}, "book", { patientId: created.id }));
      else if (isBuilt("chart.summary"))
        navigate(pathTo("chart.summary", { patientId: created.id }));
      else navigate(pathTo("patients.search", {}, undefined, { q: created.mrn }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "duplicate") {
        setDups({
          candidates: (e.problem.candidates as DuplicateCheckResult["candidates"]) ?? [],
          blocking: true,
        });
        setOverride(null);
        setParams({}, { replace: true });
        return;
      }
      const rest = applyServerErrors(
        form,
        e,
        Object.fromEntries(Object.keys(vals).map((k) => [`patient.${k}`, k])),
      );
      setSubmitError(
        rest[0] ?? (e instanceof ApiError && e.problem.errors ? null : errorMessage(e)),
      );
    }
  });

  const step = STEPS[stepIndex]!;
  const last = stepIndex === STEPS.length - 1;
  return (
    <div className="grid content-start gap-6 pt-8">
      <div className="px-8">
        <PageHeader
          title="New patient"
          crumbs={[{ label: "Patients", to: pathTo("patients.search") }, { label: "New patient" }]}
        />
      </div>
      <FormPage
        steps={
          <>
            <ol className="grid gap-1" aria-label="Steps">
              {STEPS.map((s, i) => (
                <li key={s.testId}>
                  <button
                    type="button"
                    onClick={() => void goStep(i)}
                    data-testid={tid(S, s.testId)}
                    aria-current={i === stepIndex ? "step" : undefined}
                    className={cn(
                      "flex h-row-default w-full items-center gap-3 px-3 text-left text-body",
                      i === stepIndex
                        ? "bg-surface font-semibold text-ink"
                        : "text-ink-2 hover:bg-surface-hover hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-6 place-items-center rounded-full text-caption",
                        i === stepIndex
                          ? "bg-pine-600 text-on-primary"
                          : "shadow-[inset_0_0_0_1.5px_var(--color-ink-2)]",
                      )}
                    >
                      {i + 1}
                    </span>
                    {s.label}
                  </button>
                </li>
              ))}
            </ol>
            <p className="px-3 text-small text-ink-2">
              Only step 1 is required to book. The rest can be finished by the patient in the
              portal.
            </p>
          </>
        }
        aside={
          dups?.candidates.length ? (
            <DuplicatePanel
              result={dups}
              entering={{
                name: `${v.firstName} ${v.lastName}`.trim(),
                birthDate: v.birthDate,
                phone: v.phone,
                address: [v.line1, v.city, v.state].filter(Boolean).join(", "),
              }}
              overridden={!!override}
              onNotSame={() => setAskReason(true)}
            />
          ) : undefined
        }
        status={
          submitError ? (
            <span className="text-danger-ink">{submitError}</span>
          ) : Object.keys(form.formState.touchedFields).length ? (
            "Unsaved changes"
          ) : null
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate(-1)} data-testid={tid(S, "reg-cancel")}>
              Cancel
            </Button>
            {stepIndex === 0 && can("createPatient") && isBuilt("schedule.calendar") ? (
              <Button
                onClick={() => {
                  afterCreate.current = "book";
                  void create();
                }}
                loading={form.formState.isSubmitting && afterCreate.current === "book"}
                disabled={blocked}
                data-testid={tid(S, "reg-save-book")}
              >
                Save & book appointment
              </Button>
            ) : null}
            {last ? (
              <Button
                variant="primary"
                onClick={() => {
                  afterCreate.current = "chart";
                  void create();
                }}
                loading={form.formState.isSubmitting}
                disabled={!can("createPatient") || blocked}
                data-testid={tid(S, "reg-finish")}
              >
                Create patient
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void goStep(stepIndex + 1)}
                data-testid={tid(
                  S,
                  stepIndex === 0
                    ? "reg-continue"
                    : `${["", "demo", "guar", "ins"][stepIndex]}-next`,
                )}
              >
                Continue to {STEPS[stepIndex + 1]!.label.toLowerCase()}
              </Button>
            )}
          </>
        }
      >
        {submitError && step.view === "" ? <Alert tone="caution">{submitError}</Alert> : null}
        {stepIndex === 0 ? (
          <>
            <Card>
              <CardHeader
                title="Identity"
                actions={
                  <span className="text-small text-ink-2">Duplicate check runs as you type</span>
                }
              />
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                <TextField
                  form={form}
                  name="firstName"
                  label="Legal first name"
                  required
                  testId={tid(S, "first-name")}
                  autoComplete="off"
                />
                <TextField
                  form={form}
                  name="middleName"
                  label="Middle"
                  testId={tid(S, "middle-name")}
                  autoComplete="off"
                />
                <TextField
                  form={form}
                  name="lastName"
                  label="Legal last name"
                  required
                  testId={tid(S, "last-name")}
                  autoComplete="off"
                />
                <TextField
                  form={form}
                  name="preferredName"
                  label="Preferred name"
                  testId={tid(S, "preferred-name")}
                  autoComplete="off"
                />
                <DateField
                  form={form}
                  name="birthDate"
                  label="Date of birth"
                  required
                  testId={tid(S, "dob")}
                />
                <SelectField
                  form={form}
                  name="sexForClinicalUse"
                  label="Sex for clinical use"
                  required
                  options={[...SEX_CLINICAL]}
                  testId={tid(S, "sex-clinical")}
                />
                <SelectField
                  form={form}
                  name="administrativeGender"
                  label="Administrative gender"
                  options={[...ADMIN_GENDER]}
                  hint="Used on claims and documents."
                />
              </div>
              {minor ? (
                <Alert tone="caution" className="mt-4">
                  Patient is a minor: add a parent or guardian as guarantor.
                </Alert>
              ) : null}
            </Card>
            <Card>
              <CardHeader title="Contact" />
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                <TextField
                  form={form}
                  name="phone"
                  label="Mobile phone"
                  required
                  inputMode="tel"
                  testId={tid(S, "phone")}
                  autoComplete="off"
                />
                <TextField
                  form={form}
                  name="email"
                  label="Email"
                  type="email"
                  testId={tid(S, "email")}
                  autoComplete="off"
                />
                <TextField
                  form={form}
                  name="line1"
                  label="Home address"
                  className="col-span-full"
                  testId={tid(S, "address")}
                  autoComplete="off"
                />
                <TextField form={form} name="line2" label="Apt, suite" autoComplete="off" />
                <TextField form={form} name="city" label="City" autoComplete="off" />
                <SelectField form={form} name="state" label="State" options={US_STATES} />
                <TextField
                  form={form}
                  name="postalCode"
                  label="ZIP"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <SelectField
                  form={form}
                  name="contactPreference"
                  label="Contact preference"
                  options={CONTACT_PREF}
                  testId={tid(S, "contact-pref")}
                />
                <SelectField
                  form={form}
                  name="preferredLanguage"
                  label="Preferred language"
                  options={LANGUAGES}
                  testId={tid(S, "language")}
                />
              </div>
            </Card>
          </>
        ) : null}

        {stepIndex === 1 ? (
          <Card>
            <CardHeader title="Demographics" />
            <div className="grid gap-6">
              <FieldShell label="Race (choose all that apply)">
                <div className="grid grid-cols-2 gap-2" data-testid={tid(S, "race")}>
                  {RACE.map((r) => (
                    <Checkbox
                      key={r.value}
                      label={r.label}
                      checked={(v.raceCodes ?? []).includes(r.value)}
                      onCheckedChange={(c) => {
                        const cur = (v.raceCodes ?? []).filter(
                          (x) => x !== "ASKU" && x !== r.value,
                        );
                        form.setValue(
                          "raceCodes",
                          r.value === "ASKU" ? (c ? ["ASKU"] : []) : c ? [...cur, r.value] : cur,
                          { shouldDirty: true },
                        );
                      }}
                    />
                  ))}
                </div>
              </FieldShell>
              <div className="grid grid-cols-2 gap-4">
                <SelectField
                  form={form}
                  name="ethnicity"
                  label="Ethnicity"
                  options={ETHNICITY}
                  testId={tid(S, "ethnicity")}
                />
                <SelectField
                  form={form}
                  name="genderIdentity"
                  label="Gender identity"
                  options={GENDER_IDENTITY}
                  testId={tid(S, "gender-identity")}
                />
                <SelectField
                  form={form}
                  name="pronouns"
                  label="Pronouns"
                  options={PRONOUNS}
                  testId={tid(S, "pronouns")}
                />
                <SelectField
                  form={form}
                  name="sexualOrientation"
                  label="Sexual orientation"
                  options={SEXUAL_ORIENTATION}
                  testId={tid(S, "sexual-orientation")}
                />
              </div>
              <CheckboxField
                form={form}
                name="interpreterNeeded"
                label="Needs an interpreter"
                testId={tid(S, "interpreter")}
              />
              <p className="text-small text-ink-2" data-testid={tid(S, "decline-note")}>
                Every question offers "Chose not to answer".
              </p>
            </div>
          </Card>
        ) : null}

        {stepIndex === 2 ? (
          <Card>
            <CardHeader title="Guarantor" />
            <div className="grid gap-4">
              {minor ? (
                <Alert tone="caution" testId={tid(S, "minor-guardian")}>
                  Patient is a minor: a guardian is required.
                </Alert>
              ) : null}
              <RadioField
                form={form}
                name="guarantor"
                label="Who is responsible for the bill?"
                testId={tid(S, "guarantor-self")}
                options={[
                  { value: "self", label: "Self" },
                  { value: "other", label: "Another person" },
                ]}
              />
              {v.guarantor === "other" ? (
                <div className="grid grid-cols-2 gap-4" data-testid={tid(S, "guarantor-person")}>
                  <TextField form={form} name="guarantorFirstName" label="First name" required />
                  <TextField form={form} name="guarantorLastName" label="Last name" required />
                  <SelectField
                    form={form}
                    name="guarantorRelationship"
                    label="Relationship to patient"
                    required
                    options={RELATIONSHIPS}
                  />
                  <TextField form={form} name="guarantorPhone" label="Phone" inputMode="tel" />
                </div>
              ) : null}
              <h4 className="pt-2 text-h3 text-ink">Emergency contact</h4>
              <div className="grid grid-cols-2 gap-4" data-testid={tid(S, "emergency-contact")}>
                <TextField form={form} name="emergencyFirstName" label="First name" />
                <TextField form={form} name="emergencyLastName" label="Last name" />
                <SelectField
                  form={form}
                  name="emergencyRelationship"
                  label="Relationship"
                  options={RELATIONSHIPS}
                />
                <TextField form={form} name="emergencyPhone" label="Phone" inputMode="tel" />
              </div>
            </div>
          </Card>
        ) : null}

        {stepIndex === 3 ? (
          <Card>
            <CardHeader title="Insurance" />
            <div className="grid gap-4">
              <CheckboxField
                form={form}
                name="selfPay"
                label="Self-pay (no insurance)"
                testId={tid(S, "self-pay")}
              />
              {!v.selfPay ? (
                <div className="grid grid-cols-2 gap-4">
                  <SelectField
                    form={form}
                    name="payerId"
                    label="Payer"
                    options={(payers.data ?? [])
                      .filter((p) => p.active)
                      .map((p) => ({ value: p.id, label: p.name }))}
                    testId={tid(S, "payer")}
                    placeholder={payers.isLoading ? "Loading…" : "Choose payer"}
                  />
                  <SelectField
                    form={form}
                    name="planId"
                    label="Plan"
                    options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                    placeholder={v.payerId ? "Choose plan" : "Choose a payer first"}
                    disabled={!v.payerId}
                  />
                  <TextField
                    form={form}
                    name="memberId"
                    label="Member ID"
                    testId={tid(S, "member-id")}
                    autoComplete="off"
                  />
                  <TextField
                    form={form}
                    name="groupNumber"
                    label="Group"
                    testId={tid(S, "group")}
                    autoComplete="off"
                  />
                  <RadioField
                    form={form}
                    name="subscriber"
                    label="Subscriber"
                    testId={tid(S, "subscriber")}
                    options={[
                      { value: "self", label: "Patient" },
                      { value: "guarantor", label: "Guarantor", disabled: v.guarantor !== "other" },
                    ]}
                  />
                </div>
              ) : (
                <p className="text-body text-ink-2">
                  The patient pays at the visit. Offer a good-faith estimate before booking.
                </p>
              )}
            </div>
          </Card>
        ) : null}

        {stepIndex === 4 ? (
          <Card>
            <CardHeader title="Consents" />
            <div className="grid gap-3">
              <CheckboxField
                form={form}
                name="consentNpp"
                label="Notice of privacy practices acknowledged"
                testId={tid(S, "consent-npp")}
              />
              <CheckboxField
                form={form}
                name="consentFinancial"
                label="Financial policy accepted"
                testId={tid(S, "consent-financial")}
              />
              <CheckboxField
                form={form}
                name="consentSms"
                label="OK to text appointment reminders (TCPA)"
                testId={tid(S, "consent-sms")}
              />
              <TextField
                form={form}
                name="signerName"
                label="Signed by"
                hint={minor ? "Parent or guardian's full name." : "Patient's full name as signed."}
                className="max-w-md pt-2"
                testId={tid(S, "consent-sign")}
              />
            </div>
          </Card>
        ) : null}
      </FormPage>

      <Dialog open={askReason} onOpenChange={setAskReason}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new record?</DialogTitle>
            <DialogDescription>
              Record why this is a different person. The decision is logged and the pair goes to
              duplicate review.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="For example: different address and SSN; confirmed with the patient."
            aria-label="Reason"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAskReason(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={reasonText.trim().length < 5}
              onClick={() => {
                setOverride(reasonText.trim());
                setAskReason(false);
              }}
            >
              Not the same person
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function seedFromQuery(q: string | null): {
  firstName: string;
  lastName: string;
  birthDate: string;
} {
  const out = { firstName: "", lastName: "", birthDate: "" };
  if (!q) return out;
  const names: string[] = [];
  for (const part of q.split(/[\s,]+/)) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(part);
    if (m) out.birthDate = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
    else if (/^[a-zA-Z'-]+$/.test(part)) names.push(part[0]!.toUpperCase() + part.slice(1));
  }
  if (q.includes(",")) [out.lastName = "", out.firstName = ""] = names;
  else [out.firstName = "", out.lastName = ""] = names.length === 1 ? ["", names[0]!] : names;
  return out;
}

function toRequest(v: RegistrationValues, override: string | null): PatientCreateRequest {
  const t = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  const race = (v.raceCodes ?? []).filter((c) => c !== "ASKU");
  const relatedPersons: PatientCreateRequest["relatedPersons"] = [];
  if (v.guarantor === "other") {
    relatedPersons.push({
      patientId: NIL,
      relationship: v.guarantorRelationship!,
      isGuarantor: true,
      firstName: v.guarantorFirstName!.trim(),
      lastName: v.guarantorLastName!.trim(),
      phone: t(v.guarantorPhone) ?? null,
    });
  }
  if (t(v.emergencyFirstName) && t(v.emergencyLastName)) {
    relatedPersons.push({
      patientId: NIL,
      relationship: v.emergencyRelationship || "O",
      isEmergencyContact: true,
      firstName: v.emergencyFirstName!.trim(),
      lastName: v.emergencyLastName!.trim(),
      phone: t(v.emergencyPhone) ?? null,
    });
  }
  const signer = t(v.signerName) ?? `${v.firstName} ${v.lastName}`;
  const consents: NonNullable<PatientCreateRequest["consents"]> = [];
  const consent = (type: "NOTICE_OF_PRIVACY_PRACTICES" | "FINANCIAL_POLICY" | "SMS_TCPA") =>
    consents.push({
      type,
      signerName: signer,
      signerRelationship:
        v.guarantor === "other" && (ageYears(v.birthDate) ?? 99) < 18 ? "PARENT" : "SELF",
      documentVersion: "v1",
    });
  if (v.consentNpp) consent("NOTICE_OF_PRIVACY_PRACTICES");
  if (v.consentFinancial) consent("FINANCIAL_POLICY");
  if (v.consentSms) consent("SMS_TCPA");
  return {
    patient: {
      firstName: v.firstName.trim(),
      middleName: t(v.middleName) ?? null,
      lastName: v.lastName.trim(),
      preferredName: t(v.preferredName) ?? null,
      birthDate: v.birthDate,
      administrativeGender: v.administrativeGender,
      sexForClinicalUse: v.sexForClinicalUse,
      genderIdentity: t(v.genderIdentity) ?? null,
      pronouns: v.pronouns && v.pronouns !== "ASKU" ? v.pronouns : null,
      sexualOrientation: t(v.sexualOrientation) ?? null,
      raceCodes: race,
      ethnicityCodes: v.ethnicity && v.ethnicity !== "ASKU" ? [v.ethnicity] : [],
      preferredLanguage: v.preferredLanguage ?? "en",
      interpreterNeeded: !!v.interpreterNeeded,
    },
    addresses: t(v.line1)
      ? [
          {
            patientId: NIL,
            line1: v.line1!.trim(),
            line2: t(v.line2) ?? null,
            city: v.city!.trim(),
            state: v.state!,
            postalCode: v.postalCode!.trim(),
          },
        ]
      : [],
    contactPoints: [
      { patientId: NIL, system: "PHONE", use: "MOBILE", value: v.phone, rank: 1 },
      ...(t(v.email)
        ? [
            {
              patientId: NIL,
              system: "EMAIL" as const,
              use: "HOME" as const,
              value: v.email!.trim(),
              rank: 1,
            },
          ]
        : []),
    ],
    relatedPersons,
    coverages:
      !v.selfPay && v.payerId && t(v.memberId)
        ? [
            {
              patientId: NIL,
              payerId: v.payerId,
              planId: t(v.planId) ?? null,
              order: 1,
              memberId: v.memberId!.trim(),
              groupNumber: t(v.groupNumber) ?? null,
              relationshipToSubscriber: v.subscriber === "guarantor" ? "other" : "self",
            },
          ]
        : [],
    consents,
    ...(override ? { duplicateOverrideReason: override } : {}),
  };
}
