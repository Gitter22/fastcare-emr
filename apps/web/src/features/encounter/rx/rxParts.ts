import type { MedicationRequest, MedicationRequestCreate, Pharmacy } from "@agile-emr/shared";

/** The composer's working copy of a prescription (all strings, as typed). */
export interface RxForm {
  rxcui: string;
  display: string;
  dose: string;
  doseUnit: string;
  route: string;
  frequency: string;
  duration: string;
  quantity: string;
  quantityUnit: string;
  refills: string;
  sig: string;
  sigEdited: boolean;
  dxId: string;
  pharmacy: Pharmacy | null;
  note: string;
}

export const ROUTES = [
  { value: "ORAL", label: "By mouth", phrase: "by mouth", verb: "Take" },
  { value: "SUBLINGUAL", label: "Under the tongue", phrase: "under the tongue", verb: "Take" },
  { value: "TOPICAL", label: "Topical", phrase: "to the affected area", verb: "Apply" },
  { value: "INHALED", label: "Inhaled", phrase: "by inhalation", verb: "Inhale" },
  { value: "OPHTHALMIC", label: "Eye", phrase: "in the affected eye", verb: "Instill" },
  { value: "INJECTION", label: "Injection", phrase: "by injection", verb: "Inject" },
  { value: "NASAL", label: "Nasal", phrase: "in each nostril", verb: "Spray" },
];

export const FREQUENCIES = [
  "once daily",
  "twice daily",
  "three times daily",
  "four times daily",
  "every morning",
  "at bedtime",
  "every 4 hours as needed",
  "every 6 hours as needed",
  "every 8 hours",
  "once weekly",
  "as needed",
].map((f) => ({ value: f, label: f.charAt(0).toUpperCase() + f.slice(1) }));

export const DOSE_UNITS = ["tablet", "capsule", "mL", "mg", "puff", "drop", "unit", "patch"].map(
  (u) => ({ value: u, label: u }),
);

export const PDMP_EXCEPTIONS = [
  "State PDMP unavailable",
  "Patient in hospice / end-of-life care",
  "Checked on the state website",
  "Emergency supply ≤ 3 days",
].map((r) => ({ value: r, label: r }));

export const RX_INVALIDATES = [
  "listEncounterPrescriptions",
  "getEncounter",
  "getPatientSummary",
] as const;

export const blankForm = (pharmacy: Pharmacy | null): RxForm => ({
  rxcui: "",
  display: "",
  dose: "1",
  doseUnit: "tablet",
  route: "ORAL",
  frequency: "",
  duration: "",
  quantity: "",
  quantityUnit: "each",
  refills: "0",
  sig: "",
  sigEdited: false,
  dxId: "",
  pharmacy,
  note: "",
});

/** "Take 1 tablet by mouth twice daily for 10 days". */
export function buildSig(
  f: Pick<RxForm, "dose" | "doseUnit" | "route" | "frequency" | "duration">,
) {
  const r = ROUTES.find((x) => x.value === f.route);
  const dose = f.dose.trim()
    ? `${f.dose.trim()} ${f.doseUnit}${f.dose.trim() === "1" ? "" : "s"}`
        .replace(/mLs$/, "mL")
        .replace(/mgs$/, "mg")
    : "";
  const days = Number(f.duration);
  return [
    r?.verb ?? "Use",
    dose,
    r?.phrase,
    f.frequency,
    days > 0 ? `for ${days} ${days === 1 ? "day" : "days"}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formFromRx(rx: MedicationRequest, pharmacy: Pharmacy | null): RxForm {
  const route =
    ROUTES.find((r) => r.value === rx.route || r.label === rx.route)?.value ?? rx.route ?? "";
  return {
    rxcui: rx.rxnormCode,
    display: rx.display,
    dose: rx.doseQuantity ?? "",
    doseUnit: rx.doseUnit ?? "tablet",
    route,
    frequency: rx.frequency ?? "",
    duration: rx.durationDays != null ? String(rx.durationDays) : "",
    quantity: rx.quantity ? String(Number(rx.quantity)) : "",
    quantityUnit: rx.quantityUnit || "each",
    refills: String(rx.refills ?? 0),
    sig: rx.sigText,
    sigEdited: true,
    dxId: rx.reasonConditionId ?? "",
    pharmacy,
    note: rx.noteToPharmacist ?? "",
  };
}

export function formBody(f: RxForm): Omit<MedicationRequestCreate, "patientId" | "prescriberId"> {
  const days = f.duration.trim() ? Number(f.duration) : null;
  return {
    rxnormCode: f.rxcui,
    display: f.display,
    doseQuantity: f.dose.trim() || null,
    doseUnit: f.dose.trim() ? f.doseUnit : null,
    route: f.route || null,
    frequency: f.frequency || null,
    durationDays: days,
    daysSupply: days,
    sigText: f.sig.trim(),
    quantity: f.quantity.trim(),
    quantityUnit: f.quantityUnit || "each",
    refills: Number(f.refills) || 0,
    reasonConditionId: f.dxId || null,
    pharmacyId: f.pharmacy?.id ?? null,
    noteToPharmacist: f.note.trim() || null,
  };
}

export const formProblem = (f: RxForm): string | null =>
  !f.rxcui
    ? "Choose a medication product."
    : !f.sig.trim()
      ? "Add patient instructions."
      : !(Number(f.quantity) > 0)
        ? "Enter a quantity."
        : f.duration.trim() && !(Number(f.duration) > 0)
          ? "Duration must be a number of days."
          : null;

export const scheduleLabel = (s?: string | null) => (s ? `C-${s.replace(/^C-?/i, "")}` : "");

/** Second line of a list item: status, then how far the e-prescription got. */
export function erxText(rx: MedicationRequest): string {
  if (rx.status !== "ACTIVE") return "";
  switch (rx.erxStatus) {
    case "QUEUED":
      return "sending…";
    case "SENT":
    case "ACCEPTED":
      return "sent";
    case "ERROR":
      return "not sent (error)";
    case "CANCEL_REQUESTED":
      return "cancel requested";
    case "CANCELLED":
      return "cancelled at pharmacy";
    default:
      return "not sent";
  }
}
