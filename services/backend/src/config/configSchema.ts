import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '@/shared/logger';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((val) => (val ? val === 'true' : undefined));

/** A blank value counts as unset, so its default applies. */
const trimmedOrUnset = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const hostNamesFromEnv = z.preprocess(
  (value) => (typeof value === 'string' ? value : ''),
  z.string().transform((value) =>
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ),
);

/**
 * Null AI's own settings. They are needed before the database is up (the door, the owner key, the
 * person's code), so `localSettings()` parses them on their own. Each has one reader:
 *
 *   NULL_AI_BIND_HOST                       AppContainer (the listen address)
 *   NULL_AI_ALLOWED_HOSTS                   localHostOnly `allowedHosts`
 *   NULL_AI_APP_URL                         ownerKey `appUrl`
 *   NULL_AI_HOME, NULL_AI_OWNER_KEY_FILE    ownerKey `ownerKeyFile`
 *   NULL_AI_LAB_TARGETS                     verificationChecks `labTargetHosts`
 *   NULL_AI_CODE_ROOT                       codeSourceLocation `configuredCodeRoot`
 *   WORKSPACE_ROOT                          `workspaceRootDir` (ConfigService, code sources)
 *
 * AppContainer logs the effective values once at start.
 */
const localSettingsShape = {
  /** The address the backend listens on. Compose sets 0.0.0.0, behind its loopback-only publish. */
  NULL_AI_BIND_HOST: z.preprocess(trimmedOrUnset, z.string().default('127.0.0.1')),
  /** Host names the door accepts beside this computer's own (comma-separated, no ports). Default: none. */
  NULL_AI_ALLOWED_HOSTS: hostNamesFromEnv,
  /** Where the person opens the app, for the printed link and sign-in returns. Default: the Vite dev server. */
  NULL_AI_APP_URL: z
    .preprocess(trimmedOrUnset, z.string().default('http://localhost:8081'))
    .transform((url) => url.replace(/\/+$/, '')),
  /** The folder that holds the owner key. */
  NULL_AI_HOME: z.preprocess(trimmedOrUnset, z.string().default(() => path.join(homedir(), '.null-ai'))),
  /** The owner key file itself; when set, it is used instead of NULL_AI_HOME/owner-key. */
  NULL_AI_OWNER_KEY_FILE: z.preprocess(trimmedOrUnset, z.string().optional()),
  /** Practice targets that verify as "lab" (comma-separated host names). Default: none. */
  NULL_AI_LAB_TARGETS: hostNamesFromEnv,
  /** A scope's code folder must resolve inside this folder. Default: unset, any folder. */
  NULL_AI_CODE_ROOT: z.preprocess(trimmedOrUnset, z.string().optional()),
  /** Sandbox workspaces and code-source clones, relative to the working directory. Default: storage/workspaces. */
  WORKSPACE_ROOT: z.preprocess(trimmedOrUnset, z.string().optional()),
};

const localSettingsSchema = z.object(localSettingsShape);

export type LocalSettings = z.infer<typeof localSettingsSchema>;

/** Null AI's own settings from the environment, with their defaults. Needs no database. */
export const localSettings = (env: NodeJS.ProcessEnv = process.env): LocalSettings =>
  localSettingsSchema.parse(env);

/** WORKSPACE_ROOT, resolved against the working directory. */
export const workspaceRootDir = (workspaceRoot: string | undefined): string =>
  workspaceRoot
    ? path.resolve(process.cwd(), workspaceRoot)
    : path.resolve(process.cwd(), 'storage', 'workspaces');

const optionalUrlFromEnv = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().url().optional(),
);

const optionalCallbackSchemeFromEnv = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.enum(['http', 'https']).optional(),
);

export const appConfigSchema = z.object({
  // ============================================================================
  // Essential env vars (secrets, instance-specific, external URLs)
  // ============================================================================
  TEST_DATABASE_URL: optionalUrlFromEnv,
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),

  // ---------------------------------------------------------------------------
  // Threat Watch (PRD docs/prd/3.1/threat-watch-cve-exposure.md)
  //
  // Operational controls live in the audited `threat_watch` database setting.
  // Only the provider credential remains in the process environment.
  // ---------------------------------------------------------------------------
  /**
   * Keyless NVD allows 5 requests per 30s; a key raises it to 50. A cold
   * backfill walks ~77 windows, so keyless turns hours into days.
   */
  THREAT_WATCH_NVD_API_KEY: z.string().optional(),

  // Null AI's own settings (see localSettingsShape above).
  ...localSettingsShape,

  // Workspace paths (instance-specific - needed for local file ops/sandbox mounts)
  WORKSPACE_MAX_BYTES: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().positive().optional()),
  WORKSPACE_OBJECT_STORE_DIR: z.string().optional(),
  WORKSPACE_ARTIFACTS_ROOT: z.string().optional(),

  // REMOVED Dec 2025: AI_API_BASE_URL, AI_API_KEY - models are seeded in DB with API keys

  // Web search provider settings stay DB-backed; env can supply secrets and local overrides.
  TAVILY_API_KEY: z.string().optional(),
  WEB_SEARCH_PROVIDER: z.enum(['duck', 'tavily']).optional(),
  WEB_SEARCH_BASE_URL: optionalUrlFromEnv,

  // S3 credentials (secrets)
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(), // Browser-accessible endpoint for presigned URLs
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnv,
  S3_AUTO_CREATE_BUCKETS: booleanFromEnv,
  S3_BUCKET_ARTIFACTS: z.string().optional(),
  S3_BUCKET_TRACES: z.string().optional(),
  S3_BUCKET_WORKSPACES: z.string().optional(),
  TRACE_S3_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  TRACE_S3_FLUSH_MAX_EVENTS: z.coerce.number().int().positive().optional(),
  AGENT_SAME_TURN_COMPACTION: booleanFromEnv,
  AGENT_SAME_TURN_COMPACTION_MIN_PROMPT_TOKENS: z.coerce.number().int().positive().optional(),
  AGENT_SAME_TURN_COMPACTION_MIN_TOOL_RESULTS: z.coerce.number().int().positive().optional(),
  AGENT_SAME_TURN_COMPACTION_KEEP_LAST_TOOL_RESULTS: z.coerce.number().int().positive().optional(),
  AGENT_SAME_TURN_COMPACTION_MAX_RESULT_TOKENS: z.coerce.number().int().positive().optional(),
  AGENT_SAME_TURN_COMPACTION_MAX_RESULT_CHARS: z.coerce.number().int().positive().optional(),

  // Instance-specific
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  ENABLE_WORKERS: booleanFromEnv,
  APP_ROLE: z.enum(['api', 'worker']).optional(),

  // Shared cloud-run admission is automatic in production and direct-start in
  // development/test. Missing or mismatched calibration holds admission.
  CLOUD_RUNNER_NAME: z.string().trim().min(1).optional(),
  CLOUD_RUN_CLAIM_TTL_MS: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_HEARTBEAT_MAX_AGE_MS: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_FREE_STARVATION_MS: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_PLAN_STARVATION_MS: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_FREE_BACKLOG: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_PAID_BACKLOG: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_PRO_BACKLOG: z.coerce.number().int().positive().optional(),
  CLOUD_RUN_INTERNAL_BACKLOG: z.coerce.number().int().positive().optional(),

  // Out-of-band callback service. URL unset keeps offline/file fallback mode.
  INTERACTSH_SERVER_URL: optionalUrlFromEnv,
  INTERACTSH_SERVER_AUTH_TOKEN: z.string().optional(),
  INTERACTSH_CALLBACK_DOMAIN: z.string().optional(),
  INTERACTSH_CALLBACK_SCHEME: optionalCallbackSchemeFromEnv,
  INTERACTSH_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  OOB_TOKEN_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  OOB_TOKEN_MAX_TTL_SECONDS: z.coerce.number().int().positive().optional(),

  // Sandbox snapshot interval (operational)
  AGENT_SESSION_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  SANDBOX_NETWORK: z.string().optional(),

  // Run/session performance summaries. PROMETHEUS_URL unset keeps trace-only mode.
  PERFORMANCE_SUMMARY_ENABLED: booleanFromEnv,
  PROMETHEUS_URL: optionalUrlFromEnv,
  PERFORMANCE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PERFORMANCE_QUERY_MAX_RANGE_HOURS: z.coerce.number().int().positive().optional(),
  PERFORMANCE_QUERY_STEP_SECONDS: z.coerce.number().int().positive().optional(),
  // Sample `docker stats` during sandbox container life (per-container CPU/mem/PID/net),
  // independent of cAdvisor/Prometheus. Default on; works on Docker Desktop/WSL2.
  PERFORMANCE_DOCKER_STATS_ENABLED: booleanFromEnv,
  PERFORMANCE_DOCKER_STATS_INTERVAL_MS: z.coerce.number().int().positive().optional(),

  MODEL_API_KEY_ENCRYPTION_KEY: z.string().optional(),
  ACCESS_MATERIALS_ENCRYPTION_KEY: z.string().optional(),

  // ============================================================================
  // REMOVED Dec 2025: Hardcoded to sensible defaults
  // - LOG_INCLUDE_DOCKER, LOG_VERBOSE_SANDBOX → use NODE_ENV === 'development'
  // - AUTOMATION_REQUIRE_REPORT → hardcoded true
  // - ACCESS_CONTROL_ENABLED → hardcoded true
  // - SESSION_RETENTION_ENABLED → hardcoded true
  // - TRACE_LOGS_ROOT → uses WORKSPACE_OBJECT_STORE_DIR/traces
  // ============================================================================
});

export type AppConfigEnv = z.infer<typeof appConfigSchema>;

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfigEnv {
  const patchedEnv: NodeJS.ProcessEnv = { ...env };

  // Provide sane defaults during tests to avoid process.exit on missing env
  if (patchedEnv.NODE_ENV === 'test') {
    // Prefer TEST_DATABASE_URL when running tests
    if (patchedEnv.TEST_DATABASE_URL) {
      patchedEnv.DATABASE_URL = patchedEnv.TEST_DATABASE_URL;
    }
    patchedEnv.DATABASE_URL = patchedEnv.DATABASE_URL ?? 'postgres://test:test@localhost:5432/testdb';
  }

  const parsed = appConfigSchema.safeParse(patchedEnv);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    if (patchedEnv.NODE_ENV === 'test') {
      throw new Error(`[config] Invalid environment (test): ${message}`);
    }
    logger.error(`[config] Invalid environment: ${message}`);
    process.exit(1);
  }
  return parsed.data;
}
