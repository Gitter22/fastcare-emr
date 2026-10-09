import * as React from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type { DurAlert, MedicationRequest, Pharmacy, RxCheckResult } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { tid } from "@/app/routes";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { openBlob } from "@/lib/files";
import { status } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardHeader, EmptyState } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { Unavailable } from "@/components/ui/unavailable";
import { EncounterBody, useEncounter } from "../EncounterWorkspace";
import { DurAlertDialog } from "./DurAlertDialog";
import { RxComposer } from "./RxComposer";
import { CancelRxDialog, EpcsDialog, PassiveAlertsDialog } from "./RxDialogs";
import { CoveragePanel, PdmpPanel, type PdmpState } from "./RxSidePanels";
import {
  RX_INVALIDATES,
  blankForm,
  erxText,
  formBody,
  formFromRx,
  formProblem,
  scheduleLabel,
  type RxForm,
} from "./rxParts";

const S = "encounter.rx";
const INVALIDATES = [...RX_INVALIDATES];
type Selected = string | "new" | null;
const msgOf = (b: { text?: string; message?: string }) => b.text ?? b.message ?? "";

/** encounter.rx (flow:encounter/05): compose, check (DUR, formulary, PDMP), sign and send this visit's prescriptions. */
export function RxPage() {
  const { patientId, encounterId, encounter } = useEncounter();
  const { me } = useAuth();
  const canSign = !!me?.canSign.prescriptions;
  const erxConnected = !!me?.connectedGateways.includes("ErxGateway");
  const prescriberId = (canSign ? me?.user.practitionerId : undefined) ?? encounter.practitionerId;

  const list = useApi("listEncounterPrescriptions", { params: { encounterId } });
  const dxQuery = useApi("listEncounterDiagnoses", { params: { encounterId } });
  const patient = useApi("getPatient", { params: { patientId } }, { staleTime: 60_000 });
  const preferred = patient.data?.preferredPharmacy ?? null;
  const rxs = list.data ?? [];

  const [selected, setSelected] = React.useState<Selected>(null);
  const [form, setForm] = React.useState<RxForm>(() => blankForm(null));
  const [drugQuery, setDrugQuery] = React.useState("");
  const [check, setCheck] = React.useState<RxCheckResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [pdmp, setPdmp] = React.useState<PdmpState | null>(null);
  const [blockers, setBlockers] = React.useState<string[] | null>(null);
  const [dur, setDur] = React.useState<{ alert: DurAlert; alternatives: string[] } | null>(null);
  const [passive, setPassive] = React.useState<DurAlert[] | null>(null);
  const [epcsOpen, setEpcsOpen] = React.useState(false);
  const [epcsError, setEpcsError] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<MedicationRequest | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ack = React.useRef<string[]>([]);
  /** Newest copy of each Rx we wrote, so back-to-back PATCHes carry the current version before the list refetches. */
  const latest = React.useRef<Map<string, MedicationRequest>>(new Map());

  const fresh = React.useCallback(
    (id: string | null | undefined): MedicationRequest | null => {
      if (!id) return null;
      const a = rxs.find((r) => r.id === id) ?? null;
      const b = latest.current.get(id) ?? null;
      return a && b ? (b.version > a.version ? b : a) : (a ?? b);
    },
    [rxs],
  );
  const rx = selected && selected !== "new" ? fresh(selected) : null;
  const readOnly = !!rx && rx.status !== "DRAFT";
  const note = encounter.note?.status;
  const noteLocked = !!note && ["SIGNED", "ADDENDED", "PENDING_COSIGN"].includes(note);

  const create = useApiMutation("createPrescription", { invalidates: INVALIDATES });
  const update = useApiMutation("updatePrescription", { invalidates: INVALIDATES });
  const signRx = useApiMutation("signPrescription", { invalidates: INVALIDATES });
  const remember = (r: MedicationRequest) => (latest.current.set(r.id, r), r);

  const runCheck = React.useCallback(async (id: string) => {
    setChecking(true);
    try {
      const res = await api("checkPrescription", { params: { medicationRequestId: id } });
      setCheck(res);
      return res;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  /** Load a prescription (or a blank form) into the composer. */
  const select = (s: Selected) => {
    setSelected(s);
    setCheck(null);
    setBlockers(null);
    setDrugQuery("");
    ack.current = [];
    const r = s && s !== "new" ? fresh(s) : null;
    setForm(
      r
        ? formFromRx(
            r,
            r.pharmacyId
              ? (knownPharmacy(r.pharmacyId) ?? placeholderPharmacy(r.pharmacyId))
              : null,
          )
        : blankForm(preferred),
    );
    setPdmp(r?.pdmpQueryId ? { id: r.pdmpQueryId } : null);
    if (r && r.status === "DRAFT") void runCheck(r.id);
  };
  const pharmacies = React.useRef<Map<string, Pharmacy>>(new Map());
  const knownPharmacy = (id: string) =>
    pharmacies.current.get(id) ?? (preferred?.id === id ? preferred : undefined);
  const placeholderPharmacy = (id: string): Pharmacy => ({
    id,
    ncpdpId: "",
    name: "Pharmacy on file",
    address: null,
    specialties: [],
    epcsEnabled: false,
  });
  if (form.pharmacy) pharmacies.current.set(form.pharmacy.id, form.pharmacy);

  // First visit to the screen: open the newest draft, or a blank composer.
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (initialised.current || list.isLoading || patient.isLoading) return;
    initialised.current = true;
    const draft = rxs.find((r) => r.status === "DRAFT");
    select(draft ? draft.id : rxs.length ? rxs[0].id : "new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.isLoading, patient.isLoading]);

  /** Create or update the draft from the form. Returns the saved Rx, or null (with a toast) on failure. */
  const save = async (): Promise<MedicationRequest | null> => {
    const problem = formProblem(form);
    if (problem) return (toast.error(problem), null);
    try {
      const body = formBody(form);
      let saved: MedicationRequest;
      if (rx) {
        saved = await update.mutateAsync({
          params: { medicationRequestId: rx.id },
          version: rx.version,
          body,
        });
      } else {
        saved = await create.mutateAsync({
          params: { encounterId },
          body: { ...body, patientId, prescriberId, quantityUnit: body.quantityUnit ?? "each" },
        });
      }
      remember(saved);
      setSelected(saved.id);
      return saved;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    }
  };
  const saveDraft = async () => {
    setBusy(true);
    const saved = await save();
    if (saved) {
      toast("Draft saved.");
      void runCheck(saved.id);
    }
    setBusy(false);
  };

  const pickDrug = async (p: { rxcui: string; name: string }) => {
    const next = { ...form, rxcui: p.rxcui, display: p.name };
    setForm(next);
    setDrugQuery("");
    if (rx && rx.status === "DRAFT") {
      try {
        const saved = remember(
          await update.mutateAsync({
            params: { medicationRequestId: rx.id },
            version: rx.version,
            body: { rxnormCode: p.rxcui, display: p.name },
          }),
        );
        void runCheck(saved.id);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }
  };
  const switchTo = (name: string) => {
    setDur(null);
    setForm((f) => ({ ...f, rxcui: "", display: "" }));
    setDrugQuery(name);
  };

  const recordException = async (reason: string) => {
    if (!rx) return;
    try {
      remember(
        await update.mutateAsync({
          params: { medicationRequestId: rx.id },
          version: rx.version,
          body: { pdmpExceptionReason: reason },
        }),
      );
      toast("PDMP exception recorded.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const viewReport = async () => {
    if (!pdmp) return;
    try {
      openBlob(
        (await api("getPdmpReport", { params: { pdmpQueryId: pdmp.id } })) as unknown as Blob,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doSign = async (id: string, epcsToken?: string) => {
    setBusy(true);
    setEpcsError(null);
    try {
      const signed = remember(
        await signRx.mutateAsync({
          params: { medicationRequestId: id },
          body: {
            patientId,
            ids: [id],
            ...(form.pharmacy ? { pharmacyId: form.pharmacy.id } : {}),
            ...(pdmp ? { pdmpQueryId: pdmp.id } : {}),
            ...(epcsToken ? { epcsToken } : {}),
            ...(ack.current.length ? { acknowledgedAlertIds: ack.current } : {}),
          },
        }),
      );
      setEpcsOpen(false);
      toast(
        signed.erxStatus === "ERROR"
          ? "Prescription signed; sending failed."
          : "Prescription signed and sent.",
      );
      select(signed.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "invariant_blocked" && e instanceof ApiError) {
        setEpcsOpen(false);
        const bl = (e.problem.blockers ?? []) as Array<{ text?: string; message?: string }>;
        setBlockers(
          bl.map(msgOf).filter(Boolean).length ? bl.map(msgOf).filter(Boolean) : [errorMessage(e)],
        );
      } else if (code === "epcs_token_invalid") {
        setEpcsError("That code didn't work. Enter a new code from your authenticator app.");
      } else if (code === "epcs_locked") {
        setEpcsError(
          "Signing is locked after too many wrong codes. Wait a few minutes, then try again.",
        );
      } else if (code === "epcs_not_enabled") {
        setEpcsError(
          "This pharmacy or your account isn't enabled for EPCS. Choose another pharmacy or ask an administrator.",
        );
      } else if (code === "gateway_unavailable") {
        setEpcsOpen(false);
        toast.error(
          "The e-prescribing connection is unavailable. Nothing was sent; try again shortly.",
        );
      } else if (epcsOpen) setEpcsError(errorMessage(e));
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** Sign & send: save, check, resolve DUR alerts, then (controlled) 2FA, then sign. Re-entered after each dialog. */
  const signFlow = async (restart = true) => {
    setBlockers(null);
    if (restart) ack.current = [];
    setBusy(true);
    try {
      const saved = rx && !dirtyFromRx() ? rx : await save();
      if (!saved) return;
      const res = await runCheck(saved.id);
      if (!res) return;
      const pending = res.alerts.filter((a) => a.outcome === "pending");
      const hard = pending.find((a) => a.severity === "INTERRUPTIVE");
      if (hard)
        return void setDur({ alert: hard, alternatives: res.formulary?.alternatives ?? [] });
      const soft = pending.filter((a) => a.severity === "PASSIVE" && !ack.current.includes(a.id));
      if (soft.length) return void setPassive(soft);
      if (res.epcsRequired) return void setEpcsOpen(true);
      await doSign(saved.id);
    } finally {
      setBusy(false);
    }
  };
  const dirtyFromRx = () => {
    if (!rx) return true;
    const b = formBody(form);
    return (
      b.rxnormCode !== rx.rxnormCode ||
      b.sigText !== rx.sigText ||
      Number(b.quantity) !== Number(rx.quantity) ||
      (b.refills ?? 0) !== rx.refills ||
      (b.pharmacyId ?? null) !== (rx.pharmacyId ?? null) ||
      (b.reasonConditionId ?? null) !== (rx.reasonConditionId ?? null) ||
      (b.noteToPharmacist ?? null) !== (rx.noteToPharmacist ?? null) ||
      (b.doseQuantity ?? null) !== (rx.doseQuantity ?? null) ||
      (b.route ?? null) !== (rx.route ?? null) ||
      (b.frequency ?? null) !== (rx.frequency ?? null) ||
      (b.durationDays ?? null) !== (rx.durationDays ?? null)
    );
  };

  const onDurDecided = (outcome: "overridden" | "removed") => {
    setDur(null);
    if (outcome === "removed") {
      toast("Prescription removed.");
      void list.refetch().then(() => select("new"));
    } else void signFlow(false);
  };

  const problem = formProblem(form);
  const pending = busy || create.isPending || update.isPending || signRx.isPending;
  const sendBtn = (
    <Button
      variant="primary"
      disabled={!erxConnected || pending || readOnly || noteLocked || !!problem}
      loading={busy}
      onClick={() => void signFlow()}
      data-testid={tid(S, "rx-sign-send")}
    >
      Sign & send
    </Button>
  );

  return (
    <EncounterBody
      actionBar={
        <>
          {problem && !readOnly ? (
            <span className="mr-auto text-small text-ink-2">{problem}</span>
          ) : (
            <span className="mr-auto" />
          )}
          {readOnly ? null : (
            <Button
              disabled={pending || noteLocked || !!problem}
              onClick={() => void saveDraft()}
              data-testid={tid(S, "rx-save")}
            >
              Save draft
            </Button>
          )}
          {canSign ? (
            erxConnected ? (
              sendBtn
            ) : (
              <Unavailable reason="E-prescribing isn't connected, so prescriptions can't be sent.">
                {sendBtn}
              </Unavailable>
            )
          ) : null}
        </>
      }
    >
      {noteLocked ? (
        <Alert>The note is signed, so new prescriptions can't be added from this visit.</Alert>
      ) : null}
      {blockers ? (
        <Alert
          tone="critical"
          title="This prescription can't be signed yet."
          testId={tid(S, "blockers")}
        >
          <ul className="list-disc pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        <Card data-testid={tid(S, "rx-list")} className="content-start self-start">
          <CardHeader title="This visit" />
          <div className="grid gap-1">
            {rxs.map((r) => (
              <Button
                key={r.id}
                variant="ghost"
                aria-current={selected === r.id || undefined}
                className={cn(
                  "h-auto w-full flex-col items-start gap-0.5 whitespace-normal py-2 text-left",
                  selected === r.id && "bg-pine-50 text-pine-700",
                )}
                onClick={() => select(r.id)}
                data-testid={tid(S, "rx-item")}
              >
                <span className="w-full whitespace-normal break-words font-semibold">
                  {r.display}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-small font-normal text-ink-2">
                  {[status("prescription", r.status), erxText(r)].filter(Boolean).join(" · ")}
                  {r.isControlled ? (
                    <Tag tone="caution">Controlled {scheduleLabel(r.deaSchedule)}</Tag>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
          {!rxs.length && !list.isLoading ? (
            <p className="mb-2 text-body text-ink-2">No prescriptions yet.</p>
          ) : null}
          <Button
            className="mt-3 w-full"
            disabled={noteLocked}
            onClick={() => select("new")}
            data-testid={tid(S, "new-rx")}
          >
            <Plus size={18} strokeWidth={1.75} aria-hidden /> New prescription
          </Button>
        </Card>

        <Card className="content-start">
          <CardHeader
            title={rx ? rx.display : "New prescription"}
            actions={
              rx && rx.status === "ACTIVE" && canSign ? (
                <Button onClick={() => setCancelling(rx)} data-testid={tid(S, "rx-cancel")}>
                  Cancel prescription
                </Button>
              ) : rx && rx.status === "DRAFT" ? (
                <Button
                  variant="ghost"
                  onClick={() => setCancelling(rx)}
                  data-testid={tid(S, "rx-remove")}
                >
                  Remove
                </Button>
              ) : null
            }
          />
          {rx && rx.status !== "DRAFT" ? (
            <p className="mb-4 text-body text-ink-2">
              {status("prescription", rx.status)}
              {erxText(rx) ? ` · ${erxText(rx)}` : ""}. Signed prescriptions can't be edited.
            </p>
          ) : null}
          {rx && (rx.erxStatus === "ERROR" || rx.erxStatus === "QUEUED") ? (
            <Alert tone="caution" className="mb-4" testId={tid(S, "erx-error")}>
              Not yet received by the pharmacy — retrying; call the pharmacy if urgent.
              {rx.erxError ? ` (${rx.erxError})` : ""}
            </Alert>
          ) : null}
          {selected === null && !list.isLoading ? (
            <EmptyState title="No prescription selected">
              Choose one from the list or start a new one.
            </EmptyState>
          ) : (
            <RxComposer
              form={form}
              onChange={setForm}
              readOnly={readOnly || noteLocked}
              isNew={!rx}
              drugQuery={drugQuery}
              onDrugQuery={setDrugQuery}
              onPickDrug={(p) => void pickDrug(p)}
              diagnoses={dxQuery.data ?? []}
            />
          )}
        </Card>

        <div className="grid content-start gap-6">
          <CoveragePanel
            check={check}
            checking={checking}
            hasRx={!!rx && rx.status === "DRAFT"}
            onSwitch={readOnly ? undefined : switchTo}
          />
          <PdmpPanel
            rx={rx}
            patientId={patientId}
            pdmp={pdmp}
            onQueried={setPdmp}
            onException={(r) => void recordException(r)}
            saving={update.isPending}
          />
        </div>
      </div>

      <DurAlertDialog
        alert={dur?.alert ?? null}
        alternatives={dur?.alternatives}
        onSwitch={switchTo}
        onDecided={onDurDecided}
        invalidates={INVALIDATES}
      />
      <PassiveAlertsDialog
        alerts={passive}
        onCancel={() => setPassive(null)}
        onContinue={(ids) => {
          ack.current = [...ack.current, ...ids];
          setPassive(null);
          void signFlow(false);
        }}
      />
      <EpcsDialog
        rx={rx}
        open={epcsOpen}
        pdmp={pdmp}
        canSign={!!me?.canSign.controlledSubstances}
        busy={busy}
        error={epcsError}
        onViewReport={() => void viewReport()}
        onClose={() => (setEpcsOpen(false), setEpcsError(null))}
        onSign={(t) => rx && void doSign(rx.id, t)}
      />
      <CancelRxDialog
        rx={cancelling}
        onClose={(done) => {
          setCancelling(null);
          if (done) select("new");
        }}
      />
    </EncounterBody>
  );
}
