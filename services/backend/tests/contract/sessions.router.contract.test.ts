import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  resolvePdfReportCoverMetadata,
  sessionsRouter,
} from '@/interfaces/http/controllers/ai-agent/routes/sessions.router';
import { streamRouter } from '@/interfaces/http/controllers/ai-agent/routes/stream.router';
import { approvalsRouter } from '@/interfaces/http/controllers/ai-agent/routes/approvals.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware/errors';
import type { AgentApiServices } from '@/interfaces/http/controllers/ai-agent/types';
import { HttpError } from '@/interfaces/http/controllers/ai-agent/lib/httpError';
import { ERROR_CODES, type SessionExecutionReadModel } from '@null-ai/contracts';
import { AppError } from '@/shared/errors';

const mockStateMachine = (processing: boolean) => {
  let state: 'processing' | 'idle' = processing ? 'processing' : 'idle';
  return {
    isProcessing: () => state === 'processing',
    startProcessing: () => {
      state = 'processing';
      return true;
    },
    stopProcessing: () => {
      state = 'idle';
      return true;
    },
    canStartProcessing: () => state === 'idle',
    getState: () => state,
  };
};


const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  promises: {
    readFile: vi.fn(),
  },
}));

const sessionServiceMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

const summaryMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
}));

const tokenGuardMocks = vi.hoisted(() => ({
  checkLimits: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => ({
  generateReport: vi.fn(),
}));

const persistenceMocks = vi.hoisted(() => ({
  listByUser: vi.fn(),
  findById: vi.fn(),
  listBySessionPaged: vi.fn(),
  listBySession: vi.fn(),
  listChildSessionIds: vi.fn(),
  findPhaseSessionRouting: vi.fn(),
  getBlockedReason: vi.fn(),
  updateTitle: vi.fn(),
  setBlockedReason: vi.fn(),
  setBlockedReasonIfClear: vi.fn(),
  clearBlockedReason: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: fsMocks.existsSync,
  promises: {
    readFile: fsMocks.promises.readFile,
  },
}));

vi.mock('@/config/bootstrapConfig', () => ({
  __esModule: true,
  default: {
    s3: undefined,
  },
  config: {
    s3: undefined,
  },
}));

vi.mock('@/domains/agent-brain/application/services/SessionService', () => ({
  SessionService: class MockSessionService {
    createSession = sessionServiceMocks.createSession;
  },
}));

vi.mock('@/domains/agent-brain/application/services/SessionSummaryService', () => ({
  SessionSummaryService: class MockSessionSummaryService {
    generateSummary = summaryMocks.generateSummary;
  },
}));

vi.mock('@/shared/pdf', () => ({
  getPdfReportService: () => ({
    generateReport: pdfMocks.generateReport,
  }),
}));

vi.mock('@/domains/agent-brain/adapters/persistence', () => ({
  SessionRepository: class MockSessionRepository {
    listByUser = persistenceMocks.listByUser;
    findById = persistenceMocks.findById;
    listChildSessionIds = persistenceMocks.listChildSessionIds;
    findPhaseSessionRouting = persistenceMocks.findPhaseSessionRouting;
    getBlockedReason = persistenceMocks.getBlockedReason;
    updateTitle = persistenceMocks.updateTitle;
    setBlockedReason = persistenceMocks.setBlockedReason;
    setBlockedReasonIfClear = persistenceMocks.setBlockedReasonIfClear;
    clearBlockedReason = persistenceMocks.clearBlockedReason;
  },
  MessageRepository: class MockMessageRepository {
    listBySessionPaged = persistenceMocks.listBySessionPaged;
  },
  ArtifactRepository: class MockArtifactRepository {
    listBySession = persistenceMocks.listBySession;
  },
  CheckpointRepository: class MockCheckpointRepository {},
}));

type ServicesOverrides = Partial<AgentApiServices> & {
  accessControl?: any;
  traceRecorder?: any;
  scopeAwareChatContextService?: any;
  kernel?: any;
  runService?: any;
};

const buildServices = (session?: any, overrides: ServicesOverrides = {}) => {
  const executionReadModel = (): SessionExecutionReadModel => ({
    desiredExecution:
      session?.blockedReason === 'user_paused' || session?.blockedReason === 'aborted_by_user'
        ? 'stopped' as const
        : 'running' as const,
    condition: session?.completed
      ? 'completed' as const
      : session?.stateMachine?.isProcessing?.()
        ? 'executing' as const
        : 'idle' as const,
  });
  const sessionStore = {
    get: vi.fn(() => session),
    getOrHydrate: vi.fn(async () => session),
    listByUser: vi.fn(() => (session ? [session] : [])),
    remove: vi.fn(() => true),
    set: vi.fn(),
    setAsync: vi.fn(),
    mergeFlagNamespaceAsync: vi.fn(),
    abortCurrentTurnAsync: vi.fn(),
    recordStopRequestedAsync: vi.fn().mockResolvedValue(undefined),
    recordStartRequestedAsync: vi.fn().mockResolvedValue(undefined),
    recordExecutionDeferredAsync: vi.fn().mockResolvedValue(undefined),
    recordInputAndStartRequestedAsync: vi.fn().mockResolvedValue(true),
    getJournalProjection: vi.fn().mockResolvedValue(undefined),
    getExecutionReadModel: vi.fn(async () => executionReadModel()),
    getExecutionReadModels: vi.fn(async (ids: string[]) => new Map(
      ids.map((id) => [id, executionReadModel()]),
    )),
  };

  const ports = {
    events: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
    tools: {
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: false }),
    },
    tasks: {
      getTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
    },
  };

  const services = {
    streamBroker: {} as any,
    sessionStore,
    checkpointManager: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'cp1' }),
      restore: vi.fn().mockResolvedValue({ id: 'cp1' }),
    },
    sandbox: { writeFile: vi.fn().mockResolvedValue(undefined) } as any,
    toolsRegistry: {} as any,
    orchestrator: {
      processMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    traceRecorder: {
      write: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    } as any,
    usageTracker: undefined,
    sandboxProfileRegistry: {} as any,
    usageStore: undefined,
    ports,
    agentEngine: {
      cleanupSession: vi.fn().mockResolvedValue(undefined),
      stopSandbox: vi.fn().mockResolvedValue(undefined),
      getSandboxPolicy: vi.fn().mockResolvedValue(null),
    } as any,
    artifactService: {
      getStorageRoot: vi.fn(() => path.resolve(process.cwd(), 'storage', 'artifacts')),
    } as any,
    policyResolver: {
      getDefaultPolicy: vi.fn().mockResolvedValue(null),
      getBySlug: vi.fn().mockResolvedValue(null),
      resolvePolicy: vi.fn().mockResolvedValue({
        policy: { slug: 'default', parsedSpec: { tools: {}, sandbox: {} } },
        source: 'default',
      }),
    } as any,
    policyFacade: undefined,
    tokenGuard: {
      checkLimits: tokenGuardMocks.checkLimits,
    } as any,
    runService: {
      onSessionStatusChange: vi.fn().mockResolvedValue(undefined),
    } as any,
    accessControl: {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      enforceRunObservabilityAccess: vi.fn().mockResolvedValue(undefined),
      resolveSubscription: vi.fn().mockResolvedValue({
        plan: { features: {}, limits: {} },
        creditsCurrent: 0,
      }),
    } as any,
    ...overrides,
  } as unknown as AgentApiServices & { accessControl?: any; traceRecorder?: any; runService?: any };

  return { services, sessionStore, ports };
};

const buildApp = (
  services: AgentApiServices,
  userId?: string,
  opts?: {
    stream?: boolean;
    approvals?: boolean;
    sessionsRouterOptions?: { appRole?: string; enableWorkers?: boolean };
  },
) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId !== undefined) {
      (req as any).user = { id: userId };
    }
    next();
  });
  app.use(sessionsRouter(services as any, opts?.sessionsRouterOptions));
  if (opts?.stream) {
    app.use(streamRouter(services as any, { accessControl: (services as any).accessControl }));
  }
  if (opts?.approvals) {
    app.use(approvalsRouter(services as any));
  }
  app.use(errorHandler);
  return app;
};

describe('sessions.router contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistenceMocks.listByUser.mockResolvedValue([]);
    persistenceMocks.findById.mockResolvedValue(null);
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [],
      meta: { hasMore: false, nextCursor: undefined },
    });
    persistenceMocks.listBySession.mockResolvedValue([]);
    persistenceMocks.listChildSessionIds.mockResolvedValue([]);
    persistenceMocks.findPhaseSessionRouting.mockResolvedValue(null);
    persistenceMocks.getBlockedReason.mockResolvedValue(null);
    persistenceMocks.setBlockedReason.mockResolvedValue(undefined);
    persistenceMocks.setBlockedReasonIfClear.mockResolvedValue(true);
    persistenceMocks.clearBlockedReason.mockResolvedValue(true);
    sessionServiceMocks.createSession.mockResolvedValue({
      session: { id: 's-new' },
      preparation: undefined,
    });
    summaryMocks.generateSummary.mockResolvedValue('summary');
    tokenGuardMocks.checkLimits.mockReturnValue({
      exceeded: false,
      currentUsage: 0,
      limit: 0,
      usagePct: 0,
      warning: false,
    });
    pdfMocks.generateReport.mockResolvedValue(Buffer.from('pdf'));
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.promises.readFile.mockImplementation(async (filePath: any) => {
      const value = String(filePath);
      if (value.includes('summary.md')) return 'summary content';
      if (value.includes('report.md')) return 'report content';
      return 'artifact content';
    });
  });

  it('returns available model categories from GET /models', async () => {
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      resolveSubscription: vi.fn(),
    };
    const listAvailableCategories = vi.fn().mockResolvedValue([
      {
        id: 'medium',
        category: 'medium',
        displayName: 'Medium',
        description: 'Balanced model category',
        isDefault: true,
        availableCount: 1,
      },
      {
        id: 'extra_high',
        category: 'extra_high',
        displayName: 'Extra High',
        description: 'Deep reasoning category',
        isDefault: false,
        availableCount: 1,
      },
    ]);

    const { services } = buildServices(undefined, {
      accessControl,
      kernel: {
        models: { listAvailableCategories },
        accessControl,
      },
    });
    const app = buildApp(services as any, 'user-1');

    const res = await request(app).get('/models');

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      {
        id: 'medium',
        category: 'medium',
        displayName: 'Medium',
        description: 'Balanced model category',
        isDefault: true,
        availableCount: 1,
      },
      {
        id: 'extra_high',
        category: 'extra_high',
        displayName: 'Extra High',
        description: 'Deep reasoning category',
        isDefault: false,
        availableCount: 1,
      },
    ]);
    expect(accessControl.resolveSubscription).not.toHaveBeenCalled();
    expect(listAvailableCategories).toHaveBeenCalledTimes(1);
  });

  it('returns the tool catalog from GET /catalog/tools', async () => {
    const listManifests = vi.fn().mockResolvedValue([
      {
        id: 'tool.alpha',
        summary: 'Alpha tool',
        argsSchema: { type: 'object', properties: { target: { type: 'string' } } },
        meta: {
          category: 'core',
          risk: 'low',
          isCapability: true,
          requires: ['scope'],
          returns: 'json',
        },
      },
      {
        id: 'tool.beta',
        summary: 'Beta tool',
        argsSchema: undefined,
        meta: {
          category: 'ops',
        },
      },
    ]);

    const { services } = buildServices(undefined, {
      toolsRegistry: {
        listManifests,
      } as any,
    });
    const app = buildApp(services as any, 'user-1');

    const res = await request(app).get('/catalog/tools');

    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([
      {
        id: 'tool.alpha',
        summary: 'Alpha tool',
        argsSchema: { type: 'object', properties: { target: { type: 'string' } } },
        meta: {
          category: 'core',
          risk: 'low',
          isCapability: true,
          requires: ['scope'],
          returns: 'json',
        },
      },
      {
        id: 'tool.beta',
        summary: 'Beta tool',
        meta: {
          category: 'ops',
        },
      },
    ]);
    expect(listManifests).toHaveBeenCalledTimes(1);
  });

  it('lists sessions with blocked_reason taking priority over live status', async () => {
    const now = Date.now();
    const liveSession = {
      id: 's1',
      userId: 'user-1',
      stateMachine: mockStateMachine(true),
      pendingApproval: undefined,
      createdAt: now - 5000,
      lastActive: now - 1000,
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };

    persistenceMocks.listByUser.mockResolvedValue([
      {
        id: 's1',
        userId: 'user-1',
        title: 'DB Session',
        taskId: 'task-1',
        metadata: { taskTitle: 'Task 1' },
        mode: 'interactive',
        createdAt: new Date(now - 6000),
        updatedAt: new Date(now - 4000),
        lastActiveAt: new Date(now - 2000),
        summary: null,
        plan: [],
        workspaceDir: '/tmp/session',
        blockedReason: 'credits_exhausted',
      },
    ] as any);

    const { services, sessionStore } = buildServices(liveSession);
    sessionStore.listByUser.mockReturnValue([liveSession]);
    sessionStore.getExecutionReadModels.mockResolvedValue(new Map([
      ['s1', { desiredExecution: 'running', condition: 'waiting_credits' }],
    ]));
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions');

    expect(res.status).toBe(200);
    const session = res.body.sessions.find((item: any) => item.id === 's1');
    expect(session.status).toBe('paused');
    expect(session.pause_reason).toBe('credits');
    expect(session.interaction_type).toBe('none');
    expect(session.blocked_reason).toBe('credits_exhausted');
    expect(session.isProcessing).toBe(false);
    expect(session.desiredExecution).toBe('running');
    expect(session.condition).toBe('waiting_credits');
    expect(sessionStore.getExecutionReadModels).toHaveBeenCalledTimes(1);
    expect(sessionStore.getExecutionReadModels).toHaveBeenCalledWith(['s1']);
    expect(sessionStore.getExecutionReadModel).not.toHaveBeenCalled();
  });

  it('lists sessions as running when recent activity is still within the processing window', async () => {
    const now = Date.now();
    const liveSession = {
      id: 's-processing',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      pendingApproval: undefined,
      createdAt: now - 5000,
      lastActive: now - 1000,
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };

    persistenceMocks.listByUser.mockResolvedValue([
      {
        id: 's-processing',
        userId: 'user-1',
        title: 'DB Session',
        taskId: 'task-1',
        metadata: { taskTitle: 'Task 1' },
        mode: 'interactive',
        createdAt: new Date(now - 6000),
        updatedAt: new Date(now - 4000),
        lastActiveAt: new Date(now - 2000),
        summary: null,
        plan: [],
        workspaceDir: '/tmp/session',
        blockedReason: null,
      },
    ] as any);

    const { services, sessionStore } = buildServices(liveSession);
    sessionStore.listByUser.mockReturnValue([liveSession]);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions');

    expect(res.status).toBe(200);
    const session = res.body.sessions.find((item: any) => item.id === 's-processing');
    expect(session.status).toBe('running');
    expect(session.isProcessing).toBe(true);
  });

  it('returns live session details with report/summary content', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('credits_exhausted');
    const artifacts = [
      {
        id: 'a1',
        filePath: 'sessions/s1/report.md',
        originalName: 'report.md',
        fileType: 'markdown',
        sizeBytes: 123,
        createdAt: Date.now(),
        storage: 'local',
      },
      {
        id: 'a2',
        filePath: 'sessions/s1/summary.md',
        originalName: 'summary.md',
        fileType: 'markdown',
        sizeBytes: 50,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    const session = {
      id: 's1',
      userId: 'user-1',
      mode: 'interactive',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 2,
      stateMachine: mockStateMachine(false),
      flags: {
        securityops: {
          executionTarget: 'scope_runner',
          runnerId: 'runner-1',
          runnerName: 'Private Runner',
        },
      },
      messages: [
        {
          id: 'm-internal',
          role: 'user',
          content: 'Internal kickoff',
          createdAt: new Date(),
          metadata: { visibility: 'internal', source: 'planner_kickoff' },
        },
        { id: 'm1', role: 'assistant', content: 'hello', createdAt: new Date() },
      ],
      plan: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      artifacts,
      liveToolStreams: {
        shell_run: {
          name: 'shell_run',
          chunks: ['npm test'],
          status: 'running',
          command: 'npm test',
          lastUpdated: Date.now(),
        },
      },
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s1');

    expect(res.status).toBe(200);
    expect(res.body.session.summary).toBe('summary content');
    expect(res.body.session.report).toBe('report content');
    expect(res.body.session.status).toBe('paused');
    expect(res.body.session.pause_reason).toBe('credits');
    expect(res.body.session.interaction_type).toBe('none');
    expect(res.body.session.blocked_reason).toBe('credits_exhausted');
    expect(res.body.session.executionTarget).toBe('scope_runner');
    expect(res.body.session.runnerId).toBe('runner-1');
    expect(res.body.session.runnerName).toBe('Private Runner');
    expect(res.body.session.artifacts).toEqual([]);
    expect(res.body.session.messages[0].id).toBe('m1');
    expect(res.body.session.messages).toHaveLength(1);
    expect(res.body.session.liveToolStreams).toEqual(
      expect.objectContaining({
        shell_run: expect.objectContaining({
          command: 'npm test',
          chunks: ['npm test'],
        }),
      }),
    );
  });

  it('returns DB-backed session details as running when recent activity is still within the processing window', async () => {
    const now = Date.now();
    persistenceMocks.findById.mockResolvedValue({
      id: 's-db-processing',
      userId: 'user-1',
      title: 'Leased Session',
      mode: 'interactive',
      createdAt: new Date(now - 10_000),
      updatedAt: new Date(now - 5_000),
      lastActiveAt: new Date(now - 1_000),
      blockedReason: null,
      completed: false,
      metadata: {},
      plan: [],
    } as any);

    const { services } = buildServices(undefined);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-db-processing');

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('running');
    expect(res.body.session.isProcessing).toBe(true);
  });

  it('uses live artifacts internally when persisted artifact rows lag behind the in-memory session', async () => {
    persistenceMocks.listBySession.mockResolvedValue([]);
    const session = {
      id: 's-live-only-report',
      userId: 'user-1',
      mode: 'automated',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 1,
      stateMachine: mockStateMachine(false),
      flags: {},
      messages: [],
      plan: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      artifacts: [
        {
          id: 'live-report',
          filePath: 'sessions/s-live-only-report/report.md',
          originalName: 'report.md',
          fileType: 'markdown',
          sizeBytes: 42,
          createdAt: Date.now(),
        },
      ],
      report: 'legacy in-memory report',
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const details = await request(app).get('/sessions/s-live-only-report');
    const artifacts = await request(app).get('/sessions/s-live-only-report/artifacts');
    const reportPdf = await request(app).get('/sessions/s-live-only-report/report/pdf');

    expect(details.status).toBe(200);
    expect(details.body.session.artifacts).toEqual([]);
    expect(details.body.session.report).toBe('report content');
    expect(artifacts.status).toBe(200);
    expect(artifacts.body.artifacts).toEqual([]);
    expect(reportPdf.status).toBe(200);
    expect(reportPdf.headers['content-type']).toContain('application/pdf');
  });

  it('reuses cached report content across repeated fetches', async () => {
    const artifacts = [
      {
        id: 'a1',
        filePath: 'sessions/s-cache/report.md',
        originalName: 'report.md',
        fileType: 'markdown',
        sizeBytes: 42,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    const session = {
      id: 's-cache',
      userId: 'user-1',
      mode: 'interactive',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 1,
      stateMachine: mockStateMachine(false),
      flags: {},
      messages: [],
      plan: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      artifacts,
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const first = await request(app).get('/sessions/s-cache');
    const second = await request(app).get('/sessions/s-cache');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.session.report).toBe('report content');
    expect(second.body.session.report).toBe('report content');
    expect(fsMocks.promises.readFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to database session when live session is missing', async () => {
    persistenceMocks.findById.mockResolvedValue({
      id: 's2',
      userId: 'user-1',
      title: 'DB Only Session',
      taskId: 'task-2',
      metadata: { taskTitle: 'Task 2', usage: { promptTokens: 1 } },
      mode: 'interactive',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T01:00:00Z'),
      summary: 'stored summary',
      plan: [],
      blockedReason: null,
    });
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [{ id: 'm2', role: 'user', content: 'hello', createdAt: new Date() }],
      meta: { hasMore: false, nextCursor: undefined },
    });

    const { services } = buildServices(undefined);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s2');

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe('s2');
    expect(res.body.session.messages).toHaveLength(1);
    expect(res.body.session.messages[0].id).toBe('m2');
  });

  it('returns persisted live tool streams when session details fall back to the database', async () => {
    persistenceMocks.findById.mockResolvedValue({
      id: 's-db-streams',
      userId: 'user-1',
      title: 'DB Streams Session',
      taskId: 'task-3',
      metadata: {
        taskTitle: 'Task 3',
        liveToolStreams: {
          shell_run: {
            name: 'shell_run',
            chunks: ['npm test'],
            status: 'running',
            command: 'npm test',
            lastUpdated: Date.now(),
          },
        },
      },
      mode: 'interactive',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T01:00:00Z'),
      summary: null,
      plan: [],
      blockedReason: null,
    });
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [],
      meta: { hasMore: false, nextCursor: undefined },
    });

    const { services } = buildServices(undefined);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-db-streams');

    expect(res.status).toBe(200);
    expect(res.body.session.liveToolStreams).toEqual(
      expect.objectContaining({
        shell_run: expect.objectContaining({
          command: 'npm test',
          chunks: ['npm test'],
          status: 'running',
        }),
      }),
    );
  });

  it('deletes a session and triggers cleanup', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services, sessionStore } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).delete('/sessions/s1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Session deleted');
    expect((services.agentEngine as any).cleanupSession).toHaveBeenCalledWith('s1', session);
    expect(sessionStore.remove).toHaveBeenCalledWith('s1', 'explicit');
  });

  it('accepts a message when access control allows', async () => {
    const session = {
      id: 's-allow-msg',
      userId: 'user-1',
      mode: 'interactive',
      createdAt: Date.now(),
      lastActive: Date.now(),
      stateMachine: mockStateMachine(false),
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      resolveSubscription: vi.fn().mockResolvedValue({
        plan: { features: {}, limits: {} },
        creditsCurrent: 0,
      }),
    };
    const { services, sessionStore } = buildServices(session, { accessControl } as any);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-allow-msg/message').send({ text: 'ping' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, scheduled: true });
    expect(sessionStore.recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      's-allow-msg',
      expect.objectContaining({ content: 'ping', role: 'user' }),
      'message accepted',
      'user-1',
    );
    expect((services.orchestrator as any).processMessage).not.toHaveBeenCalled();
  });

  it('rejects freeform messages for active automated run workbench sessions', async () => {
    const session = {
      id: 's-run-msg-blocked',
      userId: 'user-1',
      mode: 'automated',
      createdAt: Date.now(),
      lastActive: Date.now(),
      stateMachine: mockStateMachine(true),
      messages: [],
      plan: [],
      flags: { securityops: { runId: 'run-1' } },
      artifacts: [],
      version: 7,
    };
    persistenceMocks.findById.mockResolvedValue({
      id: 's-run-msg-blocked',
      blockedReason: null,
      completed: false,
    } as any);
    persistenceMocks.getBlockedReason.mockResolvedValue(null);

    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-run-msg-blocked/message').send({ text: 'ping' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        accepted: false,
        status: 'running',
        pause_reason: null,
        interaction_type: 'none',
        blocked_reason: null,
        version: 7,
      }),
    );
    expect((services.orchestrator as any).processMessage).not.toHaveBeenCalled();
  });

  it('rejects stale phase workbench message dispatch with the active phase session', async () => {
    const session = {
      id: 's-run-msg-stale',
      userId: 'user-1',
      mode: 'automated',
      createdAt: Date.now(),
      lastActive: Date.now(),
      stateMachine: mockStateMachine(false),
      blockedReason: 'user_paused',
      messages: [],
      plan: [],
      flags: { securityops: { runId: 'run-3', activePhaseId: 'phase-old', activePhaseKey: 'validation' } },
      artifacts: [],
      version: 9,
    };
    persistenceMocks.findPhaseSessionRouting.mockResolvedValue({
      current: {
        id: 'phase-old',
        runId: 'run-3',
        phaseKey: 'validation',
        status: 'failed',
        sessionId: 's-run-msg-stale',
        ordinal: 3,
      },
      active: {
        id: 'phase-new',
        runId: 'run-3',
        phaseKey: 'validation',
        status: 'active',
        sessionId: 's-run-msg-active',
        ordinal: 4,
      },
    });
    const { services, sessionStore } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-run-msg-stale/message').send({ text: 'ping' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      accepted: false,
      status: 'stale_phase_session',
      runId: 'run-3',
      phaseId: 'phase-old',
      phaseKey: 'validation',
      phaseStatus: 'failed',
      currentSessionId: 's-run-msg-active',
      activePhaseSession: {
        phaseId: 'phase-new',
        phaseKey: 'validation',
        phaseStatus: 'active',
        sessionId: 's-run-msg-active',
      },
      redirect: {
        runId: 'run-3',
        phaseKey: 'validation',
        sessionId: 's-run-msg-active',
      },
    });
    expect((services.traceRecorder as any).write).toHaveBeenCalledWith(
      's-run-msg-stale',
      expect.any(Number),
      expect.objectContaining({
        event: 'workbench.action',
        payload: expect.objectContaining({
          action: 'redirect',
          targetSessionId: 's-run-msg-active',
          result: 'offered',
        }),
      }),
    );
    expect((services.orchestrator as any).processMessage).not.toHaveBeenCalled();
  });

  it('accepts freeform messages for manually paused automated run workbench sessions', async () => {
    const session = {
      id: 's-run-msg-allowed',
      userId: 'user-1',
      mode: 'automated',
      createdAt: Date.now(),
      lastActive: Date.now(),
      stateMachine: mockStateMachine(false),
      blockedReason: 'user_paused',
      messages: [],
      plan: [],
      flags: { securityops: { runId: 'run-2' } },
      artifacts: [],
      version: 8,
    };
    persistenceMocks.findById.mockResolvedValue({
      id: 's-run-msg-allowed',
      blockedReason: 'user_paused',
      completed: false,
    } as any);
    persistenceMocks.getBlockedReason.mockResolvedValue('user_paused');

    const { services, sessionStore } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-run-msg-allowed/message').send({ text: 'ping' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, scheduled: true });
    expect(sessionStore.recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      's-run-msg-allowed',
      expect.objectContaining({ content: 'ping', role: 'user' }),
      'workbench message accepted',
      'user-1',
    );
    expect((services.orchestrator as any).processMessage).not.toHaveBeenCalled();
  });

  it('does not gate message submission on plan checks', async () => {
    const session = {
      id: 's-msg',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn(() => {
        throw new HttpError({
          code: ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
          message: 'Credits exhausted',
          status: 402,
        });
      }),
      resolveSubscription: vi.fn().mockResolvedValue({
        plan: { features: {}, limits: {} },
        creditsCurrent: 0,
      }),
    };
    const { services, sessionStore } = buildServices(session, { accessControl } as any);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-msg/message').send({ text: 'hello' });

    expect(res.status).toBe(202);
    expect(accessControl.enforceMessage).not.toHaveBeenCalled();
    expect(sessionStore.recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      's-msg',
      expect.objectContaining({ content: 'hello', role: 'user' }),
      'message accepted',
      'user-1',
    );
    expect((services.orchestrator as any).processMessage).not.toHaveBeenCalled();
  });

  it('streams session events for the owner', async () => {
    const session = { id: 's1', userId: 'user-1', pendingApproval: undefined };
    const { services, ports } = buildServices(session);
    const app = buildApp(services, 'user-1', { stream: true });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleErr = (err: any) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const req = request(app).get('/sessions/s1/stream');
      req.on('response', (raw) => {
        raw.on('error', (err: any) => {
          if (err?.code === 'ECONNRESET') {
            settle();
          } else {
            settleErr(err);
          }
        });
        raw.on('end', settle);
        raw.on('close', settle);
        setTimeout(() => raw.destroy(), 20);
      });
      req.end((err) => {
        if (err && (err as any).code !== 'ECONNRESET') {
          settleErr(err);
        }
      });
      setTimeout(settle, 500);
    });

    expect(ports.events.subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
  }, 1500);

  it('redacts run observability fields from session details when the plan lacks access', async () => {
    const session = {
      id: 's-run',
      userId: 'user-1',
      mode: 'automated',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 3,
      flags: {
        securityops: {
          runId: 'run-1',
          organizationId: 'org-1',
        },
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'terminal transcript',
          timestamp: Date.now(),
        },
      ],
      plan: [{ id: 'step-1', title: 'Run step', status: 'running' }],
      liveToolStreams: { shell: { command: 'npm test' } },
      timeline: [{ id: 't1', label: 'Shell command' }],
      workerTasks: [{ taskId: 'worker-1' }],
      artifacts: [],
    };
    persistenceMocks.findById.mockResolvedValue({
      id: 's-run',
      userId: 'user-1',
      mode: 'automated',
      metadata: {
        flags: {
          securityops: {
            runId: 'run-1',
            organizationId: 'org-1',
          },
        },
      },
      createdAt: new Date(),
      lastActiveAt: new Date(),
      plan: [{ id: 'step-1', title: 'Run step', status: 'running' }],
      completed: false,
    });
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      enforceRunObservabilityAccess: vi.fn().mockRejectedValue(
        new AppError(
          ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
          'Run terminal and activity details are not available on your plan',
          {
            httpStatus: 403,
            context: { feature: 'accessRunObservability' },
          },
        ),
      ),
    };
    const { services } = buildServices(session, { accessControl } as any);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-run');

    expect(res.status).toBe(200);
    expect(res.body.session.messages).toEqual([]);
    expect(res.body.session.plan).toEqual([]);
    expect(res.body.session.liveToolStreams).toEqual({});
    expect(res.body.session.timeline).toEqual([]);
    expect(res.body.session.workerTasks).toEqual([]);
    expect(accessControl.enforceRunObservabilityAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('blocks direct run session messages when the plan lacks run observability', async () => {
    const session = {
      id: 's-run',
      userId: 'user-1',
      mode: 'automated',
      flags: {
        securityops: {
          runId: 'run-1',
          organizationId: 'org-1',
        },
      },
      messages: [],
      plan: [],
      artifacts: [],
    };
    persistenceMocks.findById.mockResolvedValue({
      id: 's-run',
      userId: 'user-1',
      metadata: {
        flags: {
          securityops: {
            runId: 'run-1',
            organizationId: 'org-1',
          },
        },
      },
    });
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      enforceRunObservabilityAccess: vi.fn().mockRejectedValue(
        new AppError(
          ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
          'Run terminal and activity details are not available on your plan',
          {
            httpStatus: 403,
            context: { feature: 'accessRunObservability' },
          },
        ),
      ),
    };
    const { services } = buildServices(session, { accessControl } as any);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-run/messages');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE);
    expect(persistenceMocks.listBySessionPaged).not.toHaveBeenCalled();
  });

  it('blocks run session streams when the plan lacks run observability', async () => {
    const session = {
      id: 's-run',
      userId: 'user-1',
      mode: 'automated',
      flags: {
        securityops: {
          runId: 'run-1',
          organizationId: 'org-1',
        },
      },
      pendingApproval: undefined,
    };
    const accessControl = {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      enforceRunObservabilityAccess: vi.fn().mockRejectedValue(
        new AppError(
          ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
          'Run terminal and activity details are not available on your plan',
          {
            httpStatus: 403,
            context: { feature: 'accessRunObservability' },
          },
        ),
      ),
    };
    const { services, ports } = buildServices(session, { accessControl } as any);
    const app = buildApp(services, 'user-1', { stream: true });

    const res = await request(app).get('/sessions/s-run/stream');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE);
    expect(ports.events.subscribe).not.toHaveBeenCalled();
  });

  it('hydrates a cold durable session and emits its canonical bootstrap snapshot', async () => {
    const now = Date.now();
    const session = {
      id: 's-bootstrap',
      userId: 'user-1',
      title: 'Bootstrap Session',
      mode: 'automated',
      createdAt: now - 5_000,
      lastActive: now - 500,
      turn: 4,
      version: 7,
      summary: 'live summary',
      stateMachine: mockStateMachine(true),
      flags: { blocked_reason: 'user_paused' },
      messages: [
        {
          id: 'm-hidden',
          role: 'user',
          content: 'Internal kickoff',
          timestamp: now - 2_000,
          metadata: { visibility: 'internal', source: 'planner_kickoff' },
        },
        {
          id: 'm-visible',
          role: 'assistant',
          content: 'Visible output',
          timestamp: now - 1_000,
        },
      ],
      plan: [{ id: 'step-1', title: 'Bootstrap plan', status: 'running' }],
      task: { id: 'task-1', title: 'Bootstrap task' },
      artifacts: [
        {
          id: 'artifact-1',
          filePath: 'sessions/s-bootstrap/report.md',
          originalName: 'report.md',
          fileType: 'markdown',
          sizeBytes: 128,
          createdAt: now - 500,
          storage: 'local',
        },
      ],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      liveToolStreams: {
        shell: {
          name: 'shell',
          chunks: ['npm test'],
          status: 'running',
          command: 'npm test',
          lastUpdated: now - 250,
        },
      },
      pendingApproval: undefined,
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.get.mockReturnValue(undefined);
    const app = buildApp(services, 'user-1', { stream: true });

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const raw = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (value: string) => {
        if (!settled) {
          settled = true;
          server.close(() => resolve(value));
        }
      };
      const settleErr = (err: unknown) => {
        if (!settled) {
          settled = true;
          server.close(() => reject(err));
        }
      };
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/sessions/s-bootstrap/stream',
          method: 'GET',
        },
        (response) => {
          let buffer = '';
          response.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.includes('"title":"Bootstrap Session"')) {
              req.destroy();
              settle(buffer);
            }
          });
          response.on('error', settleErr);
          response.on('end', () => settle(buffer));
          response.on('close', () => settle(buffer));
        },
      );
      req.on('error', (err: any) => {
        if (err?.code !== 'ECONNRESET') {
          settleErr(err);
        }
      });
      req.end();
      setTimeout(() => settleErr(new Error('timed out waiting for bootstrap event')), 500);
    });

    expect(raw).toContain('event: session.bootstrap');
    expect(sessionStore.getOrHydrate).toHaveBeenCalledWith('s-bootstrap');
    expect(raw).toContain('"desiredExecution":"running"');
    expect(raw).toContain('"condition":"executing"');
    expect(raw).not.toContain('Internal kickoff');
    expect(raw).toContain('Visible output');
    expect(raw).toContain('"title":"Bootstrap Session"');
    expect(raw).toContain('"command":"npm test"');
  });

  it('returns pending approval when one exists', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      pendingApproval: { actionId: 'a1', tool: 'run_command', toolCallId: 'tc-1' },
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1', { approvals: true });

    const res = await request(app).get('/sessions/s1/approvals');

    expect(res.status).toBe(200);
    expect(res.body.approval).toEqual(expect.objectContaining({ actionId: 'a1', tool: 'run_command' }));
  });

  it('lists checkpoints for the session owner', async () => {
    const session = {
      id: 's-checkpoints',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    (services.checkpointManager as any).list.mockResolvedValue([{ id: 'cp1' }]);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-checkpoints/checkpoints');

    expect(res.status).toBe(200);
    expect(res.body.checkpoints).toEqual([{ id: 'cp1' }]);
  });

  it('blocks checkpoint listing for non-owners', async () => {
    const session = {
      id: 's-checkpoints-deny',
      userId: 'owner',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'other-user');

    const res = await request(app).get('/sessions/s-checkpoints-deny/checkpoints');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('creates a checkpoint for the session owner', async () => {
    const session = {
      id: 's-checkpoints-create',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    (services.checkpointManager as any).create.mockResolvedValue({ id: 'cp-create' });
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-checkpoints-create/checkpoints');

    expect(res.status).toBe(201);
    expect(res.body.checkpoint).toEqual({ id: 'cp-create' });
  });

  it('restores a checkpoint for the session owner', async () => {
    const session = {
      id: 's-checkpoints-restore',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    (services.checkpointManager as any).restore.mockResolvedValue({ id: 'cp-restore' });
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-checkpoints-restore/checkpoints/cp-restore/restore');

    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toEqual({ id: 'cp-restore' });
    expect((services.checkpointManager as any).restore).toHaveBeenCalledWith('s-checkpoints-restore', 'cp-restore');
  });

  it('blocks checkpoint restore for non-owners', async () => {
    const session = {
      id: 's-checkpoints-restore-deny',
      userId: 'owner',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'other-user');

    const res = await request(app).post('/sessions/s-checkpoints-restore-deny/checkpoints/cp-1/restore');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('returns 404 when restoring a missing checkpoint', async () => {
    const session = {
      id: 's-checkpoints-missing',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
    };
    const { services } = buildServices(session);
    (services.checkpointManager as any).restore.mockRejectedValue(new Error('Checkpoint not found'));
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-checkpoints-missing/checkpoints/cp-missing/restore');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('returns an empty app artifact inventory for the session owner', async () => {
    const artifacts = [
      {
        id: 'a-list',
        filePath: 'sessions/s-artifacts/output.txt',
        originalName: 'output.txt',
        fileType: 'text/plain',
        sizeBytes: 12,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    const session = {
      id: 's-artifacts',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts,
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-artifacts/artifacts');

    expect(res.status).toBe(200);
    expect(res.body.artifacts).toEqual([]);
  });

  it('denies artifact list access for non-owners via db lookup', async () => {
    const sessionId = 's-artifacts-db';
    const { services } = buildServices(undefined);
    persistenceMocks.findById.mockResolvedValue({ id: sessionId, userId: 'owner' });
    const app = buildApp(services, 'other-user');

    const res = await request(app).get(`/sessions/${sessionId}/artifacts`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('denies artifact content access for non-owners via db lookup', async () => {
    const sessionId = 's-artifacts-content-deny';
    const { services } = buildServices(undefined);
    persistenceMocks.findById.mockResolvedValue({ id: sessionId, userId: 'owner' });
    const app = buildApp(services, 'other-user');

    const res = await request(app).get(`/sessions/${sessionId}/artifacts/a1/content`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('denies artifact download access for non-owners via db lookup', async () => {
    const sessionId = 's-artifacts-download-deny';
    const { services } = buildServices(undefined);
    persistenceMocks.findById.mockResolvedValue({ id: sessionId, userId: 'owner' });
    const app = buildApp(services, 'other-user');

    const res = await request(app).get(`/sessions/${sessionId}/artifacts/a1/download`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('blocks raw artifact content for a session owner', async () => {
    const artifacts = [
      {
        id: 'a1',
        filePath: 'sessions/s-art/output.txt',
        originalName: 'output.txt',
        fileType: 'text/plain',
        sizeBytes: 12,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    const session = {
      id: 's-art',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts,
    };
    fsMocks.promises.readFile.mockResolvedValueOnce('artifact data');
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-art/artifacts/a1/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('blocks raw artifact content before revealing whether an artifact id exists', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-known',
        filePath: 'sessions/s-unknown/known.txt',
        originalName: 'known.txt',
        fileType: 'text/plain',
        sizeBytes: 4,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-unknown',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-known',
          filePath: 'sessions/s-unknown/known.txt',
          originalName: 'known.txt',
          fileType: 'text/plain',
          sizeBytes: 4,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-unknown/artifacts/a-missing/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('blocks raw artifact content before checking whether artifact content exists', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-missing',
        filePath: 'sessions/s-missing/missing.txt',
        originalName: 'missing.txt',
        fileType: 'text/plain',
        sizeBytes: 0,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-missing',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-missing',
          filePath: 'sessions/s-missing/missing.txt',
          originalName: 'missing.txt',
          fileType: 'text/plain',
          sizeBytes: 0,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    fsMocks.existsSync.mockReturnValueOnce(false);
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-missing/artifacts/a-missing/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('blocks artifact content when path escapes storage root', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-escape',
        filePath: '../secrets.txt',
        originalName: 'secrets.txt',
        fileType: 'text/plain',
        sizeBytes: 12,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-escape',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-escape',
          filePath: '../secrets.txt',
          originalName: 'secrets.txt',
          fileType: 'text/plain',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-escape/artifacts/a-escape/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('blocks artifact download when path escapes storage root', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-escape-download',
        filePath: '../secrets.txt',
        originalName: 'secrets.txt',
        fileType: 'text/plain',
        sizeBytes: 12,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-escape-download',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-escape-download',
          filePath: '../secrets.txt',
          originalName: 'secrets.txt',
          fileType: 'text/plain',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-escape-download/artifacts/a-escape-download/download');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('returns 404 when artifact download file is missing', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-download-missing',
        filePath: 'sessions/s-download-missing/missing.txt',
        originalName: 'missing.txt',
        fileType: 'text/plain',
        sizeBytes: 0,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-download-missing',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-download-missing',
          filePath: 'sessions/s-download-missing/missing.txt',
          originalName: 'missing.txt',
          fileType: 'text/plain',
          sizeBytes: 0,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    fsMocks.existsSync.mockReturnValueOnce(false);
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-download-missing/artifacts/a-download-missing/download');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('returns 404 when artifact download id is unknown', async () => {
    persistenceMocks.listBySession.mockResolvedValue([
      {
        id: 'a-known-download',
        filePath: 'sessions/s-download-unknown/known.txt',
        originalName: 'known.txt',
        fileType: 'text/plain',
        sizeBytes: 4,
        createdAt: Date.now(),
        storage: 'local',
      },
    ]);
    const session = {
      id: 's-download-unknown',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a-known-download',
          filePath: 'sessions/s-download-unknown/known.txt',
          originalName: 'known.txt',
          fileType: 'text/plain',
          sizeBytes: 4,
          createdAt: Date.now(),
          storage: 'local',
        },
      ],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-download-unknown/artifacts/a-missing/download');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('returns 404 when report artifact is missing for pdf download', async () => {
    persistenceMocks.listBySession.mockResolvedValue([]);
    const session = {
      id: 's-pdf-missing',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [],
      title: 'Missing Report',
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-pdf-missing/report/pdf');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('returns a pdf report for the session report artifact', async () => {
    const artifacts = [
      {
        id: 'a-report',
        filePath: 'sessions/s-pdf/report.md',
        originalName: 'report.md',
        fileType: 'markdown',
        sizeBytes: 42,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    const session = {
      id: 's-pdf',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      title: 'My Report',
      artifacts,
    };
    fsMocks.promises.readFile.mockResolvedValueOnce('report markdown');
    pdfMocks.generateReport.mockResolvedValueOnce(Buffer.from('PDF'));
    persistenceMocks.findById.mockResolvedValue({ id: 's-pdf', createdAt: new Date('2024-01-01T00:00:00Z') });
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-pdf/report/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('report-My_Report-s-pdf');
    expect(pdfMocks.generateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: 'report markdown',
        sessionId: 's-pdf',
        title: 'My Report',
      }),
    );
  });

  it('prefers linked run metadata over executor resume titles for report PDFs', () => {
    const cover = resolvePdfReportCoverMetadata({
      session: {
        id: 'session-1',
        title: 'Continue the reporting phase from the saved checkpoint',
        profileKey: 'phase:reporting',
        flags: {},
      } as any,
      dbSession: {
        title: 'Continue working',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      runRow: {
        runTitle: 'NIST CSF 2.0 Readiness Assessment - infert.co Production Scope',
        runGoal: 'Assess NIST CSF readiness for infert.co after a credit-exhausted resume.',
        scopeName: 'production',
        orgName: 'INFERT',
      },
    });

    expect(cover).toMatchObject({
      title: 'NIST CSF 2.0 Readiness Assessment - infert.co Production Scope',
      taskName: 'production',
      clientOrgName: 'INFERT',
    });
    expect(cover.title).not.toContain('Continue');
    expect(cover.taskName).not.toContain('phase:reporting');
  });

  it('passes browser screenshot artifacts as inline image assets for report PDF generation', async () => {
    const artifacts = [
      {
        id: 'a-report',
        filePath: 'sessions/s-pdf-image/report.md',
        originalName: 'report.md',
        fileType: 'markdown',
        sizeBytes: 84,
        createdAt: Date.now(),
        storage: 'local',
      },
      {
        id: 'a-screenshot',
        filePath: 'sessions/s-pdf-image/.artifacts/browser/screenshots/login.png',
        originalName: '.artifacts/browser/screenshots/login.png',
        fileType: 'png',
        sizeBytes: 3,
        createdAt: Date.now(),
        storage: 'local',
      },
    ];
    persistenceMocks.listBySession.mockResolvedValue(artifacts);
    fsMocks.promises.readFile.mockImplementation(async (filePath: any) => {
      const value = String(filePath);
      if (value.includes('report.md')) {
        return '![Browser screenshot](.artifacts/browser/screenshots/login.png)';
      }
      if (value.includes('login.png')) {
        return Buffer.from([0x01, 0x02, 0x03]);
      }
      return 'artifact content';
    });
    pdfMocks.generateReport.mockResolvedValueOnce(Buffer.from('PDF'));
    persistenceMocks.findById.mockResolvedValue({ id: 's-pdf-image', createdAt: new Date('2024-01-01T00:00:00Z') });
    const { services } = buildServices({
      id: 's-pdf-image',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      title: 'Image Report',
      artifacts,
    });
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-pdf-image/report/pdf');

    expect(res.status).toBe(200);
    expect(pdfMocks.generateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: '![Browser screenshot](.artifacts/browser/screenshots/login.png)',
        imageAssets: [
          expect.objectContaining({
            dataUrl: 'data:image/png;base64,AQID',
            sourcePaths: expect.arrayContaining([
              'artifact:a-screenshot',
              '.artifacts/browser/screenshots/login.png',
              'sessions/s-pdf-image/.artifacts/browser/screenshots/login.png',
            ]),
          }),
        ],
      }),
    );
  });

  it('returns the session plan for the owner', async () => {
    const session = {
      id: 's-plan',
      userId: 'user-1',
      plan: [{ id: 'step-1', title: 'Step 1', status: 'pending' }],
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-plan/plan');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(session.plan);
  });

  it('paginates session messages', async () => {
    const session = { id: 's-msg', userId: 'user-1' };
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [
        {
          id: 'm-internal',
          role: 'user',
          content: 'hidden',
          metadata: { visibility: 'internal', source: 'planner_kickoff' },
          createdAt: new Date('2024-01-01T00:00:00Z'),
        },
        { id: 'm1', role: 'user', content: 'hello', createdAt: new Date('2024-01-01T00:00:00Z') },
      ],
      meta: { hasMore: true, nextCursor: 'next' },
    });

    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');
    const res = await request(app).get('/sessions/s-msg/messages?limit=2&direction=forward&cursor=prev');

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe('m1');
    expect(res.body.pagination).toEqual(
      expect.objectContaining({ limit: 2, hasMore: true, cursor: 'next' }),
    );
    expect(res.body.messages[0].timestamp).toBeGreaterThan(0);
  });

  it('returns default pagination when query params are omitted', async () => {
    const session = { id: 's-msg-defaults', userId: 'user-1' };
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [],
      meta: { hasMore: false, nextCursor: undefined },
    });

    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');
    const res = await request(app).get('/sessions/s-msg-defaults/messages');

    expect(res.status).toBe(200);
    expect(persistenceMocks.listBySessionPaged).toHaveBeenCalledWith('s-msg-defaults', {
      limit: undefined,
      cursor: undefined,
      direction: undefined,
    });
    expect(res.body.pagination).toEqual(
      expect.objectContaining({ limit: 100, hasMore: false }),
    );
    expect(res.body.pagination.cursor).toBeUndefined();
  });

  it('supports backward pagination with cursor', async () => {
    const session = { id: 's-msg-back', userId: 'user-1' };
    persistenceMocks.listBySessionPaged.mockResolvedValue({
      data: [
        { id: 'm-back', role: 'assistant', content: 'ok', createdAt: new Date() },
      ],
      meta: { hasMore: false, nextCursor: undefined },
    });

    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');
    const res = await request(app).get('/sessions/s-msg-back/messages?direction=backward&cursor=prev');

    expect(res.status).toBe(200);
    expect(persistenceMocks.listBySessionPaged).toHaveBeenCalledWith('s-msg-back', {
      limit: undefined,
      cursor: 'prev',
      direction: 'backward',
    });
    expect(res.body.pagination).toEqual(
      expect.objectContaining({ limit: 100, hasMore: false }),
    );
    expect(res.body.pagination.cursor).toBeUndefined();
  });

  it('returns 404 when summary is missing', async () => {
    summaryMocks.generateSummary.mockResolvedValue('');
    const session = { id: 's-summary', userId: 'user-1' };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-summary/summary');

    expect(res.status).toBe(404);
  });

  it('returns token usage limits for a session', async () => {
    tokenGuardMocks.checkLimits.mockReturnValue({
      exceeded: false,
      currentUsage: 12,
      limit: 100,
      usagePct: 12.4,
      warning: true,
      limitType: 'session',
      message: 'warn',
    });
    const session = {
      id: 's-usage',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).get('/sessions/s-usage/usage');

    expect(res.status).toBe(200);
    expect(res.body.limits).toEqual(
      expect.objectContaining({ current: 12, limit: 100, usagePct: 12, warning: true }),
    );
  });

  it('records Stop intent for an idle session and preserves it as startable', async () => {
    const session = {
      id: 's-stop-idle',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      version: 4,
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.recordStopRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-stop-idle/stop');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      stopped: true,
      blocked_reason: 'user_paused',
    }));
    expect(sessionStore.recordStopRequestedAsync).toHaveBeenCalledWith(
      's-stop-idle',
      'Stopped by operator.',
      'user-1',
    );
    expect(persistenceMocks.setBlockedReason).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).toHaveBeenCalled();
    expect(sessionStore.abortCurrentTurnAsync).toHaveBeenCalledWith(
      's-stop-idle',
      'Stopped by operator.',
    );
  });

  it('marks idle child workers as blocked without trying to abort an already idle child turn', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue(null);
    persistenceMocks.listChildSessionIds.mockResolvedValue(['s-child']);

    const parent = {
      id: 's-parent',
      userId: 'user-1',
      stateMachine: mockStateMachine(true),
      workerTasks: [
        {
          taskId: 'task-1',
          parentSessionId: 's-parent',
          workerSessionId: 's-child',
          workerType: 'recon_worker',
          status: 'running',
          reason: 'Need recon coverage.',
          task: 'Map the public surface.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
      ],
    };
    const child = {
      id: 's-child',
      userId: 'user-1',
      blockedReason: undefined,
      stateMachine: mockStateMachine(false),
      coordination: {
        role: 'worker',
        parentSessionId: 's-parent',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        executionMode: 'background',
      },
      flags: {},
    };
    const sessions = new Map<string, any>([
      [parent.id, parent],
      [child.id, child],
    ]);
    const { services, sessionStore } = buildServices(parent);
    sessionStore.get.mockImplementation(((id: string) => sessions.get(id)) as any);
    sessionStore.getOrHydrate.mockImplementation((async (id: string) => sessions.get(id)) as any);
    sessionStore.setAsync.mockImplementation(async (id: string, next: any) => {
      sessions.set(id, next);
    });
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-parent/stop');

    expect(res.status).toBe(200);
    expect(child.blockedReason).toBe('user_paused');
    expect(parent.workerTasks[0].status).toBe('blocked');
    expect((parent.workerTasks[0] as any).lastStatusReason).toContain('parent session is user paused');
    expect(persistenceMocks.setBlockedReasonIfClear).toHaveBeenCalledWith(
      's-child',
      'user_paused',
      expect.objectContaining({
        source: 'parent_session',
        parentSessionId: 's-parent',
        controller: 'parent_session',
        controllerId: 's-parent',
      }),
    );
    expect(sessionStore.abortCurrentTurnAsync).toHaveBeenCalledWith('s-parent', 'Stopped by operator.');
    expect(sessionStore.abortCurrentTurnAsync).not.toHaveBeenCalledWith('s-child', 'user_paused');
  });

  it('lets explicit Start override an unknown legacy guard block', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('guard_exhausted');
    const session = { id: 's-resume-invalid', userId: 'user-1', stateMachine: mockStateMachine(false), flags: {} };
    const { services } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-resume-invalid/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      started: true,
      status: 'running',
    }));
  });

  it('starts a journal-stopped session without invoking legacy recovery actions', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('user_paused');
    const session = {
      id: 's-start',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      blockedReason: 'user_paused',
      flags: {},
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.getJournalProjection.mockResolvedValue({ desiredExecution: 'stopped' });
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-start/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      started: true,
      recovery_scheduled: true,
      blocked_reason: null,
    }));
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-start',
      'start after user_paused',
      'user-1',
    );
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
  });

  it('starts preserved history after session completion and reports scheduled running state', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue(null);
    const session = {
      id: 's-start-completed',
      userId: 'user-1',
      completed: true,
      stateMachine: mockStateMachine(false),
      flags: { session: { completed: true } },
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-start-completed/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      started: true,
      recovery_scheduled: true,
      status: 'running',
      pause_reason: null,
      blocked_reason: null,
    }));
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-start-completed',
      'start after completed',
      'user-1',
    );
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
  });

  it('lets explicit Start override a legacy error block without a recovery flag gate', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('error');
    const session = {
      id: 's-start-error',
      userId: 'user-1',
      blockedReason: 'error',
      blockedMeta: { recoverable: false },
      stateMachine: mockStateMachine(false),
      flags: {},
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-start-error/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      recovery_scheduled: true,
      status: 'running',
      blocked_reason: null,
    }));
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-start-error',
      'start after error',
      'user-1',
    );
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
  });

  it('returns 401 when Start cannot resolve a user identity', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('user_paused');
    const session = { id: 's-resume-anon', stateMachine: mockStateMachine(false), flags: {} };
    const { services } = buildServices(session);
    const app = buildApp(services, undefined);

    const res = await request(app).post('/sessions/s-resume-anon/start');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth.invalid_session');
  });

  it('accepts Start while credits are still exhausted and lets recovery wait', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('credits_exhausted');
    const session = {
      id: 's-resume-credits',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      flags: { securityops: { organizationId: 'org-1' } },
    };
    const accessControl = {
      resolveOrganizationSubscription: vi.fn().mockResolvedValue({
        creditsCurrent: 0,
        periodEnd: 123,
        plan: { slug: 'control' },
      }),
    };
    const { services, sessionStore } = buildServices(session, { accessControl: accessControl as any });
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-resume-credits/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      started: true,
      recovery_scheduled: true,
    }));
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-resume-credits',
      'start after credits_exhausted',
      'user-1',
    );
    expect(accessControl.resolveOrganizationSubscription).not.toHaveBeenCalled();
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).not.toHaveBeenCalled();
  });

  it('starts credits_exhausted sessions when credits are restored', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('credits_exhausted');
    const session = {
      id: 's-resume-ok',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      flags: {
        credits_exhausted: true,
        securityops: { organizationId: 'org-1' },
      },
      workspaceDir: '/workspace',
    };
    const accessControl = {
      resolveOrganizationSubscription: vi.fn().mockResolvedValue({
        creditsCurrent: 12,
        periodEnd: 999,
        plan: { slug: 'control' },
      }),
    };
    const { services, sessionStore } = buildServices(session, { accessControl: accessControl as any });
    const app = buildApp(services, 'user-1');

    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const res = await request(app).post('/sessions/s-resume-ok/start');

    expect(res.status).toBe(200);
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).not.toHaveBeenCalled();
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
    expect(res.body.recovery_scheduled).toBe(true);
    expect(res.body.creditsRemaining).toBeUndefined();
    expect(accessControl.resolveOrganizationSubscription).not.toHaveBeenCalled();
  });

  it('starts user-stopped sessions from the durable journal', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('user_paused');
    const session = {
      id: 's-resume',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      flags: {
        user_paused: true,
      },
      workspaceDir: '/workspace',
    };
    const { services, sessionStore } = buildServices(session);
    const app = buildApp(services, 'user-1');

    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const res = await request(app).post('/sessions/s-resume/start');

    expect(res.status).toBe(200);
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).not.toHaveBeenCalled();
    expect(services.traceRecorder!.init).not.toHaveBeenCalled();
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('accepts idempotent Start while automatic recovery owns the wait', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue('system_paused');
    const session = {
      id: 's-system-resume',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      blockedReason: 'system_paused',
      flags: {
        system_paused: true,
      },
      workspaceDir: '/workspace',
    };
    const { services, sessionStore } = buildServices(session);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-system-resume/start');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      started: true,
      recovery_scheduled: true,
    }));
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-system-resume',
      'start after system_paused',
      'user-1',
    );
    expect(sessionStore.setAsync).not.toHaveBeenCalled();
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('starts eligible background child workers when their parent starts', async () => {
    persistenceMocks.listChildSessionIds.mockResolvedValue(['s-child']);
    persistenceMocks.getBlockedReason.mockImplementation(async (id: string) => {
      if (id === 's-parent-resume') return 'user_paused';
      if (id === 's-child') return 'user_paused';
      return null;
    });

    const parent = {
      id: 's-parent-resume',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      blockedReason: 'user_paused',
      flags: { user_paused: true },
      workspaceDir: '/workspace',
      workerTasks: [
        {
          taskId: 'task-1',
          parentSessionId: 's-parent-resume',
          workerSessionId: 's-child',
          workerType: 'recon_worker',
          status: 'blocked',
          reason: 'Need recon coverage.',
          task: 'Map the public surface.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          continuationMode: 'spawn',
          createdAt: Date.now(),
          lastStatusReason: 'Worker blocked because the parent session is user paused.',
        },
      ],
    };
    const child = {
      id: 's-child',
      userId: 'user-1',
      blockedReason: 'user_paused',
      stateMachine: mockStateMachine(false),
      coordination: {
        role: 'worker',
        parentSessionId: 's-parent-resume',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        executionMode: 'background',
      },
      flags: {},
    };
    const sessions = new Map<string, any>([
      [parent.id, parent],
      [child.id, child],
    ]);
    const { services, sessionStore } = buildServices(parent);
    sessionStore.get.mockImplementation(((id: string) => sessions.get(id)) as any);
    sessionStore.getOrHydrate.mockImplementation((async (id: string) => sessions.get(id)) as any);
    sessionStore.setAsync.mockImplementation(async (id: string, next: any) => {
      sessions.set(id, next);
    });
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-parent-resume/start');

    expect(res.status).toBe(200);
    expect(persistenceMocks.clearBlockedReason).not.toHaveBeenCalled();
    expect(sessionStore.recordStartRequestedAsync).toHaveBeenCalledWith(
      's-child',
      'parent s-parent-resume started after user_paused',
      'parent:s-parent-resume',
    );
    expect(sessionStore.recordExecutionDeferredAsync).not.toHaveBeenCalled();
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
    expect(res.body.child_recoveries_scheduled).toBe(1);
  });

  it('accepts Start from journal intent even if a compatibility block was not persisted', async () => {
    persistenceMocks.getBlockedReason.mockResolvedValue(null);
    const session = {
      id: 's-resume-memory',
      userId: 'user-1',
      stateMachine: mockStateMachine(false),
      blockedReason: 'user_paused',
      flags: { user_paused: true },
      workspaceDir: '/workspace',
    };
    const { services, sessionStore } = buildServices(session);
    sessionStore.recordStartRequestedAsync.mockResolvedValue(true);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions/s-resume-memory/start');

    expect(res.status).toBe(200);
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('returns 410 for direct session creation and points callers to /api/app/runs', async () => {
    const { services } = buildServices(undefined);
    const app = buildApp(services, 'user-1');

    const res = await request(app).post('/sessions').send({
      mode: 'interactive',
      scopeId: '123e4567-e89b-12d3-a456-426614174000',
      extraContext: 'legacy-direct-create',
    });

    expect(res.status).toBe(410);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
  });
});



