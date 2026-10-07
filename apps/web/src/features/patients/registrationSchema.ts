import { z } from "zod";

/**
 * patients.registration form model. Only step 1 (identity & contact) is required to book; the rest can be finished
 * later or by the patient in the portal.
 * Value sets are the standard USCDI ones: CDC Race & Ethnicity (OMB categories), SNOMED CT gender identity and
 * sexual orientation answers, HL7 NullFlavor ASKU for "chose not to answer".
 */
export const RACE = [
  { value: "1002-5", label: "American Indian or Alaska Native" },
  { value: "2028-9", label: "Asian" },
  { value: "2054-5", label: "Black or African American" },
  { value: "2076-8", label: "Native Hawaiian or Other Pacific Islander" },
  { value: "2106-3", label: "White" },
  { value: "ASKU", label: "Chose not to answer" },
];
export const ETHNICITY = [
  { value: "2135-2", label: "Hispanic or Latino" },
  { value: "2186-5", label: "Not Hispanic or Latino" },
  { value: "ASKU", label: "Chose not to answer" },
];
export const GENDER_IDENTITY = [
  { value: "446141000124107", label: "Female" },
  { value: "446151000124109", label: "Male" },
  { value: "33791000087105", label: "Nonbinary" },
  { value: "OTH", label: "Other" },
  { value: "ASKU", label: "Chose not to answer" },
];
export const SEXUAL_ORIENTATION = [
  { value: "20430005", label: "Straight or heterosexual" },
  { value: "38628009", label: "Lesbian, gay or homosexual" },
  { value: "42035005", label: "Bisexual" },
  { value: "OTH", label: "Something else" },
  { value: "UNK", label: "Don't know" },
  { value: "ASKU", label: "Chose not to answer" },
];
export const PRONOUNS = [
  { value: "she/her", label: "she/her" },
  { value: "he/him", label: "he/him" },
  { value: "they/them", label: "they/them" },
  { value: "ASKU", label: "Chose not to answer" },
];
export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "zh", label: "Chinese" },
  { value: "vi", label: "Vietnamese" },
  { value: "ko", label: "Korean" },
  { value: "tl", label: "Tagalog" },
  { value: "ar", label: "Arabic" },
  { value: "ru", label: "Russian" },
  { value: "fr", label: "French" },
  { value: "ht", label: "Haitian Creole" },
  { value: "pt", label: "Portuguese" },
  { value: "pl", label: "Polish" },
  { value: "hi", label: "Hindi" },
  { value: "ur", label: "Urdu" },
];
export const CONTACT_PREF = [
  { value: "sms-email", label: "Text, then email" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone call" },
  { value: "portal", label: "Portal only" },
];
export const SEX_CLINICAL = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "SPECIFIED", label: "Specified (see note)" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;
export const ADMIN_GENDER = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "OTHER", label: "Other" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;
export const US_STATES =
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU"
    .split(" ")
    .map((s) => ({ value: s, label: s }));
export const RELATIONSHIPS = [
  { value: "MTH", label: "Mother" },
  { value: "FTH", label: "Father" },
  { value: "GRD", label: "Guardian" },
  { value: "SPS", label: "Spouse" },
  { value: "CHILD", label: "Child" },
  { value: "FRND", label: "Friend" },
  { value: "O", label: "Other" },
];

const optional = z.string().trim().optional().or(z.literal(""));
const phone = z
  .string()
  .trim()
  .refine(
    (v) => v.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length === 10,
    "Enter a 10-digit phone number.",
  );

export const registrationSchema = z
  .object({
    firstName: z.string().trim().min(1, "Enter the legal first name."),
    middleName: optional,
    lastName: z.string().trim().min(1, "Enter the legal last name."),
    preferredName: optional,
    birthDate: z
      .string()
      .min(1, "Enter the date of birth.")
      .refine(
        (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v) <= new Date(),
        "Enter a real date of birth, not in the future.",
      ),
    sexForClinicalUse: z.enum(["FEMALE", "MALE", "SPECIFIED", "UNKNOWN"], {
      message: "Choose sex for clinical use.",
    }),
    administrativeGender: z.enum(["FEMALE", "MALE", "OTHER", "UNKNOWN"]),
    phone,
    email: z.string().trim().email("Enter a valid email.").optional().or(z.literal("")),
    line1: optional,
    line2: optional,
    city: optional,
    state: optional,
    postalCode: z
      .string()
      .trim()
      .regex(/^(\d{5}(-\d{4})?)?$/, "Enter a 5-digit ZIP.")
      .optional(),
    contactPreference: optional,
    preferredLanguage: z.string().default("en"),
    // demographics
    raceCodes: z.array(z.string()).default([]),
    ethnicity: optional,
    genderIdentity: optional,
    pronouns: optional,
    sexualOrientation: optional,
    interpreterNeeded: z.boolean().default(false),
    // guarantor
    guarantor: z.enum(["self", "other"]).default("self"),
    guarantorFirstName: optional,
    guarantorLastName: optional,
    guarantorRelationship: optional,
    guarantorPhone: optional,
    emergencyFirstName: optional,
    emergencyLastName: optional,
    emergencyRelationship: optional,
    emergencyPhone: optional,
    // insurance
    selfPay: z.boolean().default(false),
    payerId: optional,
    planId: optional,
    memberId: optional,
    groupNumber: optional,
    subscriber: z.enum(["self", "guarantor"]).default("self"),
    // consents
    consentNpp: z.boolean().default(false),
    consentFinancial: z.boolean().default(false),
    consentSms: z.boolean().default(false),
    signerName: optional,
  })
  .superRefine((v, ctx) => {
    const partial = [v.line1, v.city, v.state, v.postalCode].filter((x) => x && x.trim()).length;
    if (partial > 0 && partial < 4) {
      for (const [k, val] of [
        ["line1", v.line1],
        ["city", v.city],
        ["state", v.state],
        ["postalCode", v.postalCode],
      ] as const) {
        if (!val?.trim())
          ctx.addIssue({
            code: "custom",
            path: [k],
            message: "Complete the address or leave it all blank.",
          });
      }
    }
    if (v.guarantor === "other") {
      if (!v.guarantorFirstName?.trim())
        ctx.addIssue({
          code: "custom",
          path: ["guarantorFirstName"],
          message: "Enter the guarantor's first name.",
        });
      if (!v.guarantorLastName?.trim())
        ctx.addIssue({
          code: "custom",
          path: ["guarantorLastName"],
          message: "Enter the guarantor's last name.",
        });
      if (!v.guarantorRelationship)
        ctx.addIssue({
          code: "custom",
          path: ["guarantorRelationship"],
          message: "Choose the relationship.",
        });
    }
    if (!v.selfPay && (v.payerId || v.memberId)) {
      if (!v.payerId)
        ctx.addIssue({ code: "custom", path: ["payerId"], message: "Choose the payer." });
      if (!v.memberId?.trim())
        ctx.addIssue({ code: "custom", path: ["memberId"], message: "Enter the member ID." });
    }
  });

export type RegistrationValues = z.input<typeof registrationSchema>;

export const STEPS = [
  {
    view: "",
    label: "Identity & contact",
    testId: "step-identity",
    fields: [
      "firstName",
      "lastName",
      "birthDate",
      "sexForClinicalUse",
      "administrativeGender",
      "phone",
      "email",
      "line1",
      "city",
      "state",
      "postalCode",
    ],
  },
  { view: "demographics", label: "Demographics", testId: "step-demographics", fields: [] },
  {
    view: "guarantor",
    label: "Guarantor",
    testId: "step-guarantor",
    fields: ["guarantorFirstName", "guarantorLastName", "guarantorRelationship"],
  },
  {
    view: "insurance",
    label: "Insurance",
    testId: "step-insurance",
    fields: ["payerId", "memberId"],
  },
  { view: "consents", label: "Consents", testId: "step-consents", fields: [] },
] as const;

export function ageYears(iso: string | undefined): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const b = new Date(`${iso}T00:00:00Z`);
  const n = new Date();
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (
    n.getUTCMonth() < b.getUTCMonth() ||
    (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())
  )
    a--;
  return a;
}

export const e164 = (v: string | undefined) => {
  const d = (v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `+1${d}` : undefined;
};
