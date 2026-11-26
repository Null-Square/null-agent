import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';
import { createAgentRouter } from '@/interfaces/http/controllers/ai-agent/AgentRouter';
import { resetRateLimitBuckets } from '@/shared/ratelimit';
import { ERROR_CODES } from '@null-ai/contracts';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

function okRouter(path = '/') {
  const router = express.Router();
  router.get(path, (_req, res) => res.json({ ok: true }));
  return router;
}

// Mock maintenance middleware to avoid import issues

vi.mock('@/interfaces/http/controllers/ai-agent/AgentRouter', () => ({
  createAgentRouter: vi.fn(() => okRouter('/ping')),
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

const createAppContext = (configOverrides: Partial<typeof baseConfig> = {}) => ({
  config: {
    ...baseConfig,
    ...configOverrides,
    http: { ...baseConfig.http, ...(configOverrides.http ?? {}) },
  },
  isDev: true,
  sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
});

describe('API gateway rate limits', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('exposes the per-user interactive budget on authenticated account routes', async () => {
    const app = createHttpApp(createAppContext() as any);

    const first = await request(app).get('/api/profile');
    const second = await request(app).get('/api/profile');

    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('300');
    expect(first.headers['x-ratelimit-remaining']).toBe('299');
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('298');
  });

  // Each route tree is gated by exactly one app.use(). Express runs every
  // middleware whose mount path prefixes the request, so attaching the limiter
  // to a sub-mount as well counts one request twice and halves the real budget.
  // These cases fail if that regresses: the remaining count would step by 2.
  describe('counts a request exactly once per route tree', () => {
    // Every sub-mount that sits under a gated prefix. Adding a route below a
    // gate is safe; adding the limiter to that route as well is not, and shows
    // up here as a step of 2.
    it.each([
      // /api/app tree
      ['/api/app/organization', '300'],
      ['/api/app/model', '300'],
      ['/api/app/context-setup', '300'],
      ['/api/app/scopes', '300'],
      ['/api/app/runs', '300'],
      ['/api/app/findings', '300'],
      ['/api/app/risks', '300'],
      ['/api/app/assets', '300'],
      ['/api/app/exposure', '300'],
      ['/api/app/dashboard', '300'],
      ['/api/app/compliance', '300'],
      ['/api/app/chat', '300'],
      ['/api/app/runners', '300'],
      ['/api/app/automations', '300'],
      ['/api/app/audit-logs', '300'],
      ['/api/app/runner-agent', '300'],
      // the auth tree
      ['/api/auth/me', '120'],
    ])('%s', async (path, expectedLimit) => {
      resetRateLimitBuckets();
      const app = createHttpApp(createAppContext() as any);

      const first = await request(app).get(path);
      const second = await request(app).get(path);

      expect(first.headers['x-ratelimit-limit']).toBe(expectedLimit);
      expect(first.headers['x-ratelimit-remaining']).toBe(String(Number(expectedLimit) - 1));
      expect(second.headers['x-ratelimit-remaining']).toBe(String(Number(expectedLimit) - 2));
    });
  });

  it('rejects at the configured ceiling, not half of it', async () => {
    const app = createHttpApp(createAppContext() as any);
    const server = app.listen(0);

    try {
      let sent = 0;
      let status = 0;
      while (status !== 429 && sent < 400) {
        sent += 1;
        status = (await request(server).get('/api/app/scopes')).status;
      }

      // 300 allowed, the 301st refused. A duplicate mount would fail at 151.
      expect(sent).toBe(301);
    } finally {
      server.close();
    }
  });

  it('gives the agent API its own bucket namespace', async () => {
    // Unnamed, it shared the bare-IP bucket with defaultRateLimit and chat
    // traffic drained the user-facing app's budget.
    createHttpApp(createAppContext() as any);

    expect(createAgentRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitOptions: expect.objectContaining({ name: 'agent' }),
      }),
    );
  });
});

