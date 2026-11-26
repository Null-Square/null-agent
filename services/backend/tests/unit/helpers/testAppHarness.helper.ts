import { vi } from 'vitest';
import http from 'http';
import createHttpApp from '@/interfaces/http/httpServer';
import type { AppContext } from '@/app/createAppContext';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

const baseConfig = {
  network: { corsAllowedOrigins: [] },
  trace: {
    traceLogsRoot: 'storage/traces',
    traceInlineLimit: 0,
    stdoutChunkSize: 0,
    traceCompressOverBytes: 0,
    traceRetentionDays: 0,
    artifactDirName: '.artifacts',
    artifactMaxChars: 0,
  },
  sandbox: {},
  runtime: {
    turnTimeoutMs: 1000,
    maxToolCallsPerTurn: 4,
    shellTimeoutMs: 1000,
    webTimeoutMs: 1000,
    webMaxBytes: 1024,
  },
  workspace: { rootDir: '/tmp/ws', objectStoreRoot: '/tmp/obj', maxBytesPerWorkspace: undefined },
  http: {
    logSlowMs: 750,
    logDebugSampleRate: 0,
    logQuietPaths: [],
    uploadsMaxBytes: 25 * 1024 * 1024,
  },
  webSearch: {
    provider: 'duck',
    duckBaseUrl: 'https://duckduckgo.com/',
    duckLiteBaseUrl: 'https://duckduckgo.com/html/',
    tavilyBaseUrl: 'https://api.tavily.com/search',
    maxResults: 5,
    timeoutMs: 15_000,
    maxBytes: 1_048_576,
    tavilyApiKey: undefined,
  },
};

/**
 * Build a minimal AppContext for HTTP contract/integration tests.
 * Callers can override any subset of the context.
 */
export const createStubAppContext = (overrides: DeepPartial<AppContext> = {}): Partial<AppContext> => {
  const sandbox = (overrides.sandbox ??
    { listSandboxes: vi.fn(async () => []), isHealthy: vi.fn(() => true) }) as any;
  const sessionStore = (overrides.sessionStore ??
    {
      listSessions: vi.fn(() => []),
      get: vi.fn(() => undefined),
      setToolSchemaProvider: vi.fn(),
    }) as any;
  const streamBroker = (overrides.streamBroker ?? { emit: vi.fn() }) as any;
  const usageStore = (overrides.usageStore ?? {}) as any;
  const workspaceManager = (overrides.workspaceManager ?? { getMetrics: vi.fn(() => ({})) }) as any;
  const agentServices = {
    streamBroker,
    sessionStore,
    checkpointManager: {},
    sandbox,
    toolsRegistry: {
      getToolSchemas: vi.fn(() => []),
      setWorkerDelegationService: vi.fn(),
    },
    orchestrator: {},
    traceRecorder: overrides.traceRecorder as any,
    usageTracker: {},
    sandboxProfileRegistry: {},
    usageStore,
    ports: { events: {}, tools: {}, context: {}, sandbox: {}, telemetry: {}, tasks: {} },
    agentEngine: {},
    artifactService: { getStorageRoot: vi.fn(() => '/tmp/artifacts') },
    policyResolver: {},
    policyFacade: overrides.policyFacade as any,
    policyTelemetry: undefined,
    tokenGuard: {},
    s3ArtifactsClient: undefined,
    s3WorkspacesClient: undefined,
    ...(overrides.agentServices as Record<string, unknown> | undefined),
  } as any;

  return {
    config: baseConfig as any,
    isDev: true,
    sandbox,
    streamBroker,
    sessionStore,
    agentServices,
    usageStore,
    workspaceManager,
    traceRecorder: overrides.traceRecorder as any,
    policyResolver: overrides.policyResolver as any,
    policyFacade: overrides.policyFacade as any,
  };
};

/**
 * Create an Express app and HTTP server for contract tests.
 * Returns both server and an async close helper.
 */
export const createTestServer = (overrides: DeepPartial<AppContext> = {}): { server: http.Server; close: () => Promise<void> } => {
  const appContext = createStubAppContext(overrides);
  const app = createHttpApp(appContext as AppContext);
  const server = app.listen();
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
