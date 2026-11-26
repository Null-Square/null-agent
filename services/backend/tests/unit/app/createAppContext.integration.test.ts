import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import * as storageFactories from '@/app/factories/storage';
import * as telemetryFactories from '@/app/factories/telemetry';
import * as orchestrationFactories from '@/app/factories/orchestration';

// Note: Set test timeout via vitest.config.ts testTimeout option

vi.mock('@/db/client', () => {
  // Create chainable mock that returns empty array for any query
  const createQueryChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      then: vi.fn((resolve: any) => resolve([])),
    };
    return chain;
  };
  
  return {
    db: {
      select: vi.fn(() => createQueryChain()),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      query: {},
    },
    getPool: () => ({
      query: vi.fn(async () => ({ rows: [{ oid: '1' }] })),
    }),
  };
});

// Mock bootstrapConfig to avoid loading real environment
vi.mock('@/config/bootstrapConfig', () => ({
  __esModule: true,
  config: {
    port: 3000,
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    dbPoolMax: 10,
    workspaceRoot: '/tmp/workspaces',
    workspaceObjectStoreDir: '/tmp/object-store',
    jwt: { secret: 'test-secret', expiresInSeconds: 3600 },
    nodeEnv: 'test',
    workspaceMaxBytes: 1024 * 1024 * 100,
    snapshotIntervalMs: 60000,
    s3: {
      endpoint: undefined,
      region: 'us-east-1',
      accessKeyId: undefined,
      secretAccessKey: undefined,
      forcePathStyle: true,
      artifactsBucket: undefined,
      tracesBucket: undefined,
      workspacesBucket: undefined,
    },
    enableWorkers: false,
    appRole: 'api',
    AWS_REGION: undefined,
    RESEND_API_KEY: undefined,
  },
  env: {
    port: 3000,
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    nodeEnv: 'test',
    appRole: 'api',
    enableWorkers: false,
  },
  default: {
    port: 3000,
    nodeEnv: 'test',
  },
}));

vi.mock('@/app/factories/storage', () => {
  const redis = {
    quit: vi.fn(async () => undefined),
    ping: vi.fn(async () => 'PONG'),
    publish: vi.fn(async () => 1),
    subscribe: vi.fn((_, cb) => cb && cb(null)),
    on: vi.fn(),
    duplicate: vi.fn(() => redis),
  };

  const redisClients = {
    redis,
    publisher: { ...redis },
    subscriber: { ...redis },
  };

  const workspaceManager = {
    allocateWorkspace: vi.fn(() => '/tmp/ws'),
    ensureWorkspace: vi.fn(async () => undefined),
    cleanupWorkspace: vi.fn(async () => undefined),
    startJanitor: vi.fn(),
    startQuotaEnforcer: vi.fn(),
    stopJanitor: vi.fn(),
    stopQuotaEnforcer: vi.fn(),
    getMetrics: vi.fn(() => ({})),
  };

  const sessionPersistenceBundle = {
    redisPersistence: {
      enableInvalidation: vi.fn(),
      onInvalidate: vi.fn(),
    },
    sessionRepository: {},
    messageRepository: {},
    artifactRepository: {},
    checkpointRepository: {},
    sessionPersistence: {},
  };

  const s3Bundle = {
    s3Client: { ensureBucket: vi.fn(async () => undefined) },
    s3TracesClient: { ensureBucket: vi.fn(async () => undefined) },
    s3WorkspacesClient: { ensureBucket: vi.fn(async () => undefined), upload: vi.fn(), download: vi.fn(), delete: vi.fn() },
    s3ArtifactsBucket: 'artifacts',
    s3TracesBucket: 'traces',
    s3WorkspacesBucket: 'workspaces',
  };

  return {
    createRedisClients: vi.fn((_url, lifecycle) => {
      lifecycle?.track(() => redis.quit());
      return redisClients;
    }),
    createWorkspaceManager: vi.fn(() => workspaceManager),
    createSessionPersistence: vi.fn(() => sessionPersistenceBundle),
    createS3Bundle: vi.fn(() => s3Bundle),
    createUsageStore: vi.fn(() => ({ usage: true })),
    createDistributedLock: vi.fn(() => ({ withLock: vi.fn((_, fn) => fn()) })),
    __mocks: { redisClients, workspaceManager },
  };
});

vi.mock('@/app/factories/telemetry', () => {
  const traceRecorder = {
    write: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
  };
  const traceRetention = {
    cleanup: vi.fn(async () => undefined),
  };
  return {
    createTraceRecorder: vi.fn(() => traceRecorder),
    createTraceRetention: vi.fn(() => traceRetention),
    __mocks: { traceRecorder, traceRetention },
  };
});

vi.mock('@/app/factories/orchestration', () => {
  const streamBroker = { emit: vi.fn(), observe: vi.fn(() => vi.fn()) };
  const usageTracker = { track: vi.fn() };
  const modelService = { getDefaultOrNull: vi.fn(async () => ({ modelName: 'mock-model' })) };
  const dockerProfileService = { start: vi.fn(), stop: vi.fn() };
  const taskCatalog = { list: vi.fn(() => []) };
  const sandboxProfileRegistry = {};
  const checkpointManager = {};
  const toolsRegistry = { getToolSchemas: vi.fn(() => []) };
  const artifactService = {};
  const ports = {
    tasks: {},
    context: {},
    tools: {},
    sandbox: {},
    telemetry: {},
    events: {},
  };
  const orchestrator = { setModelName: vi.fn() };
  const agentEngine = {};
  const agentServices = { ok: true, artifactService, policyResolver: {} };

  return {
    createStreamBroker: vi.fn(() => streamBroker),
    createUsageTracker: vi.fn(() => usageTracker),
    createModelService: vi.fn(() => modelService),
    createDockerProfileService: vi.fn(() => dockerProfileService),
    createTaskCatalog: vi.fn(() => taskCatalog),
    createSandboxProfileRegistry: vi.fn(() => sandboxProfileRegistry),
    createCheckpointManager: vi.fn(() => checkpointManager),
    createToolsRegistry: vi.fn(() => toolsRegistry),
    createArtifactService: vi.fn(() => artifactService),
    createPorts: vi.fn(() => ports),
    createOrchestrator: vi.fn(() => orchestrator),
    createAgentEngine: vi.fn(() => agentEngine),
    createAgentServicesFactory: vi.fn(() => agentServices),
    __mocks: {
      streamBroker,
      usageTracker,
      modelService,
      dockerProfileService,
      taskCatalog,
      sandboxProfileRegistry,
      checkpointManager,
      toolsRegistry,
      artifactService,
      ports,
      orchestrator,
      agentEngine,
      agentServices,
    },
  };
});

vi.mock('@/domains/platform/models/ModelService', () => ({
  ModelService: vi.fn().mockImplementation(() => ({
    getDefaultOrNull: vi.fn(async () => ({ modelName: 'mock-model' })),
  })),
}));

vi.mock('@/domains/platform/settings/networkSettings', () => ({
  getNetworkSettings: vi.fn(async () => ({ corsAllowedOrigins: [], allowOutbound: true, outboundAllowlist: [] })),
}));
vi.mock('@/domains/platform/settings/sandboxSettings', () => ({
  getSandboxSettings: vi.fn(async () => ({
    devUnsafe: false,
    cpuQuota: 1,
    memoryMb: 1024,
    pidsLimit: 256,
    stdoutLimitBytes: 1048576,
  })),
}));
vi.mock('@/domains/platform/settings/runtimeSettings', () => ({
  getRuntimeSettings: vi.fn(async () => ({ turnTimeoutMs: 180000, maxToolCallsPerTurn: 64, shellTimeoutMs: 120000, webTimeoutMs: 15000, webMaxBytes: 1048576, sessionTTLMinutes: 120 })),
}));
vi.mock('@/domains/platform/settings/traceSettings', () => ({
  getTraceSettings: vi.fn(async () => ({ traceInlineLimit: 5000, stdoutChunkSize: 10000, traceCompressOverBytes: 100000, traceRetentionDays: 30, traceLogsRoot: 'storage/object-store/traces', artifactDirName: '.artifacts', artifactMaxChars: 20000 })),
}));
vi.mock('@/domains/platform/settings/automationSettings', () => ({
  getAutomationSettings: vi.fn(async () => ({
    maxGuardRetries: 3,
    requireReport: true,
    turnTimeoutMs: 180000,
    checkpointIntervalToolCalls: 10,
    reportMinLength: 100,
    workspaceBackupEnabled: false,
  })),
}));
vi.mock('@/domains/platform/settings/tokenGuardSettings', () => ({
  getTokenGuardSettings: vi.fn(async () => ({
    perSessionLimit: 0,
    perUserDailyLimit: 0,
    warningThresholdPct: 80,
  })),
}));
vi.mock('@/domains/platform/settings/sessionLifecycleSettings', () => ({
  getSessionLifecycleSettings: vi.fn(async () => ({
    maxAgeDays: 30,
    maxCountPerUser: 0,
    retentionEnabled: true,
  })),
}));
vi.mock('@/domains/platform/settings/httpSettings', () => ({
  getHttpSettings: vi.fn(async () => ({
    logSlowMs: 750,
    logDebugSampleRate: 0,
    logQuietPaths: ['/health', '/metrics'],
    uploadsMaxBytes: 25 * 1024 * 1024,
  })),
}));
vi.mock('@/domains/platform/settings/webSearchSettings', () => ({
  getWebSearchSettings: vi.fn(async () => ({
    provider: 'duck',
    duckBaseUrl: 'https://duckduckgo.com/',
    duckLiteBaseUrl: 'https://duckduckgo.com/html/',
    tavilyBaseUrl: 'https://api.tavily.com/search',
    maxResults: 5,
    timeoutMs: 15_000,
    maxBytes: 1_048_576,
    tavilyApiKey: undefined,
  })),
}));
vi.mock('@/domains/platform/sandbox/infrastructure/SandboxImageRegistry', () => ({
  getSandboxImageRegistry: vi.fn(async () => ({
    getDefaultImageTag: () => 'null-ai-sandbox:local',
  })),
}));

vi.mock('@/domains/platform/subscriptions/PlanAccessPort', () => ({
  AccessControlPlanAccess: vi.fn().mockImplementation(() => ({
    enforceSessionCreation: vi.fn().mockResolvedValue({
      userId: 'user-1',
      creditsCurrent: 100,
      periodStart: Date.now(),
      periodEnd: Date.now(),
      plan: { slug: 'inactive', features: {}, limits: {} },
    }),
    resolveSubscription: vi.fn().mockResolvedValue({
      userId: 'user-1',
      creditsCurrent: 100,
      periodStart: Date.now(),
      periodEnd: Date.now(),
      plan: { slug: 'inactive', features: {}, limits: {} },
    }),
  })),
}));

vi.mock('@/domains/agent-brain/adapters/persistence/TraceIndexRepository', () => ({
  TraceIndexRepository: vi.fn().mockImplementation(() => ({
    list: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    find: vi.fn(),
  })),
}));

vi.mock('@/domains/agent-brain/application/core/SessionStore', () => ({
  SessionStore: vi.fn().mockImplementation(() => ({
    whenReady: vi.fn(async () => undefined),
    setToolSchemaProvider: vi.fn(),
    setOnSessionRemove: vi.fn(),
    listSessions: vi.fn(() => []),
    shutdown: vi.fn(),
    get: vi.fn(),
    setAsync: vi.fn(),
    clearCurrentTurnAsync: vi.fn(),
  })),
}));

vi.mock('@/domains/agent-brain/adapters/sandbox', () => ({
  SandboxManager: vi.fn().mockImplementation(() => ({
    destroy: vi.fn(async () => undefined),
    bindSessionStore: vi.fn(),
    listSandboxes: vi.fn(async () => []),
  })),
}));

describe('createAppContext wiring', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterAll(() => {
    warnSpy.mockRestore();
    vi.runOnlyPendingTimers();
    vi.clearAllTimers();
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it.skip('boots with mocked infra and disposes timers/clients', async () => {
    vi.resetModules();
    process.env.APP_ROLE = 'worker';
    process.env.ENABLE_WORKERS = 'true';
    const { default: createAppContext } = await import('@/app/createAppContext');
    const ctx = await createAppContext();

    expect(ctx).toBeDefined();
    expect((ctx as any).redis).toBeUndefined();
    const storageMocks = (storageFactories as any).__mocks;

    await ctx.dispose?.();
  });
});







