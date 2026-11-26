import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

function stubRouter() {
  const router = express.Router();
  router.use((_req, _res, next) => next());
  return router;
}

// Mock maintenance middleware to avoid import issues

vi.mock('@/interfaces/http/controllers/ai-agent/AgentRouter', () => {
  const express = require('express');
  return {
    createAgentRouter: vi.fn(() => {
      const router = express.Router();
      router.get('/api/ai-agent/ping', (_req: express.Request, res: express.Response) => res.json({ ok: true }));
      return router;
    }),
  };
});
vi.mock('@/interfaces/http/controllers/auth', () => {
  return { __esModule: true, default: stubRouter(), createAuthRouter: () => stubRouter() };
});
vi.mock('@/interfaces/http/controllers/profile', () => {
  return { __esModule: true, default: stubRouter(), createProfileRouter: () => stubRouter() };
});
vi.mock('swagger-ui-express', () => ({ default: { serve: [(_req: any, _res: any, next: () => void) => next()], setup: () => (_req: any, _res: any, next: () => void) => next() },
  serve: (_req: any, _res: any, next: () => void) => next(),
  setup: () => (_req: any, _res: any, next: () => void) => next(),
}));
vi.mock('@/shared/openapi', () => ({
  generateOpenAPIDocument: vi.fn(() => ({ openapi: '3.0.0', info: { title: 'test', version: '1.0.0' } })),
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

const createAppContext = (corsAllowedOrigins: string[]) => ({
  config: { ...baseConfig, network: { corsAllowedOrigins } },
  isDev: true,
  redis: { ping: vi.fn(async () => 'PONG') },
  sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
});

describe('httpServer CORS configuration', () => {
  it('allows an exact local origin and echoes it back', async () => {
    const app = createHttpApp(createAppContext(['http://app.localhost:8081']) as any);

    const res = await request(app).get('/health').set('Origin', 'http://app.localhost:8081');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://app.localhost:8081');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows wildcard subdomains that match the configured pattern', async () => {
    const app = createHttpApp(createAppContext(['http://*.localhost:8081']) as any);

    const res = await request(app).get('/health').set('Origin', 'http://app.localhost:8081');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://app.localhost:8081');
  });

  it('allows host wildcard patterns without scheme for root and subdomains', async () => {
    const app = createHttpApp(createAppContext(['*.localhost', '127.0.0.1']) as any);

    const resSub = await request(app).get('/health').set('Origin', 'http://app.localhost:8081');
    expect(resSub.status).toBe(200);
    expect(resSub.headers['access-control-allow-origin']).toBe('http://app.localhost:8081');

    const resLocal = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(resLocal.status).toBe(200);
    expect(resLocal.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const resIp = await request(app).get('/health').set('Origin', 'http://127.0.0.1:8081');
    expect(resIp.status).toBe(200);
    expect(resIp.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8081');
  });

  it('blocks local origins that are not on the allowlist', async () => {
    const app = createHttpApp(createAppContext(['http://app.localhost:8081']) as any);

    const res = await request(app).get('/health').set('Origin', 'http://127.0.0.1:9999');

    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a page on another site at the door, whatever the allowlist says', async () => {
    const app = createHttpApp(createAppContext(['https://evil.com', '*.nullsquare.net']) as any);

    for (const origin of ['https://evil.com', 'https://app.nullsquare.net']) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('HOST_NOT_ALLOWED');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('blocks wildcard "*" when credentials are enabled', async () => {
    const app = createHttpApp(createAppContext(['*']) as any);

    const res = await request(app).get('/health').set('Origin', 'http://localhost:4000');

    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
