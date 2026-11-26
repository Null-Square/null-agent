import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// A plain function, not vi.fn(): the config's restoreMocks would reset a mocked return value.
vi.mock('@/shared/auth/resolveOrgMembership', () => ({
  resolvePrimaryOrganizationMembership: async () => ({ organizationId: 'org-1', role: 'owner' }),
}));

// Reuse lightweight ok routers for admin mounts
function okRouter() {
  const express = require('express');
  const router = express.Router();
  router.get('/', (_req: any, res: any) => res.json({ ok: true }));
  return router;
}

// Mock maintenance middleware to avoid import issues

vi.mock('@/interfaces/http/controllers/ai-agent/routes', async () => {
  const sessionsModule = await vi.importActual<any>('@/interfaces/http/controllers/ai-agent/routes/sessions.router');
  const streamModule = await vi.importActual<any>('@/interfaces/http/controllers/ai-agent/routes/stream.router');
  const approvalsModule = await vi.importActual<any>('@/interfaces/http/controllers/ai-agent/routes/approvals.router');
  return {
    sessionsRouter: sessionsModule.sessionsRouter,
    streamRouter: streamModule.streamRouter,
    approvalsRouter: approvalsModule.approvalsRouter,
    catalogRouter: () => okRouter(),
    healthRouter: () => okRouter(),
  };
});
vi.mock('@/interfaces/http/controllers/auth', () => ({
  __esModule: true,
  default: okRouter(),
  createAuthRouter: () => okRouter(),
}));
vi.mock('@/interfaces/http/controllers/profile', () => ({
  __esModule: true,
  default: okRouter(),
  createProfileRouter: () => okRouter(),
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

// Shortcut auth middleware so we can focus on route wiring
vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => {
    req.user = { id: 'user-1' };
    req.auth = { userId: 'user-1' };
    req.organizationId = 'org-1';
    req.orgRole = 'owner';
    next();
  },
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

const buildApp = () => {
  const session: any = {
    id: 's1',
    userId: 'user-1',
    status: 'running',
    turn: 1,
    pendingApproval: {
      actionId: 'a1',
      toolCallId: 'a1',
      tool: 'write_file',
      args: { path: '/tmp/a', content: 'hi' },
    },
    currentTurn: {
      controller: { signal: { aborted: false }, abort: vi.fn() },
    },
  };

  let subscriber: ((evt: any) => void) | undefined;

  const ports = {
    events: {
      emit: vi.fn(),
      subscribe: vi.fn((_sessionId: string, cb: (evt: any) => void) => {
        subscriber = cb;
        // Emit a status event immediately to drive SSE payload
        setTimeout(() => cb({ type: 'session.status', data: { status: 'running' } }), 0);
        return () => { /* noop unsubscribe */ };
      }),
    },
    tools: {
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: false }),
    },
  };

  const getSession = vi.fn((id: string) => (id === session.id ? session : undefined));
  const sessionStore = {
    get: getSession,
    getOrHydrate: getSession,
    getExecutionReadModel: vi.fn(async () => ({
      desiredExecution: 'running',
      condition: 'executing',
    })),
    listSessions: vi.fn(() => [session]),
    set: vi.fn(),
  };

  const agentServices = {
    sessionStore,
    ports,
    orchestrator: {
      processMessage: vi.fn().mockResolvedValue(undefined),
      handleApprovalResume: vi.fn().mockResolvedValue(undefined),
    },
    agentEngine: {
      getSandboxPolicy: vi.fn().mockResolvedValue({ profile: 'default', capabilities: [] }),
      stopSandbox: vi.fn().mockResolvedValue(undefined),
    },
    sessionStateMachine: {
      transition: vi.fn().mockResolvedValue({ success: true, status: 'terminate_requested', version: 2 }),
    },
    artifactService: {
      getStorageRoot: vi.fn(() => baseConfig.workspace.objectStoreRoot),
    },
    traceRecorder: { write: vi.fn().mockResolvedValue(undefined) },
  };

  const appContext = {
    config: baseConfig as any,
    isDev: true,
    sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
    streamBroker: {},
    sessionStore,
    agentServices,
    usageStore: {},
    workspaceManager: { getMetrics: vi.fn(() => ({})) },
  };

  return { app: createHttpApp(appContext as any), session, sessionStore, ports, agentServices, getSubscriber: () => subscriber };
};

const collectSsePayload = (
  port: number,
  path: string,
  headers: Record<string, string>,
  closeAfterMs = 25,
  maxWaitMs = 500,
) =>
  new Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    let resolved = false;
    let response: http.IncomingMessage | undefined;
    const chunks: Buffer[] = [];

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      resolve({
        status: response?.statusCode,
        headers: response?.headers ?? {},
        body: Buffer.concat(chunks).toString(),
      });
    };

    const req = http.get({ port, path, headers }, (res) => {
      response = res;
      res.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
        setTimeout(() => res.destroy(), closeAfterMs);
      });
      res.on('close', () => {
        clearTimeout(watchdog);
        finalize();
      });
    });
    req.on('error', (err) => {
      clearTimeout(watchdog);
      if (!resolved) {
        reject(err);
      }
    });

    const watchdog = setTimeout(() => {
      if (response) {
        response.destroy();
      } else {
        req.destroy();
      }
      finalize();
    }, maxWaitMs);
  });

describe('API gateway ai-agent wiring (SSE, approvals, abort)', () => {
  it('exposes SSE stream with sandbox policy/event payloads', async () => {
    const { app, getSubscriber } = buildApp();

    // Fire a manual SSE event in case sandbox policy resolve is slow
    setTimeout(() => {
      const sub = getSubscriber();
      if (sub) sub({ type: 'session.status', data: { status: 'running' } });
    }, 5);

    const server = app.listen();
    const port = (server.address() as any).port;

    const payload = await collectSsePayload(
      port,
      '/api/ai-agent/sessions/s1/stream',
      { Authorization: 'Bearer token' },
      10,
      800,
    ).finally(() => {
      server.close();
    });

    expect(payload.status).toBe(200);
    expect(payload.headers['content-type']).toContain('text/event-stream');
    // Stream should at least emit sandbox policy bootstrap event
    expect(payload.body).toContain('event: sandbox_policy');
  });

  it('includes core SSE event shapes (usage.recorded and tool events)', async () => {
    const { app, getSubscriber } = buildApp();
    const server = app.listen();
    const port = (server.address() as any).port;

    const emitCoreEvents = (attempt = 0) => {
      const sub = getSubscriber();
      if (sub) {
        sub({ type: 'usage.recorded', data: { promptTokens: 1, completionTokens: 2 } });
        sub({ type: 'tool.started', data: { toolCallId: 'tc-1', tool: 'test' } });
        return;
      }
      if (attempt < 20) {
        setTimeout(() => emitCoreEvents(attempt + 1), 5);
      }
    };
    emitCoreEvents();

    const payload = await collectSsePayload(
      port,
      '/api/ai-agent/sessions/s1/stream',
      { Authorization: 'Bearer token' },
      120,
      1000,
    ).finally(() => {
      server.close();
    });

    expect(payload.body).toContain('event: usage.recorded');
    expect(payload.body).toContain('event: tool.started');
  });

  it('does not mount legacy approval routes on the main ai-agent gateway', async () => {
    const { app, ports } = buildApp();

    const list = await request(app)
      .get('/api/ai-agent/sessions/s1/approvals')
      .set('Authorization', 'Bearer token');

    expect(list.status).toBe(404);

    const approve = await request(app)
      .post('/api/ai-agent/sessions/s1/approve')
      .set('Authorization', 'Bearer token')
      .send({ actionId: 'a1' });

    expect(approve.status).toBe(404);

    const deny = await request(app)
      .post('/api/ai-agent/sessions/s1/deny')
      .set('Authorization', 'Bearer token')
      .send({ actionId: 'a1', reason: 'nope' });

    expect(deny.status).toBe(404);
    expect(ports.tools.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it('returns 404 for legacy approval routes even with Idempotency-Key', async () => {
    const { app, ports } = buildApp();

    const headers = { Authorization: 'Bearer token', 'Idempotency-Key': 'deny-key' };
    const first = await request(app)
      .post('/api/ai-agent/sessions/s1/deny')
      .set(headers)
      .send({ actionId: 'a1', reason: 'nope' });
    expect(first.status).toBe(404);

    const second = await request(app)
      .post('/api/ai-agent/sessions/s1/deny')
      .set(headers)
      .send({ actionId: 'a1', reason: 'nope' });
    expect(second.status).toBe(404);

    expect(ports.tools.handleApprovalDecision).not.toHaveBeenCalled();
  });

});









