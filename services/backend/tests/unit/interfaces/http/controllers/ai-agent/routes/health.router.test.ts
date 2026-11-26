import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { healthRouter } from '@/interfaces/http/controllers/ai-agent/routes/health.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware/errors';
import { circuitBreakerRegistry, CircuitState } from '@/domains/agent-brain/application/services/CircuitBreaker';
import { deriveStatus } from '@/domains/agent-brain/domain/types';

const makeServices = (overrides: Partial<any> = {}) => ({
  policyResolver: {
    getDefaultPolicy: vi.fn().mockResolvedValue({ id: 'policy-1' }),
    ...overrides.policyResolver,
  },
  sessionStore: {
    listSessions: vi.fn(() => []),
    get: vi.fn(),
    count: vi.fn(() => 0),
    ...overrides.sessionStore,
  },
  ...overrides,
});

const makeApp = (services: any) => {
  const app = express();
  app.use(healthRouter(services));
  app.use(errorHandler);
  return app;
};

describe('ai-agent health router', () => {
  beforeEach(() => {
    circuitBreakerRegistry.shutdown();
  });

  afterEach(() => {
    circuitBreakerRegistry.shutdown();
  });

  it('reports basic health and default policy presence', async () => {
    const services = makeServices();
    const app = makeApp(services);

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sandboxPolicyDefault).toBe(true);
  });

  it('returns deep health as unhealthy when a circuit is open', async () => {
    const services = makeServices();
    const breaker = circuitBreakerRegistry.get('llm:test');
    breaker.forceState(CircuitState.OPEN);
    const app = makeApp(services);

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(503);
    expect(res.body.healthy).toBe(false);
    expect(res.body.circuits.open).toContain('llm:test');
  });

  it('summarizes session status counts and memory stats', async () => {
    const now = Date.now();
    const sessions = [
      { id: 's1', createdAt: now - 10_000, lastActive: now - 5_000, turn: 1, stateMachine: { isProcessing: () => false }, flags: {} },
      {
        id: 's2',
        createdAt: now - 20_000,
        lastActive: now - 1_000,
        turn: 2,
        stateMachine: { isProcessing: () => true },
        flags: {},
      },
      {
        id: 's3',
        createdAt: now - 30_000,
        lastActive: now - 2_000,
        turn: 3,
        stateMachine: { isProcessing: () => false },
        pendingApproval: { toolCallId: 't1' },
        flags: {},
      },
    ] as any[];

    const expectedByStatus = sessions.reduce<Record<string, number>>((acc, session) => {
      const status = deriveStatus(session);
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});

    const services = makeServices({
      sessionStore: {
        listSessions: vi.fn(() => sessions),
      },
    });
    const app = makeApp(services);

    const res = await request(app).get('/health/sessions');

    expect(res.status).toBe(200);
    expect(res.body.totalActive).toBe(sessions.length);
    expect(res.body.byStatus).toEqual(expectedByStatus);
    expect(res.body.memory.heapUsedMb).toBeGreaterThanOrEqual(0);
  });

  it('returns session health details when a session exists', async () => {
    const session = {
      id: 's-health',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 9,
      stateMachine: { isProcessing: () => false },
      containerId: 'container-1',
      flags: {},
    } as any;
    const services = makeServices({
      sessionStore: {
        get: vi.fn(() => session),
      },
    });
    const app = makeApp(services);

    const res = await request(app).get('/sessions/s-health/health');

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('s-health');
    expect(res.body.sandbox.connected).toBe(true);
    expect(res.body.status).toBe(deriveStatus(session));
  });

  it('returns 404 when the session does not exist', async () => {
    const services = makeServices({
      sessionStore: {
        get: vi.fn(() => undefined),
      },
    });
    const app = makeApp(services);

    const res = await request(app).get('/sessions/missing/health');

    expect(res.status).toBe(404);
  });
});
