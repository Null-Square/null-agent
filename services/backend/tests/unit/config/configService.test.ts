import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type * as ConfigSchema from '@/config/configSchema';

// Vitest mocking pattern: mocks must be defined before imports
// We use vi.mock() with factory functions at the top level

const mockLoadAppConfig = vi.fn();
const mockGetNetworkSettings = vi.fn();
const mockGetSandboxSettings = vi.fn();
const mockGetRuntimeSettings = vi.fn();
const mockGetTraceSettings = vi.fn();
const mockGetAutomationSettings = vi.fn();
const mockGetTokenGuardSettings = vi.fn();
const mockGetSessionLifecycleSettings = vi.fn();
const mockLoadSandboxProfilesConfig = vi.fn();
const mockGetDefaultSandboxImage = vi.fn();
const mockGetHttpSettings = vi.fn();
const mockGetWebSearchSettings = vi.fn();
const mockSettingsPreload = vi.fn(async () => {});

vi.mock('@/config/configSchema', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigSchema>()),
  loadAppConfig: mockLoadAppConfig,
}));

vi.mock('@/domains/platform/settings/networkSettings', () => ({
  getNetworkSettings: mockGetNetworkSettings,
}));

vi.mock('@/domains/platform/settings/sandboxSettings', () => ({
  getSandboxSettings: mockGetSandboxSettings,
}));

vi.mock('@/domains/platform/settings/runtimeSettings', () => ({
  getRuntimeSettings: mockGetRuntimeSettings,
}));

vi.mock('@/domains/platform/settings/traceSettings', () => ({
  getTraceSettings: mockGetTraceSettings,
}));

vi.mock('@/domains/platform/settings/automationSettings', () => ({
  getAutomationSettings: mockGetAutomationSettings,
}));

vi.mock('@/domains/platform/settings/tokenGuardSettings', () => ({
  getTokenGuardSettings: mockGetTokenGuardSettings,
}));

vi.mock('@/domains/platform/settings/sessionLifecycleSettings', () => ({
  getSessionLifecycleSettings: mockGetSessionLifecycleSettings,
}));

vi.mock('@/domains/platform/settings/httpSettings', () => ({
  getHttpSettings: mockGetHttpSettings,
}));

vi.mock('@/domains/platform/settings/webSearchSettings', () => ({
  getWebSearchSettings: mockGetWebSearchSettings,
}));

vi.mock('@/config/sandboxProfilesConfig', () => ({
  loadSandboxProfilesConfig: mockLoadSandboxProfilesConfig,
  getDefaultSandboxImage: mockGetDefaultSandboxImage,
}));

// Unit tests should not require a live DB. ConfigService batches settings via SettingsService.preload().
vi.mock('@/domains/platform/settings/SettingsService', () => ({
  settingsService: {
    preload: mockSettingsPreload,
  },
}));

const originalEnv = { ...process.env };

const mockSettings = () => {
  const networkSettings = {
    corsAllowedOrigins: ['https://example.com'],
    allowOutbound: false,
    outboundAllowlist: [],
  };
  const sandboxSettings = {
    devUnsafe: false,
    cpuQuota: 1,
    memoryMb: 1024,
    pidsLimit: 256,
    stdoutLimitBytes: 999999,
  };
  const runtimeSettings = {
    turnTimeoutMs: 180_000,
    maxToolCallsPerTurn: 64,
    shellTimeoutMs: 222,
    webTimeoutMs: 15_000,
    webMaxBytes: 1_048_576,
    sessionTTLMinutes: 120,
  };
  const traceSettings = {
    traceInlineLimit: 1234,
    stdoutChunkSize: 65_536,
    traceCompressOverBytes: 1_048_576,
    traceRetentionDays: 14,
    traceLogsRoot: 'storage/object-store/traces',
    artifactDirName: '.trace-artifacts',
    artifactMaxChars: 20_000,
  };
  const automationSettings = {
    maxGuardRetries: 3,
    requireReport: true,
    turnTimeoutMs: 300_000,
    checkpointIntervalToolCalls: 10,
    reportMinLength: 500,
    workspaceBackupEnabled: false,
  };
  const tokenGuardSettings = {
    perSessionLimit: 0,
    perUserDailyLimit: 0,
    warningThresholdPct: 80,
  };
  const sessionLifecycleSettings = {
    maxAgeDays: 30,
    maxCountPerUser: 0,
    retentionEnabled: true,
  };
  const httpSettings = {
    logSlowMs: 750,
    logDebugSampleRate: 0,
    logQuietPaths: ['/health', '/metrics'],
    uploadsMaxBytes: 25 * 1024 * 1024,
  };
  const webSearchSettings = {
    provider: 'duck' as const,
    duckBaseUrl: 'https://duckduckgo.com/',
    duckLiteBaseUrl: 'https://duckduckgo.com/html/',
    tavilyBaseUrl: 'https://api.tavily.com/search',
    maxResults: 5,
    timeoutMs: 15_000,
    maxBytes: 1_048_576,
    tavilyApiKey: undefined,
  };
  return {
    networkSettings,
    sandboxSettings,
    runtimeSettings,
    traceSettings,
    automationSettings,
    tokenGuardSettings,
    sessionLifecycleSettings,
    httpSettings,
    webSearchSettings,
  };
};

describe('ConfigService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when legacy SANDBOX_MODE is provided', async () => {
    process.env.SANDBOX_MODE = 'host';
    mockLoadAppConfig.mockReturnValue({});

    const { ConfigService } = await import('@/config/configService');
    await expect(ConfigService.create()).rejects.toThrow(/SANDBOX_MODE is no longer supported/);
  });

  it('creates snapshot merging env and settings layers', async () => {
    const {
      networkSettings,
      sandboxSettings,
      runtimeSettings,
      traceSettings,
      automationSettings,
      tokenGuardSettings,
      sessionLifecycleSettings,
      httpSettings,
      webSearchSettings,
    } = mockSettings();

    mockLoadAppConfig.mockReturnValue({
      JWT_EXPIRES_IN: 3600,
      SESSION_RETENTION_ENABLED: false,
      TRACE_S3_FLUSH_INTERVAL_MS: 1500,
      TRACE_S3_FLUSH_MAX_EVENTS: 9,
    });
    mockGetNetworkSettings.mockResolvedValue(networkSettings);
    mockGetSandboxSettings.mockResolvedValue(sandboxSettings);
    mockGetRuntimeSettings.mockResolvedValue(runtimeSettings);
    mockGetTraceSettings.mockResolvedValue(traceSettings);
    mockGetAutomationSettings.mockResolvedValue(automationSettings);
    mockGetTokenGuardSettings.mockResolvedValue(tokenGuardSettings);
    mockGetSessionLifecycleSettings.mockResolvedValue(sessionLifecycleSettings);
    mockGetHttpSettings.mockResolvedValue(httpSettings);
    mockGetWebSearchSettings.mockResolvedValue(webSearchSettings);
    mockLoadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'default',
      profiles: { default: 'null-ai-sandbox:local' },
    });
    mockGetDefaultSandboxImage.mockReturnValue('null-ai-sandbox:local');

    const { ConfigService } = await import('@/config/configService');
    const service = await ConfigService.create();
    const cfg = service.get();

    // DB-only: sandbox.image now comes from registry, not env
    expect(cfg.sandbox.image).toBe('null-ai-sandbox:local');
    // DB-only: sandbox.user now hardcoded
    expect(cfg.sandbox.user).toBe('root');
    // DB-only: devUnsafe from sandbox settings
    expect(cfg.sandbox.devUnsafe).toBe(sandboxSettings.devUnsafe ?? false);
    expect(cfg.runtime.shellTimeoutMs).toBe(222);
    expect(cfg.runtime.turnTimeoutMs).toBe(runtimeSettings.turnTimeoutMs);
    expect(cfg.network.corsAllowedOrigins).toEqual(networkSettings.corsAllowedOrigins);
    expect(cfg.trace.artifactDirName).toBe('.trace-artifacts');
    expect(cfg.trace.s3FlushIntervalMs).toBe(1500);
    expect(cfg.trace.s3FlushMaxEvents).toBe(9);
    expect(cfg.sessionLifecycle.retentionEnabled).toBe(sessionLifecycleSettings.retentionEnabled);
    expect(cfg.http.logSlowMs).toBe(httpSettings.logSlowMs);
    expect(cfg.webSearch.duckBaseUrl).toBe(webSearchSettings.duckBaseUrl);
  });

  it('uses Tavily env overrides ahead of DB web search settings', async () => {
    const {
      networkSettings,
      sandboxSettings,
      runtimeSettings,
      traceSettings,
      automationSettings,
      tokenGuardSettings,
      sessionLifecycleSettings,
      httpSettings,
      webSearchSettings,
    } = mockSettings();

    mockLoadAppConfig.mockReturnValue({
      JWT_EXPIRES_IN: 3600,
      WEB_SEARCH_PROVIDER: 'tavily',
      WEB_SEARCH_BASE_URL: 'https://tavily.example/search',
      TAVILY_API_KEY: 'env-tavily-key',
    });
    mockGetNetworkSettings.mockResolvedValue(networkSettings);
    mockGetSandboxSettings.mockResolvedValue(sandboxSettings);
    mockGetRuntimeSettings.mockResolvedValue(runtimeSettings);
    mockGetTraceSettings.mockResolvedValue(traceSettings);
    mockGetAutomationSettings.mockResolvedValue(automationSettings);
    mockGetTokenGuardSettings.mockResolvedValue(tokenGuardSettings);
    mockGetSessionLifecycleSettings.mockResolvedValue(sessionLifecycleSettings);
    mockGetHttpSettings.mockResolvedValue(httpSettings);
    mockGetWebSearchSettings.mockResolvedValue({
      ...webSearchSettings,
      provider: 'duck',
      tavilyApiKey: 'db-tavily-key',
    });
    mockLoadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'default',
      profiles: { default: 'null-ai-sandbox:local' },
    });
    mockGetDefaultSandboxImage.mockReturnValue('null-ai-sandbox:local');

    const { ConfigService } = await import('@/config/configService');
    const service = await ConfigService.create();
    const cfg = service.get();

    expect(cfg.webSearch.provider).toBe('tavily');
    expect(cfg.webSearch.tavilyBaseUrl).toBe('https://tavily.example/search');
    expect(cfg.webSearch.tavilyApiKey).toBe('env-tavily-key');
  });

  it('withOverrides merges layers without mutating snapshot', async () => {
    const {
      networkSettings,
      sandboxSettings,
      runtimeSettings,
      traceSettings,
      automationSettings,
      tokenGuardSettings,
      sessionLifecycleSettings,
      httpSettings,
      webSearchSettings,
    } = mockSettings();
    mockLoadAppConfig.mockReturnValue({
      JWT_EXPIRES_IN: 3600,
    });
    mockGetNetworkSettings.mockResolvedValue(networkSettings);
    mockGetSandboxSettings.mockResolvedValue(sandboxSettings);
    mockGetRuntimeSettings.mockResolvedValue(runtimeSettings);
    mockGetTraceSettings.mockResolvedValue(traceSettings);
    mockGetAutomationSettings.mockResolvedValue(automationSettings);
    mockGetTokenGuardSettings.mockResolvedValue(tokenGuardSettings);
    mockGetSessionLifecycleSettings.mockResolvedValue(sessionLifecycleSettings);
    mockGetHttpSettings.mockResolvedValue(httpSettings);
    mockGetWebSearchSettings.mockResolvedValue(webSearchSettings);
    mockLoadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'default',
      profiles: { default: 'null-ai-sandbox:local' },
    });
    mockGetDefaultSandboxImage.mockReturnValue('null-ai-sandbox:local');

    const { ConfigService } = await import('@/config/configService');
    const service = await ConfigService.create();
    const base = service.get();

    const merged = service.withOverrides({
      sandbox: { ...base.sandbox, image: 'override-image' },
      runtime: { ...base.runtime, turnTimeoutMs: 42 },
      http: { ...base.http, logQuietPaths: ['/custom'] },
    });

    expect(merged.sandbox.image).toBe('override-image');
    expect(merged.runtime.turnTimeoutMs).toBe(42);
    expect(merged.http.logQuietPaths).toContain('/custom');
    expect(base.sandbox.image).not.toBe('override-image'); // snapshot untouched
  });
});





