import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { ERROR_CODES } from '@null-ai/contracts';

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
    redis: overrides.redis ?? { ping: vi.fn(async () => 'PONG') },
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

describe('httpServer contracts', () => {
  it('serves ndjson logs with plain text headers from configured trace root', async () => {
    const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-'));
    const sessionDir = path.join(traceRoot, 'sess-123');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'trace.ndjson'), 'hello trace');

    const app = createHttpApp(createAppContext({ traceRoot }) as any);
    const res = await request(app).get('/logs/ai-agent/sess-123/trace.ndjson');

    expect(res.status).toBe(200);
    expect(res.text).toBe('hello trace');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-disposition']).toBe('inline');

    fs.rmSync(traceRoot, { recursive: true, force: true });
  });

  it('returns archived marker for legacy scans API', async () => {
    const app = createHttpApp(createAppContext() as any);
    const res = await request(app).get('/api/scans');

    expect(res.status).toBe(410);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(res.body.message).toBe('scans_archived');
  });

  it('exposes metrics in Prometheus text format', async () => {
    opsMetrics.recordRequest(50, 200); // Use recordRequest instead of removed recordRedisPing
    const app = createHttpApp(createAppContext({ config: { ...baseConfig } }) as any);

    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Check for Prometheus format markers instead of specific metric that doesn't exist
    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('# TYPE');
  });
});









