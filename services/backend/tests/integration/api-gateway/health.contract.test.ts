import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

vi.mock('@/db/client', () => ({
  db: {},
  checkDbHealth: vi.fn(async () => ({ ok: true, ms: 0 })),
}));

function okRouter(path = '/') {
  const router = express.Router();
  router.get(path, (_req, res) => res.json({ ok: true }));
  return router;
}

// Mock maintenance middleware to avoid import issues

vi.mock('@/interfaces/http/controllers/ai-agent/AgentRouter', () => ({
  createAgentRouter: vi.fn(() => okRouter('/api/ai-agent/ping')),
}));
vi.mock('@/interfaces/http/controllers/auth', () => ({
  __esModule: true,
  default: okRouter('/'),
  createAuthRouter: () => okRouter('/'),
}));
vi.mock('@/interfaces/http/controllers/profile', () => ({
  __esModule: true,
  default: okRouter('/'),
  createProfileRouter: () => okRouter('/'),
}));
vi.mock('swagger-ui-express', () => ({
  __esModule: true,
  default: {
    serve: [(_req: any, _res: any, next: () => void) => next()],
    setup: () => (_req: any, _res: any, next: () => void) => next(),
  },
}));
vi.mock('@/shared/openapi', () => ({
  generateOpenAPIDocument: vi.fn(() => ({ openapi: '3.0.0', info: { title: 'test', version: '1.0.0' } })),
}));
vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (_req: any, _res: any, next: () => void) => next(),
}));

const baseConfig = {
  network: { corsAllowedOrigins: [] as string[] },
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

  workspace: { rootDir: '/tmp/ws', objectStoreRoot: '/tmp/obj', maxBytesPerWorkspace: undefined as number | undefined },
  http: {
    logSlowMs: 750,
    logDebugSampleRate: 0,
    logQuietPaths: [],
    uploadsMaxBytes: 25 * 1024 * 1024,
  },
};

const createAppContext = (overrides: Partial<any> = {}) => ({
  config: { ...baseConfig, ...(overrides.config ?? {}) },
  isDev: true,
  sandbox: overrides.sandbox ?? { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
  s3ArtifactsClient: overrides.s3ArtifactsClient,
  s3TracesClient: overrides.s3TracesClient,
  appRole: overrides.appRole,
});

describe('API gateway readiness', () => {
  it('returns 200 when sandbox is healthy', async () => {
    const sandbox = { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) };
    const app = createHttpApp(createAppContext({ sandbox }) as any);

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.redis).toBe('removed');
    expect(res.body.sandboxes).toEqual({ manager: true, healthy: true });
  });

  it('surfaces s3 flags and sandbox list errors in /health/extended', async () => {
    const s3Client = { checkHealth: vi.fn(async () => ({ ok: true, ms: 1 })) };
    const sandbox = { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => { throw new Error('boom'); }) };
    const app = createHttpApp(createAppContext({
      sandbox,
      appRole: 'worker',
      config: { ...baseConfig, appRole: 'worker' },
      s3ArtifactsClient: s3Client,
      s3TracesClient: s3Client,
    }) as any);

    const res = await request(app).get('/health/extended');

    expect(res.status).toBe(503);
    expect(res.body.sandboxes).toBe('error');
    expect(res.body.role).toBe('worker');
  });

  it('returns 200 and reports s3 ok when clients exist', async () => {
    const sandbox = { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) };
    const app = createHttpApp(createAppContext({ sandbox }) as any);

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.redis).toBe('removed');
    expect(res.body.sandboxes).toEqual({ manager: true, healthy: true });
    expect(res.body.s3Artifacts.status).toBe('disabled');
    expect(res.body.s3Traces.status).toBe('disabled');
    expect(res.body.s3Workspaces.status).toBe('disabled');

    const s3Client = { checkHealth: vi.fn(async () => ({ ok: true, ms: 1 })) };
    const withS3 = createHttpApp(createAppContext({ sandbox, s3ArtifactsClient: s3Client, s3TracesClient: s3Client }) as any);
    const resS3 = await request(withS3).get('/health/ready');
    expect(resS3.body.s3Artifacts.status).toBe('ok');
    expect(resS3.body.s3Traces.status).toBe('ok');
  });

  it('returns 503 when sandbox is unhealthy', async () => {
    const sandbox = { isHealthy: vi.fn(() => false), listSandboxes: vi.fn(async () => []) };
    const app = createHttpApp(createAppContext({ sandbox }) as any);

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.sandboxes.healthy).toBe(false);
  });
});









