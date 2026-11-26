import { vi, describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

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
  config: { ...baseConfig, ...(overrides.config ?? {}), network: overrides.network ?? (baseConfig as any).network },
  isDev: true,
  sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
});

describe('API gateway CORS defaults', () => {
  it('allows localhost fallback origins when no CORS allowlist is provided', async () => {
    const app = createHttpApp(createAppContext() as any);

    const res = await request(app).get('/health').set('Origin', 'http://localhost:8081');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // A page from another site never reaches CORS: localHostOnly refuses it first (its own tests).
  it('blocks a page on this computer whose origin the configured allowlist does not name', async () => {
    const app = createHttpApp(
      createAppContext({ network: { corsAllowedOrigins: ['http://localhost:5173'] } }) as any,
    );

    const res = await request(app).get('/health').set('Origin', 'http://localhost:9999');

    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
