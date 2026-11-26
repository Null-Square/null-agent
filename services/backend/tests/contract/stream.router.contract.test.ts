import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import * as http from 'http';
import request from 'supertest';
import { streamRouter } from '@/interfaces/http/controllers/ai-agent/routes/stream.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware';
import { ERROR_CODES } from '@null-ai/contracts';

const buildServices = () => {
  const events = {
    subscribe: vi.fn(() => () => {}),
  };
  const getSession = vi.fn();
  const sessionStore = {
    get: getSession,
    getOrHydrate: getSession,
    getExecutionReadModel: vi.fn(async () => ({
      desiredExecution: 'running',
      condition: 'idle',
    })),
  };
  const services: any = {
    ports: { events },
    sessionStore,
    agentEngine: {
      getSandboxPolicy: vi.fn(async () => null),
    },
  };
  return { services, events, sessionStore };
};

const buildApp = (services: any, injectedUserId?: string) => {
  const app = express();
  app.use(express.json());
  if (injectedUserId) {
    app.use((req, _res, next) => {
      (req as any).user = { id: injectedUserId };
      next();
    });
  }
  app.use(streamRouter(services));
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
};

describe('stream.router contract', () => {
  it('returns 404 when session is missing', async () => {
    const { services } = buildServices();
    services.sessionStore.get.mockReturnValue(undefined);
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/stream');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.SESSION_NOT_FOUND);
  });

  it('emits SSE headers and subscribes when session exists', async () => {
    const { services, events, sessionStore } = buildServices();
    sessionStore.get.mockReturnValue({ id: 's1', ownerId: 'u1', status: 'running', pendingApproval: undefined });
    const app = buildApp(services);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (value: { status?: number; headers?: any }) => {
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
        const snapshot = { status: raw.statusCode, headers: raw.headers };
        raw.on('error', (err: any) => {
          if (err?.code === 'ECONNRESET') {
            settle(snapshot);
          } else {
            settleErr(err);
          }
        });
        raw.on('end', () => settle(snapshot));
        raw.on('close', () => settle(snapshot));
        // Close the SSE stream after headers arrive to avoid hanging the test
        setTimeout(() => raw.destroy(), 20);
      });
      req.end((err, response) => {
        if (err && (err as any).code !== 'ECONNRESET') {
          return settleErr(err);
        }
        if (response) {
          return settle({ status: response.status, headers: response.headers });
        }
      });
      setTimeout(() => settle({ status: undefined, headers: undefined }), 1000);
    });

    expect(events.subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
  }, 2000);

  it('returns 403 when authenticated user does not own the session', async () => {
    const { services, sessionStore } = buildServices();
    sessionStore.get.mockReturnValue({ id: 's1', userId: 'owner-1', status: 'running' });
    const app = buildApp(services, 'other-user');

    const res = await request(app).get('/sessions/s1/stream');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('emits sandbox_policy event when cached policy exists', async () => {
    const { services, sessionStore } = buildServices();
    sessionStore.get.mockReturnValue({ id: 's1', userId: 'u1', status: 'running', pendingApproval: undefined });
    services.agentEngine.getSandboxPolicy.mockResolvedValue({ profile: 'default', image: 'sandbox:latest' });
    const app = buildApp(services, 'u1');
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const payload = await new Promise<string>((resolve, reject) => {
        let body = '';
        const req = http.get(`http://127.0.0.1:${port}/sessions/s1/stream`, (res) => {
          res.on('data', (chunk) => {
            body += chunk.toString();
            if (body.includes('event: sandbox_policy') && body.includes('"profile":"default"')) {
              res.destroy();
              resolve(body);
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        setTimeout(() => resolve(body), 1500);
      });

      expect(payload).toContain('event: sandbox_policy');
      expect(payload).toContain('"profile":"default"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 2000);

  it('bootstrap snapshot reports lastTurnInputTokens from usage history instead of cumulative prompt totals', async () => {
    const { services, sessionStore } = buildServices();
    sessionStore.get.mockReturnValue({
      id: 's1',
      userId: 'u1',
      status: 'running',
      pendingApproval: undefined,
      modelContextWindow: 1000,
      usage: {
        promptTokens: 900,
        completionTokens: 100,
        totalTokens: 1000,
      },
      flags: {
        token_usage_history: {
          entries: [
            {
              promptTokens: 120,
              completionTokens: 20,
              totalTokens: 140,
            },
          ],
        },
      },
    });
    const app = buildApp(services, 'u1');
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const payload = await new Promise<string>((resolve, reject) => {
        let body = '';
        const req = http.get(`http://127.0.0.1:${port}/sessions/s1/stream`, (res) => {
          res.on('data', (chunk) => {
            body += chunk.toString();
            if (body.includes('event: session.bootstrap') && body.includes('"lastTurnInputTokens":120')) {
              res.destroy();
              resolve(body);
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        setTimeout(() => resolve(body), 1500);
      });

      const match = payload.match(/data: (\{.*"lastTurnInputTokens":120.*\})/);
      expect(match).toBeTruthy();
      const bootstrap = JSON.parse(match![1]);
      expect(bootstrap.usage.lastTurnInputTokens).toBe(120);
      expect(bootstrap.usage.contextRemaining).toBe(880);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 2000);
});







