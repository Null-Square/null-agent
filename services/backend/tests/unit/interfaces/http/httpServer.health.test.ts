import { vi, describe, it, expect, beforeAll, afterAll, type Mock } from 'vitest';
import request from 'supertest';
import createHttpApp from '@/interfaces/http/httpServer';
import { createStubAppContext } from '../../helpers/testAppHarness.helper';

// Use vi.hoisted() for mocks that need proper behavior
const mocks = vi.hoisted(() => ({
  checkDbHealth: vi.fn(() => Promise.resolve({ ok: true, ms: 0 })),
}));

vi.mock('@/db/client', () => ({
  db: {},
  checkDbHealth: (...args: Parameters<typeof mocks.checkDbHealth>) => mocks.checkDbHealth(...args),
}));

// Mock maintenance middleware to avoid import issues

const createAppContextMock = (overrides: Partial<any> = {}) => {
  const sandboxManager = overrides.sandbox ?? { isHealthy: vi.fn(() => true), listSandboxes: vi.fn(async () => []) };
  return createStubAppContext({
    sandbox: sandboxManager,
    ...overrides,
  });
};

describe('httpServer health endpoints', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy?.mockRestore();
    errorSpy?.mockRestore();
    logSpy?.mockRestore();
  });

  it('returns 200 when sandbox is healthy', async () => {
    const appContext = createAppContextMock();
    const app = createHttpApp(appContext as any);
    const server = app.listen();
    try {
      const res = await request(server).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OK');
      expect(res.body.redis).toBe('removed');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns 503 on sandbox list failure (extended)', async () => {
    const appContext = createAppContextMock({
      sandbox: { listSandboxes: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const app = createHttpApp(appContext as any);
    const server = app.listen();
    try {
      const res = await request(server).get('/health/extended');
      expect(res.status).toBe(503);
      expect(res.body.sandboxes).toBe('error');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns 503 when sandbox is unhealthy even if list works', async () => {
    const sandbox = {
      isHealthy: vi.fn(() => false),
      listSandboxes: vi.fn(async () => []),
    };
    const appContext = createAppContextMock({ sandbox });
    const app = createHttpApp(appContext as any);
    const server = app.listen();
    try {
      const res = await request(server).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.sandboxes?.healthy).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
