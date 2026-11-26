import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';
import { OWNER_COOKIE, ownerSessionValue } from '@/shared/auth/ownerKey';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

vi.mock('@/shared/auth/localOwner', () => ({
  localOwner: vi.fn(async () => ({
    id: 'owner-1',
    email: 'owner@null-ai.local',
    role: 'user',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z',
  })),
}));
vi.mock('@/interfaces/http/controllers/ai-agent/AgentRouter', () => {
  const express = require('express');
  return { createAgentRouter: vi.fn(() => express.Router()) };
});
vi.mock('@/interfaces/http/controllers/profile', () => {
  const express = require('express');
  return { __esModule: true, default: express.Router(), createProfileRouter: () => express.Router() };
});
vi.mock('swagger-ui-express', () => ({
  default: { serve: [(_req: any, _res: any, next: () => void) => next()], setup: () => (_req: any, _res: any, next: () => void) => next() },
  serve: (_req: any, _res: any, next: () => void) => next(),
  setup: () => (_req: any, _res: any, next: () => void) => next(),
}));
vi.mock('@/shared/openapi', () => ({
  generateOpenAPIDocument: vi.fn(() => ({ openapi: '3.0.0', info: { title: 'test', version: '1.0.0' } })),
}));

const appContext = {
  config: {
    network: { corsAllowedOrigins: ['*.localhost', '127.0.0.1'] },
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
    runtime: { turnTimeoutMs: 1000, maxToolCallsPerTurn: 4, shellTimeoutMs: 1000, webTimeoutMs: 1000, webMaxBytes: 1024 },
    workspace: { rootDir: '/tmp/ws', objectStoreRoot: '/tmp/obj', maxBytesPerWorkspace: undefined },
    http: { logSlowMs: 750, logDebugSampleRate: 0, logQuietPaths: [], uploadsMaxBytes: 1024 },
  },
  isDev: true,
  sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
};

describe('the owner key at the HTTP boundary', () => {
  let app: express.Application;
  let key: string;

  beforeAll(() => {
    app = createHttpApp(appContext as any);
    key = app.locals.ownerKey as string;
  });

  it('refuses a request without the key, even one that says it is localhost', async () => {
    const res = await request(app).get('/api/auth/me').set('Host', 'localhost');
    expect(res.status).toBe(401);
    expect(res.body.userMessage).toBe('Open Null AI from the link it printed when it started.');
  });

  it('trades the key from the link for an HttpOnly cookie, and the cookie is the person', async () => {
    const claim = await request(app).post('/api/auth/claim').send({ key });
    expect(claim.status).toBe(204);
    const cookie = String(claim.headers['set-cookie']);
    expect(cookie).toContain(`${OWNER_COOKIE}=${ownerSessionValue(key)}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain(key);

    const me = await request(app).get('/api/auth/me').set('Cookie', `${OWNER_COOKIE}=${ownerSessionValue(key)}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner@null-ai.local');
  });

  it('refuses a wrong key at the claim and sets no cookie', async () => {
    const claim = await request(app).post('/api/auth/claim').send({ key: 'x'.repeat(43) });
    expect(claim.status).toBe(401);
    expect(claim.headers['set-cookie']).toBeUndefined();
  });

  it('keeps the agent trace logs and the metrics behind the key', async () => {
    expect((await request(app).get('/logs/ai-agent/anything.ndjson')).status).toBe(401);
    expect((await request(app).get('/metrics')).status).toBe(401);
  });

  it('leaves the health check open, for compose', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('answers a private runner on its own token route without the owner key', async () => {
    const res = await request(app).get('/api/app/runner-agent/connect');
    expect(res.status).toBe(426);
  });
});
