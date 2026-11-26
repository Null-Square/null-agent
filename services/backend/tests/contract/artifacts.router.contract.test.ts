import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware/errors';
import type { AgentApiServices } from '@/interfaces/http/controllers/ai-agent/types';
import { ERROR_CODES } from '@null-ai/contracts';

const artifactFixture: any[] = [];

vi.mock('@/domains/agent-brain/adapters/persistence', () => {
  return {
    ArtifactRepository: vi.fn().mockImplementation(() => ({
      listBySession: vi.fn(async () => artifactFixture),
      listRecent: vi.fn(),
    })),
    MessageRepository: vi.fn().mockImplementation(() => ({
      listBySessionId: vi.fn().mockResolvedValue([]),
    })),
    SessionRepository: vi.fn().mockImplementation(() => ({
      getById: vi.fn().mockResolvedValue(null),
    })),
  };
});

// Import sessionsRouter - will be initialized in beforeAll
let sessionsRouter: typeof import('@/interfaces/http/controllers/ai-agent/routes/sessions.router').sessionsRouter;

vi.mock('@/domains/platform/subscriptions/subscriptionService', () => ({
  __esModule: true,
  default: {
    resolveSubscription: vi.fn(async () => ({ plan: { slug: 'control' }, limits: {} })),
  },
}));

const buildServices = (session: any, overrides: { artifactStorageRoot?: string } = {}): AgentApiServices =>
  ({
    sessionStore: {
      get: vi.fn((id?: string) => (!id || id === session.id ? session : undefined)),
      set: vi.fn(),
      listByUser: vi.fn(() => []),
      remove: vi.fn(),
    },
    checkpointManager: { list: vi.fn(), create: vi.fn(), restore: vi.fn() },
    sandbox: { writeFile: vi.fn() } as any,
    toolsRegistry: {} as any,
    orchestrator: {} as any,
    taskCatalog: {} as any,
    traceRecorder: undefined,
    usageTracker: undefined,
    sandboxProfileRegistry: {} as any,
    usageStore: undefined,
    streamBroker: {} as any,
    ports: {
      events: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      tools: { handleApprovalDecision: vi.fn() },
      tasks: {
        getTask: vi.fn(async () => ({ id: 't1', inputs: [] })),
        listManifests: vi.fn(async () => []),
      },
    } as any,
    agentEngine: {
      stopSandbox: vi.fn(),
      cleanupSession: vi.fn(),
      getSandboxPolicy: vi.fn().mockResolvedValue(null),
    } as any,
    artifactService: {
      getStorageRoot: () => overrides.artifactStorageRoot ?? '',
    } as any,
    policyResolver: {
      getDefaultPolicy: vi.fn(),
      getBySlug: vi.fn(),
      resolvePolicy: vi.fn().mockResolvedValue({ policy: { slug: 'default', parsedSpec: { tools: {}, sandbox: {} } }, source: 'default' }),
    } as any,
    ...overrides,
  } as unknown as AgentApiServices);

const buildApp = (services: AgentApiServices) => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { id: services.sessionStore.get('s1')?.userId ?? 'user-1' };
    next();
  });
  // Pass mock repositories via services parameter (SessionsRouterDeps extends AgentApiServices)
  const servicesWithDeps = {
    ...services,
    artifactRepository: {
      listBySession: vi.fn(async () => artifactFixture),
      listRecent: vi.fn(),
    } as any,
    messageRepository: {
      listBySessionId: vi.fn().mockResolvedValue([]),
    } as any,
    sessionRepository: {
      getById: vi.fn().mockResolvedValue(null),
    } as any,
  };
  app.use(sessionsRouter(servicesWithDeps));
  app.use(errorHandler);
  return app;
};

describe('artifacts routes contracts', () => {
  beforeAll(async () => {
    const mod = await import('@/interfaces/http/controllers/ai-agent/routes/sessions.router');
    sessionsRouter = mod.sessionsRouter;
  });

  afterEach(() => {
    artifactFixture.length = 0;
  });

  it('returns 404 when artifact not found', async () => {
    const session = { id: 's1', userId: 'user-1', artifacts: [] };
    const services = buildServices(session, { artifactStorageRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-')) });
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts/missing/download');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('serves local artifact download when file exists', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
    const artifactPath = path.join(storageRoot, 's1', 'file.txt');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'hello');

    const session = {
      id: 's1',
      userId: 'user-1',
      artifacts: [{ id: 'a1', filePath: 's1/file.txt', originalName: 'file.txt' }],
    };
    const services = buildServices(session, { artifactStorageRoot: storageRoot });
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts/a1/download');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('file.txt');
    expect(res.text).toBe('hello');

    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
});







