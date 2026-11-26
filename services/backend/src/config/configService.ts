import path from 'path';
import { type AppConfigEnv, loadAppConfig, workspaceRootDir } from './configSchema';
import { getNetworkSettings } from '@/domains/platform/settings/networkSettings';
import { getSandboxSettings } from '@/domains/platform/settings/sandboxSettings';
import { getRuntimeSettings } from '@/domains/platform/settings/runtimeSettings';
import { getTraceSettings } from '@/domains/platform/settings/traceSettings';
import { getAutomationSettings } from '@/domains/platform/settings/automationSettings';
import { getHttpSettings } from '@/domains/platform/settings/httpSettings';
import { getWebSearchSettings } from '@/domains/platform/settings/webSearchSettings';
import { getTokenGuardSettings } from '@/domains/platform/settings/tokenGuardSettings';
import { getSessionLifecycleSettings } from '@/domains/platform/settings/sessionLifecycleSettings';
import { getDefaultSandboxImage, loadSandboxProfilesConfig } from '@/config/sandboxProfilesConfig';
import { settingsService } from '@/domains/platform/settings/SettingsService';
import type { ConfigOverrides, ResolvedConfig } from './configTypes';

const mergeLayer = <T>(base: T, overrides: Partial<T> = {}): T => ({ ...base, ...overrides });
const defaultPerformanceConfig = {
  enabled: true,
  queryTimeoutMs: 2_500,
  maxRangeHours: 24,
  queryStepSeconds: 30,
  dockerStatsEnabled: true,
  dockerStatsIntervalMs: 5_000,
};
const requireSetting = <T>(value: T | null | undefined, key: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`[Config] Missing required setting: ${key}. Seed settings in database.`);
  }
  return value;
};
const optionalNonEmpty = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export class ConfigService {
  private snapshot: ResolvedConfig;
  private env: AppConfigEnv;

  private constructor(snapshot: ResolvedConfig, env: AppConfigEnv) {
    this.snapshot = snapshot;
    this.env = env;
  }

  static async create(): Promise<ConfigService> {
    const env = loadAppConfig(process.env);
    if (process.env.SANDBOX_MODE !== undefined) {
      throw new Error('[Config] SANDBOX_MODE is no longer supported; docker-only execution is enforced.');
    }
    // REMOVED Dec 2025: SANDBOX_HOST_FALLBACK check - removed from schema
    // Batch-fetch all settings in a single DB query, then let individual getters hit cache
    await settingsService.preload([
      'network', 'sandbox', 'runtime', 'trace',
      'automation', 'http',
      'web_search', 'token_guard', 'session_lifecycle',
    ]);
    const [
      networkSettings,
      sandboxSettings,
      runtimeSettings,
      traceSettings,
      automationSettings,
      httpSettings,
      webSearchSettings,
      tokenGuardSettings,
      sessionLifecycleSettings,
    ] = await Promise.all([
      getNetworkSettings(),
      getSandboxSettings(),
      getRuntimeSettings(),
      getTraceSettings(),
      getAutomationSettings(),
      getHttpSettings(),
      getWebSearchSettings(),
      getTokenGuardSettings(),
      getSessionLifecycleSettings(),
    ]);

    const sandboxProfiles = await loadSandboxProfilesConfig();
    const defaultImageTag = getDefaultSandboxImage(sandboxProfiles);

    const workspaceRoot = workspaceRootDir(env.WORKSPACE_ROOT);
    const objectStoreRoot = env.WORKSPACE_OBJECT_STORE_DIR
      ? path.resolve(process.cwd(), env.WORKSPACE_OBJECT_STORE_DIR)
      : path.resolve(process.cwd(), 'storage', 'object-store');
    const artifactStorageRoot = env.WORKSPACE_ARTIFACTS_ROOT
      ? path.resolve(process.cwd(), env.WORKSPACE_ARTIFACTS_ROOT)
      : path.resolve(objectStoreRoot, 'artifacts');
    const webSearchProvider = env.WEB_SEARCH_PROVIDER ?? webSearchSettings.provider;
    const tavilyBaseUrl = env.WEB_SEARCH_BASE_URL ?? webSearchSettings.tavilyBaseUrl;
    const tavilyApiKey = optionalNonEmpty(env.TAVILY_API_KEY) ?? webSearchSettings.tavilyApiKey;

    const snapshot: ResolvedConfig = {
      sandbox: {
        image: defaultImageTag,
        network: optionalNonEmpty(env.SANDBOX_NETWORK) ?? 'bridge',
        devUnsafe: requireSetting(sandboxSettings.devUnsafe, 'sandbox.devUnsafe'),
        // AUTHORITATIVE: Default sandbox user. 'root' is safe since containers are isolated.
        // TODO(P2): Consider per-profile user config instead of global default.
        user: 'root',
        cpuQuota: requireSetting(sandboxSettings.cpuQuota, 'sandbox.cpuQuota'),
        memoryMb: requireSetting(sandboxSettings.memoryMb, 'sandbox.memoryMb'),
        pidsLimit: requireSetting(sandboxSettings.pidsLimit, 'sandbox.pidsLimit'),
        stdoutLimitBytes: requireSetting(sandboxSettings.stdoutLimitBytes, 'sandbox.stdoutLimitBytes'),
      },
      runtime: {
        // DB-only (Dec 2025) - models are seeded in DB with API keys
        // NOTE: apiBaseUrl/apiKey populated from model DB table, not env vars
        turnTimeoutMs: requireSetting(runtimeSettings.turnTimeoutMs, 'runtime.turnTimeoutMs'),
        maxToolCallsPerTurn: requireSetting(runtimeSettings.maxToolCallsPerTurn, 'runtime.maxToolCallsPerTurn'),
        shellTimeoutMs: requireSetting(runtimeSettings.shellTimeoutMs, 'runtime.shellTimeoutMs'),
        webTimeoutMs: requireSetting(runtimeSettings.webTimeoutMs, 'runtime.webTimeoutMs'),
        webMaxBytes: requireSetting(runtimeSettings.webMaxBytes, 'runtime.webMaxBytes'),
        sessionTTLMinutes: requireSetting(runtimeSettings.sessionTTLMinutes, 'runtime.sessionTTLMinutes'),
      },
      policy: {
        // SIMPLIFIED Dec 2025: verbose logging based on NODE_ENV
        verboseLogging: env.NODE_ENV === 'development',
      },
      automation: {
        maxGuardRetries: requireSetting(automationSettings.maxGuardRetries, 'automation.maxGuardRetries'),
        requireReport: requireSetting(automationSettings.requireReport, 'automation.requireReport'),
        turnTimeoutMs: requireSetting(automationSettings.turnTimeoutMs, 'automation.turnTimeoutMs'),
        checkpointIntervalToolCalls: requireSetting(
          automationSettings.checkpointIntervalToolCalls,
          'automation.checkpointIntervalToolCalls',
        ),
        reportMinLength: requireSetting(automationSettings.reportMinLength, 'automation.reportMinLength'),
        workspaceBackupEnabled: requireSetting(
          automationSettings.workspaceBackupEnabled,
          'automation.workspaceBackupEnabled',
        ),
      },
      accessControl: {
        enabled: true,  // Hardcoded: always enabled
      },
      trace: {
        traceInlineLimit: requireSetting(traceSettings.traceInlineLimit, 'trace.traceInlineLimit'),
        stdoutChunkSize: requireSetting(traceSettings.stdoutChunkSize, 'trace.stdoutChunkSize'),
        traceCompressOverBytes: requireSetting(traceSettings.traceCompressOverBytes, 'trace.traceCompressOverBytes'),
        traceRetentionDays: requireSetting(traceSettings.traceRetentionDays, 'trace.traceRetentionDays'),
        traceLogsRoot: path.resolve(process.cwd(), requireSetting(traceSettings.traceLogsRoot, 'trace.traceLogsRoot')),
        artifactDirName: requireSetting(traceSettings.artifactDirName, 'trace.artifactDirName'),
        artifactMaxChars: requireSetting(traceSettings.artifactMaxChars, 'trace.artifactMaxChars'),
        s3FlushIntervalMs: env.TRACE_S3_FLUSH_INTERVAL_MS ?? 5_000,
        s3FlushMaxEvents: env.TRACE_S3_FLUSH_MAX_EVENTS ?? 25,
        // REMOVED Dec 2025: keepLocalCopy, localMirrorPath (unused)
      },
      network: {
        corsAllowedOrigins: requireSetting(networkSettings.corsAllowedOrigins, 'network.corsAllowedOrigins'),
        allowOutbound: requireSetting(networkSettings.allowOutbound, 'network.allowOutbound'),
        outboundAllowlist: requireSetting(networkSettings.outboundAllowlist, 'network.outboundAllowlist'),
      },
      workspace: {
        maxBytesPerWorkspace: env.WORKSPACE_MAX_BYTES,
        rootDir: workspaceRoot,
        objectStoreRoot,
        artifactStorageRoot,
      },
      manifests: {
        // SIMPLIFIED: built-in tools only (task template manifests removed)
        toolsDir: path.resolve(__dirname, '../domains/agent-brain/adapters/tools/builtins'),
        toolDevWatch: false,
      },
      webSearch: {
        duckBaseUrl: requireSetting(webSearchSettings.duckBaseUrl, 'webSearch.duckBaseUrl'),
        duckLiteBaseUrl: requireSetting(webSearchSettings.duckLiteBaseUrl, 'webSearch.duckLiteBaseUrl'),
        tavilyBaseUrl: requireSetting(tavilyBaseUrl, 'webSearch.tavilyBaseUrl'),
        provider: requireSetting(webSearchProvider, 'webSearch.provider'),
        maxResults: requireSetting(webSearchSettings.maxResults, 'webSearch.maxResults'),
        tavilyApiKey,
        timeoutMs: requireSetting(webSearchSettings.timeoutMs, 'webSearch.timeoutMs'),
        maxBytes: requireSetting(webSearchSettings.maxBytes, 'webSearch.maxBytes'),
      },
      http: {
        logSlowMs: requireSetting(httpSettings.logSlowMs, 'http.logSlowMs'),
        logDebugSampleRate: requireSetting(httpSettings.logDebugSampleRate, 'http.logDebugSampleRate'),
        logQuietPaths: requireSetting(httpSettings.logQuietPaths, 'http.logQuietPaths'),
        uploadsMaxBytes: requireSetting(httpSettings.uploadsMaxBytes, 'http.uploadsMaxBytes'),
      },
      // Session retention (Gemini-style simple TTL)
      sessionLifecycle: {
        maxAgeDays: requireSetting(sessionLifecycleSettings.maxAgeDays, 'sessionLifecycle.maxAgeDays'),
        maxCountPerUser: requireSetting(sessionLifecycleSettings.maxCountPerUser, 'sessionLifecycle.maxCountPerUser'),
        retentionEnabled: requireSetting(sessionLifecycleSettings.retentionEnabled, 'sessionLifecycle.retentionEnabled'),
      },
      tokenGuard: {
        perSessionLimit: requireSetting(tokenGuardSettings.perSessionLimit, 'tokenGuard.perSessionLimit'),
        perUserDailyLimit: requireSetting(tokenGuardSettings.perUserDailyLimit, 'tokenGuard.perUserDailyLimit'),
        warningThresholdPct: requireSetting(tokenGuardSettings.warningThresholdPct, 'tokenGuard.warningThresholdPct'),
      },
      oob: {
        interactshServerUrl: optionalNonEmpty(env.INTERACTSH_SERVER_URL),
        interactshAuthToken: optionalNonEmpty(env.INTERACTSH_SERVER_AUTH_TOKEN),
        interactshCallbackDomain: optionalNonEmpty(env.INTERACTSH_CALLBACK_DOMAIN),
        interactshCallbackScheme: env.INTERACTSH_CALLBACK_SCHEME,
        pollIntervalSeconds: Number(env.INTERACTSH_POLL_INTERVAL_SECONDS ?? 10),
        tokenDefaultTtlSeconds: Number(env.OOB_TOKEN_DEFAULT_TTL_SECONDS ?? 60 * 60),
        tokenMaxTtlSeconds: Number(env.OOB_TOKEN_MAX_TTL_SECONDS ?? 24 * 60 * 60),
      },
      performance: {
        enabled: env.PERFORMANCE_SUMMARY_ENABLED ?? true,
        prometheusUrl: optionalNonEmpty(env.PROMETHEUS_URL),
        queryTimeoutMs: Number(env.PERFORMANCE_QUERY_TIMEOUT_MS ?? 2_500),
        maxRangeHours: Number(env.PERFORMANCE_QUERY_MAX_RANGE_HOURS ?? 24),
        queryStepSeconds: Number(env.PERFORMANCE_QUERY_STEP_SECONDS ?? 30),
        dockerStatsEnabled: env.PERFORMANCE_DOCKER_STATS_ENABLED ?? true,
        dockerStatsIntervalMs: Number(env.PERFORMANCE_DOCKER_STATS_INTERVAL_MS ?? 5_000),
      },
    };

    return new ConfigService(snapshot, env);
  }

  get(): ResolvedConfig {
    return this.snapshot;
  }

  getEnv(): AppConfigEnv {
    return this.env;
  }

  withOverrides(overrides: ConfigOverrides): ResolvedConfig {
    return {
      sandbox: mergeLayer(this.snapshot.sandbox, overrides.sandbox),
      runtime: mergeLayer(this.snapshot.runtime, overrides.runtime),
      policy: mergeLayer(this.snapshot.policy ?? {}, overrides.policy),
      automation: mergeLayer(this.snapshot.automation, overrides.automation),
      accessControl: mergeLayer(this.snapshot.accessControl, overrides.accessControl),
      trace: mergeLayer(this.snapshot.trace, overrides.trace),
      network: mergeLayer(this.snapshot.network, overrides.network),
      workspace: mergeLayer(this.snapshot.workspace, overrides.workspace),
      manifests: mergeLayer(this.snapshot.manifests, overrides.manifests),
      webSearch: mergeLayer(this.snapshot.webSearch, overrides.webSearch),
      http: mergeLayer(this.snapshot.http, overrides.http),
      sessionLifecycle: mergeLayer(this.snapshot.sessionLifecycle, overrides.sessionLifecycle),
      tokenGuard: mergeLayer(this.snapshot.tokenGuard, overrides.tokenGuard),
      oob: mergeLayer(this.snapshot.oob, overrides.oob),
      performance: mergeLayer(this.snapshot.performance ?? defaultPerformanceConfig, overrides.performance),
    };
  }
}
