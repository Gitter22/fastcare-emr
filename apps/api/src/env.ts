import { z } from "zod";

/**
 * Every required env var must be declared here AND documented in
 * `.env.example` at the repo root the moment it's introduced.
 *
 * TWO DATABASE URLS, DELIBERATELY:
 * - `DATABASE_URL` is used by `prisma migrate dev`/`prisma db seed` and must
 *   point at a privileged (superuser/migration) role -- creating the
 *   `app_api` role, RLS policies, and SECURITY DEFINER functions requires
 *   elevated privileges.
 * - `APP_DATABASE_URL` is what the running apps/api server actually
 *   connects with (the `app_api` role: NOSUPERUSER, NOBYPASSRLS). This is
 *   the connection Row-Level Security actually applies to -- a superuser
 *   connection bypasses RLS entirely, so the running server must never use
 *   `DATABASE_URL` for anything other than local one-off scripts.
 */
const envSchema = z.object({
  APP_NAME: z.preprocess((val) => val || undefined, z.string().min(1).default("Agile EMR")),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_DATABASE_URL: z.string().min(1, "APP_DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  PHI_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "PHI_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  }),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  DEV_STATIC_MFA_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  // Step 6 -- apps/fhir's base URL, called server-to-server ONLY for the
  // "Export Chart for Referral" flow (see routes/chartExport.ts). The
  // frontend never calls apps/fhir directly, per the FRD's own Step 6
  // acceptance bullet.
  FHIR_BASE_URL: z.string().min(1).default("http://localhost:8081"),
  // NLM RxNav base URL for drug search (see providers/drugTerminologyProvider.ts).
  // Public server by default; point at a self-hosted RxNav-in-a-Box for
  // production-grade uptime (same REST API).
  RXNAV_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("https://rxnav.nlm.nih.gov/REST"),
  ),
  // Allergen lookup (see providers/allergenTerminologyProvider.ts). SNOMED CT
  // allergen concepts come from a FHIR terminology server's ValueSet/$expand.
  // PRODUCTION target is NLM VSAC (https://cts.nlm.nih.gov/fhir) with
  // UMLS_API_KEY set. The default below is the public tx.fhir.org dev server
  // with interim SNOMED hierarchy value sets -- NOT the curated US allergen
  // value sets; see HANDOFF.md. Value-set URLs are per category.
  ALLERGEN_TERMINOLOGY_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("https://tx.fhir.org/r4"),
  ),
  UMLS_API_KEY: z.preprocess((val) => val || undefined, z.string().min(1).optional()),
  // Value-set URLs per category. DRUG_CLASS and ENVIRONMENT are deliberately
  // unset by default: SNOMED has no hierarchy root that yields only drug
  // classes (individual drugs sit under class concepts), and no root that
  // yields only environmental allergens. Unset = interim behaviour -- drug
  // classes come from the pinned list only, environmental from a built-in
  // inline value set (substances minus drugs and foods). Set real curated
  // value-set URLs (e.g. NLM VSAC) to replace either.
  ALLERGEN_VALUESET_DRUG_CLASS: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).optional(),
  ),
  ALLERGEN_VALUESET_FOOD: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("http://snomed.info/sct?fhir_vs=isa/255620007"),
  ),
  ALLERGEN_VALUESET_ENVIRONMENT: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).optional(),
  ),
  ALLERGEN_SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // NPI verification (see providers/npiRegistryProvider.ts). "stub" = deterministic
  // fixtures (dev/CI); "nppes" = the public CMS NPPES NPI Registry API (staging/prod;
  // public data, no PHI is ever sent). Point NPI_REGISTRY_BASE_URL at a self-hosted
  // mirror if the public server's rate limits/uptime become a problem.
  NPI_REGISTRY_PROVIDER: z.preprocess(
    (val) => val || undefined,
    z.enum(["stub", "nppes"]).default("stub"),
  ),
  NPI_REGISTRY_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("https://npiregistry.cms.hhs.gov/api/"),
  ),
  NPI_REGISTRY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NPI_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 3600),
  // Step 8 -- automatic daily backups (FRD Sec. 21). Relative paths are
  // resolved from the apps/api process's cwd.
  BACKUP_DIR: z.string().min(1).default("./backups"),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // Base URL of the patient-facing web app, used to build the consent-signing
  // link emailed to patients (see routes/consent.ts).
  WEB_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("http://localhost:5173"),
  ),
  // Gmail SMTP credentials for sending transactional emails (consent signing,
  // appointment reminders, etc). Optional: if not set, ConsoleEmailProvider
  // is used instead (logs to server console). See providers/emailProvider.ts.
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  // Twilio SMS (guardian OTP, appointment reminders). All three must be set
  // to use Twilio; otherwise ConsoleSmsProvider is used (logs to server
  // console). TWILIO_FROM_NUMBER must be an E.164 number you own. See
  // providers/smsProvider.ts.
  TWILIO_ACCOUNT_SID: z.preprocess((val) => val || undefined, z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess((val) => val || undefined, z.string().optional()),
  TWILIO_FROM_NUMBER: z.preprocess((val) => val || undefined, z.string().optional()),
  // Local-disk storage directories for uploaded/generated files (see
  // fileStorage.ts). The /tmp defaults are for local dev only: they do not
  // survive a reboot or a container recreate. docker-compose.yml overrides
  // all of these (plus BACKUP_DIR) to point at the persistent /data volume.
  // Empty values (e.g. a copied .env.example) fall back to the default, like
  // APP_NAME/WEB_BASE_URL above, rather than failing min(1).
  LAB_REPORT_UPLOADS_DIR: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("/tmp/agile-emr-lab-report-uploads"),
  ),
  GENERATED_DOCS_DIR: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("/tmp/agile-emr-generated-docs"),
  ),
  ID_PHOTO_UPLOADS_DIR: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("/tmp/agile-emr-id-photo-uploads"),
  ),
  PATIENT_DOCUMENT_UPLOADS_DIR: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("/tmp/agile-emr-patient-document-uploads"),
  ),
  // Step 10 -- Ambient AI Dictation ("Dictate Note"). Both optional: unset
  // means transcriptionProvider.ts/ambientScribeProvider.ts fall back to
  // their Stub implementations, so CI/local dev never depends on these LAN
  // services being reachable. ASR_BASE_URL points at an OpenAI-compatible
  // local Whisper server (faster-whisper-server/speaches); LLM_BASE_URL
  // points at a local Ollama server's base URL (not the full /api/chat path).
  ASR_BASE_URL: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().min(1).default("qwen3.5:9b"),
  // Stedi clearinghouse (eligibility 270/271, claims 837P, ERA 835). Optional:
  // unset means the eligibility/clearinghouse factories fall back to their
  // Stub implementations, so CI/local dev never depends on the network. A
  // sandbox account only issues TEST-mode keys (mock payers, no PHI, no
  // charge); a production key needs a BAA with Stedi first. See
  // providers/stediClient.ts.
  STEDI_API_KEY: z.preprocess((val) => val || undefined, z.string().optional()),
  STEDI_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("https://healthcare.us.stedi.com"),
  ),
  // Stedi's account-level APIs (transaction polling) live on a separate host
  // from the healthcare APIs above.
  STEDI_CORE_BASE_URL: z.preprocess(
    (val) => val || undefined,
    z.string().min(1).default("https://core.us.stedi.com"),
  ),
  // Stedi sends every claim submission as PRODUCTION unless it is explicitly
  // flagged as test data (usageIndicator "T"). Defaults to "test" so a
  // misconfigured environment can never send a claim to a real payer; going
  // live is a deliberate STEDI_CLAIMS_MODE=production.
  STEDI_CLAIMS_MODE: z.preprocess(
    (val) => val || undefined,
    z.enum(["test", "production"]).default("test"),
  ),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Lazily parsed so importing this module never throws at import time. */
export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}
