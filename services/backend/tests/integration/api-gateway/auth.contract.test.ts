import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';
import { ERROR_CODES, getErrorMetadata } from '@null-ai/contracts';
import { OWNER_KEY_REQUIRED_MESSAGE } from '@/shared/middleware/auth.middleware';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

function okRouter() {
  const router = express.Router();
  router.get('/ping', (_req, res) => res.json({ ok: true }));
  return router;
}

// Use vi.hoisted() for mocks that need to be accessed in tests
const mocks = vi.hoisted(() => ({
  resolvePrimaryOrganizationMembership: vi.fn(),
}));

vi.mock('@/shared/auth/localOwner', () => ({
  localOwner: async () => ({ id: 'owner-1', email: 'owner@null-ai.local', role: 'user' }),
}));

vi.mock('@/shared/auth/resolveOrgMembership', () => ({
  resolvePrimaryOrganizationMembership: (...args: unknown[]) =>
    mocks.resolvePrimaryOrganizationMembership(...args),
}));

vi.mock('@/interfaces/http/controllers/ai-agent/AgentRouter', () => ({
  createAgentRouter: vi.fn(() => okRouter()),
}));
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

const createAppContext = () => ({
  config: baseConfig as any,
  isDev: true,
  sandbox: { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) },
  streamBroker: {},
  sessionStore: { listSessions: vi.fn(() => []) },
  agentServices: { artifactService: {} },
  usageStore: {},
  workspaceManager: { getMetrics: vi.fn(() => ({})) },
});

describe('API gateway auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrimaryOrganizationMembership.mockResolvedValue({ organizationId: 'org-1', role: 'owner' });
  });

  it('refuses agent routes to a request without the owner key', async () => {
    const app = createHttpApp(createAppContext() as any);

    const res = await request(app).get('/api/ai-agent/ping');

    const metadata = getErrorMetadata(ERROR_CODES.AUTH_INVALID_SESSION);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({
      code: ERROR_CODES.AUTH_INVALID_SESSION,
      message: OWNER_KEY_REQUIRED_MESSAGE,
      httpStatus: metadata.httpStatus,
      userMessage: OWNER_KEY_REQUIRED_MESSAGE,
      retryable: metadata.retryable,
    }));
    expect(mocks.resolvePrimaryOrganizationMembership).not.toHaveBeenCalled();
  });

  it('refuses agent routes to a bearer token that is not the owner key', async () => {
    const app = createHttpApp(createAppContext() as any);

    const res = await request(app).get('/api/ai-agent/ping').set('Authorization', `Bearer ${'x'.repeat(43)}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INVALID_SESSION);
  });

  it('lets the owner key as a bearer token into agent routes, acting for the owner\'s organization', async () => {
    const app = createHttpApp(createAppContext() as any);
    const key = app.locals.ownerKey as string;

    const res = await request(app).get('/api/ai-agent/ping').set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(mocks.resolvePrimaryOrganizationMembership).toHaveBeenCalledWith('owner-1');
  });
});
