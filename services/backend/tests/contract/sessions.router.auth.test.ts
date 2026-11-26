import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware/errors';
import type { AgentApiServices } from '@/interfaces/http/controllers/ai-agent/types';

// Use vi.hoisted() for all mocks that need to be available in vi.mock factories
const mocks = vi.hoisted(() => ({
  listByUserMock: vi.fn(() => Promise.resolve([])),
  findByIdMock: vi.fn(() => Promise.resolve(null)),
  getBlockedReasonMock: vi.fn(() => Promise.resolve(null)),
  setBlockedReasonMock: vi.fn(() => Promise.resolve(undefined)),
  updateTitleMock: vi.fn(() => Promise.resolve(true)),
  clearBlockedReasonMock: vi.fn(() => Promise.resolve(undefined)),
  resolveSubscriptionMock: vi.fn((_userId?: string) => Promise.resolve({
    plan: { features: {}, limits: {} },
    creditsCurrent: 10,
  })),
}));

// Use class-based mocks for proper ESM compatibility
vi.mock('@/domains/agent-brain/adapters/persistence', () => ({
  SessionRepository: class MockSessionRepository {
    listByUser = mocks.listByUserMock;
    findById = mocks.findByIdMock;
    getBlockedReason = mocks.getBlockedReasonMock;
    setBlockedReason = mocks.setBlockedReasonMock;
    updateTitle = mocks.updateTitleMock;
    clearBlockedReason = mocks.clearBlockedReasonMock;
  },
  MessageRepository: class MockMessageRepository {},
  ArtifactRepository: class MockArtifactRepository {},
  CheckpointRepository: class MockCheckpointRepository {},
}));

vi.mock('@/domains/agent-brain/application/services/SessionService', () => ({
  SessionService: class MockSessionService {
    createSession = vi.fn();
  },
}));

vi.mock('@/domains/agent-brain/application/services/SessionSummaryService', () => ({
  SessionSummaryService: class MockSessionSummaryService {
    generateSummary = vi.fn(() => Promise.resolve('summary'));
  },
}));

vi.mock('@/domains/platform/subscriptions/subscriptionService', () => ({
  __esModule: true,
  default: {
    resolveSubscription: (userId: string) => mocks.resolveSubscriptionMock(userId),
    listPlans: vi.fn(async () => []),
    setSubscription: vi.fn(),
  },
}));

// Import routers after mocks
import { sessionsRouter } from '@/interfaces/http/controllers/ai-agent/routes/sessions.router';
import { streamRouter } from '@/interfaces/http/controllers/ai-agent/routes/stream.router';
import { approvalsRouter } from '@/interfaces/http/controllers/ai-agent/routes/approvals.router';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const buildServices = (session: any, overrides: Partial<AgentApiServices> = {}): AgentApiServices =>
({
  sessionStore: {
    get: vi.fn(() => session),
    getOrHydrate: vi.fn(async () => session),
    getExecutionReadModel: vi.fn(async () => ({
      desiredExecution: 'running',
      condition: 'idle',
    })),
    getExecutionReadModels: vi.fn(async (ids: string[]) => new Map(
      ids.map((id) => [id, { desiredExecution: 'running', condition: 'idle' }]),
    )),
    set: vi.fn(),
    listByUser: vi.fn(() => []),
    markAbortEventEmitted: vi.fn(),
    remove: vi.fn(() => false),
  },
  checkpointManager: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'cp1' }),
    restore: vi.fn().mockResolvedValue({ id: 'cp1' }),
  },
  sandbox: { writeFile: vi.fn().mockResolvedValue(undefined) } as any,
  toolsRegistry: {} as any,
  orchestrator: { processMessage: vi.fn() } as any,
  taskCatalog: {} as any,
  traceRecorder: undefined,
  usageTracker: undefined,
  sandboxProfileRegistry: {} as any,
  usageStore: undefined,
  streamBroker: {} as any,
  ports: {
    events: (() => {
      const subscribe = vi.fn((_id: string, cb: (event: any) => void) => {
        (subscribe as any).lastCallback = cb;
        return () => { };
      });
      return {
        emit: vi.fn(),
        subscribe,
      };
    })(),
    tools: {
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: false }),
    },
  } as any,
  agentEngine: {
    stopSandbox: vi.fn(),
    cleanupSession: vi.fn(),
    getSandboxPolicy: vi.fn().mockResolvedValue(null),
  } as any,
  artifactService: {} as any,
  policyResolver: {
    getDefaultPolicy: vi.fn().mockResolvedValue(null),
    getBySlug: vi.fn().mockResolvedValue(null),
    resolvePolicy: vi.fn().mockResolvedValue({ policy: { slug: 'default', parsedSpec: { tools: {}, sandbox: {} } }, source: 'default' }),
  } as any,
  ...overrides,
} as unknown as AgentApiServices);

const buildApp = (services: AgentApiServices, userId: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: userId };
    next();
  });
  app.use(sessionsRouter(services));
  app.use(streamRouter(services));
  app.use(errorHandler);
  return app;
};

describe('session routes authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByUserMock.mockResolvedValue([]);
  });

  it('blocks plan access for non-owners', async () => {
    const session = { id: 's1', userId: 'owner', plan: [] };
    const services = buildServices(session);
    const app = buildApp(services, 'other-user');

    const res = await request(app).get('/sessions/s1/plan');

    expect(res.status).toBe(403);
    expect(res.body.code).toBeDefined();
  });

  it('blocks stream access for non-owners and preserves configured CORS header', async () => {
    const session = { id: 's1', userId: 'owner' };
    const services = buildServices(session);
    const router = streamRouter(services) as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/sessions/:id/stream');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as any;

    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: undefined,
      setHeader: (key: string, value: string) => {
        headers[key.toLowerCase()] = String(value);
      },
      getHeader: (key: string) => headers[key.toLowerCase()],
      status: vi.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: vi.fn(),
    };
    res.setHeader('Access-Control-Allow-Origin', 'http://allowed.test');

    const req = Object.assign(new EventEmitter(), {
      params: { id: 's1' },
      user: { id: 'other-user' },
    });

    const next = vi.fn();
    await handler(req as any, res as any, next);
    errorHandler(next.mock.calls[0][0], req as any, res as any, vi.fn());

    expect(res.statusCode).toBe(403);
    expect(res.getHeader('access-control-allow-origin')).toBe('http://allowed.test');
  });

  it('blocks approvals for non-owners', async () => {
    const session = { id: 's1', userId: 'owner', pendingApproval: undefined };
    const services = buildServices(session);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: 'other-user' };
      next();
    });
    app.use(express.json());
    app.use(approvalsRouter(services));
    app.use(errorHandler);

    const res = await request(app).get('/sessions/s1/approvals');

    expect(res.status).toBe(403);
    expect(res.body.code).toBeDefined();
  });

  it('allows stream for owner and reuses configured origin header', async () => {
    const session = { id: 's1', userId: 'owner' };
    const services = buildServices(session);
    const router = streamRouter(services) as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/sessions/:id/stream');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as any;
    vi.useFakeTimers();

    const req = Object.assign(new EventEmitter(), {
      params: { id: 's1' },
      headers: {},
      user: { id: 'owner' },
      once: (EventEmitter.prototype.once as any),
    });

    const res = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      getHeader: vi.fn(() => 'http://allowed.test'),
      writableEnded: false,
      destroyed: false,
      once: (EventEmitter.prototype.once as any),
      on: (EventEmitter.prototype.on as any),
    });

    const next = vi.fn();
    try {
      await handler(req as any, res as any, next);

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': 'http://allowed.test',
        }),
      );
      expect(services.ports.events.subscribe).toHaveBeenCalledTimes(1);

      const subscriptionCb = (services.ports.events.subscribe as any).lastCallback as
        | ((event: any) => void)
        | undefined;
      subscriptionCb?.({ type: 'message', data: { hello: 'world' } });

      vi.advanceTimersByTime(15_000);
      expect(res.write).toHaveBeenCalled();
      expect(res.write).toHaveBeenCalledWith('event: message\n');
      expect(res.write).toHaveBeenCalledWith('data: {"hello":"world"}\n\n');

      req.emit('close');
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows approvals for owner and emits events', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: { actionId: 'a1', tool: 'run_command', toolCallId: 'a1' },
    };
    const services = buildServices(session);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: 'owner' };
      next();
    });
    app.use(express.json());
    app.use(approvalsRouter(services));
    app.use(errorHandler);

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(200);
    expect(services.ports.events.emit).toHaveBeenCalledWith('s1', {
      type: 'approval_granted',
      data: { actionId: 'a1' },
    });
  });

  it('includes in-memory sessions missing from persistence list', async () => {
    const now = Date.now();
    const liveSession = {
      id: 's-live',
      userId: 'owner',
      stateMachine: { isProcessing: () => true },
      lastActive: now + 1000,
      createdAt: now,
      flags: {},
      mode: 'interactive' as const,
      messages: [],
      plan: [],
      memory: createEmptyMemory(),
      workspaceDir: '/tmp/test',
      artifacts: [],
      profileKey: 'default',
      blockedReason: null,
    };
    mocks.listByUserMock.mockResolvedValue([
      {
        id: 's-db',
        userId: 'owner',
        title: 'DB Session',
        taskId: 'task-1',
        metadata: { taskTitle: 'Task 1' },
        mode: 'automated',
        createdAt: new Date(now - 2000),
        updatedAt: new Date(now - 1500),
        lastActiveAt: new Date(now - 1000),
        summary: null,
        plan: [] as any[],
        workspaceDir: '/tmp/session',
        blockedReason: null,
      },
    ] as any);

    const services = buildServices(liveSession, {
      sessionStore: {
        get: vi.fn((id: string) => (id === liveSession.id ? liveSession : undefined)),
        getOrHydrate: vi.fn(async (id: string) => (id === liveSession.id ? liveSession : undefined)),
        getExecutionReadModel: vi.fn(async () => ({
          desiredExecution: 'running',
          condition: 'executing',
        })),
        getExecutionReadModels: vi.fn(async (ids: string[]) => new Map(
          ids.map((id) => [id, { desiredExecution: 'running', condition: 'executing' }]),
        )),
        set: vi.fn(),
        listByUser: vi.fn(() => [liveSession]),
        markAbortEventEmitted: vi.fn(),
        remove: vi.fn(() => false),
      } as any,
    });
    const app = buildApp(services, 'owner');

    const res = await request(app).get('/sessions');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((session: { id: string }) => session.id);
    expect(ids).toEqual(expect.arrayContaining(['s-db', 's-live']));
  });
});
