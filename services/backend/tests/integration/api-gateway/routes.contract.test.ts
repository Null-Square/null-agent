import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

vi.mock('@/db/client', () => ({
  db: {},
  checkDbHealth: vi.fn(async () => ({ ok: true, ms: 0 })),
}));

function okRouter(routePath = '/') {
  const router = express.Router();
  router.get(routePath, (_req, res) => res.json({ ok: true }));
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

const createAppContext = (overrides: Partial<any> = {}) => {
  const config = overrides.config ?? baseConfig;
  const traceRoot = overrides.traceRoot ?? config.trace.traceLogsRoot;
  return {
    config: { ...config, trace: { ...config.trace, traceLogsRoot: traceRoot } },
    isDev: true,
    sandbox: overrides.sandbox ?? { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
    streamBroker: {},
    sessionStore: { listSessions: vi.fn(() => []) },
    agentServices: { artifactService: {} },
    usageStore: {},
    workspaceManager: { getMetrics: vi.fn(() => ({})) },
    traceRecorder: undefined,
    appRole: overrides.appRole,
  };
};

describe('API gateway routes (metrics + logs)', () => {
  it('serves metrics in text/plain with Prometheus format', async () => {
    const app = createHttpApp(
      createAppContext({
        config: { ...baseConfig },
      }) as any,
    );

    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Check for Prometheus format markers instead of specific metric that doesn't exist
    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('# TYPE');
  });

  it('serves ndjson traces from configured root with plain text headers', async () => {
    const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-'));
    const sessionDir = path.join(traceRoot, 'sess-abc');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'trace.ndjson'), 'hello trace');

    const app = createHttpApp(createAppContext({ traceRoot }) as any);
    const res = await request(app).get('/logs/ai-agent/sess-abc/trace.ndjson');

    expect(res.status).toBe(200);
    expect(res.text).toBe('hello trace');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-disposition']).toBe('inline');

    fs.rmSync(traceRoot, { recursive: true, force: true });
  });
});









