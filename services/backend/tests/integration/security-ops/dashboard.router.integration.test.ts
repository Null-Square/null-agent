import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  select: vi.fn(),
}));

const orgServiceMocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: dbMocks,
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: vi.fn(() => orgServiceMocks),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

import { createDashboardRouter } from '@/interfaces/http/controllers/dashboard.router';

type QueryRows = Array<Record<string, unknown>>;

const fixedNow = new Date('2026-04-03T12:00:00.000Z');

const createSelectBuilder = (rows: QueryRows) => {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    groupBy: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (value: QueryRows) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };

  return builder;
};

const mockSelectSequence = (selectResults: QueryRows[]) => {
  dbMocks.select.mockImplementation(() => createSelectBuilder(selectResults.shift() ?? []));
};

describe('dashboard.router integration', () => {
  const scopeId = '123e4567-e89b-42d3-a456-426614174000';

  const buildApp = (deps: Parameters<typeof createDashboardRouter>[0] = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/dashboard', createDashboardRouter(deps));
    return app;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    vi.clearAllMocks();
    orgServiceMocks.getForUser.mockResolvedValue({ id: 'org-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes false-positive findings from summary counts', async () => {
    mockSelectSequence([
      [
        { severity: 'high', state: 'confirmed', count: 2 },
        { severity: 'critical', state: 'dismissed', count: 5 },
      ],
      [{ count: 3 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ nextRunAt: null }],
      [],
      [],
      [],
      [{ count: 2 }],
      [{ count: 1 }],
      [{ count: 0 }],
    ]);

    const response = await request(buildApp()).get('/api/app/dashboard/summary').query({ scopeId });

    expect(response.status).toBe(200);
    expect(response.body.highCount).toBe(2);
    expect(response.body.criticalCount).toBe(0);
    expect(response.body.openCount).toBe(2);
    expect(response.body.validatedCount).toBe(2);
  });

  it('returns an academic security posture grade for the summary hero', async () => {
    mockSelectSequence([
      [{ severity: 'medium', state: 'resolved', count: 1 }],
      [{ count: 3 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ nextRunAt: new Date('2026-04-04T08:00:00.000Z') }],
      [],
      [{ date: '2026-04-02', fromState: 'confirmed', toState: 'resolved', count: 2 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 4 }],
    ]);

    const response = await request(buildApp()).get('/api/app/dashboard/summary').query({ scopeId });

    expect(response.status).toBe(200);
    expect(response.body.securityPosture).toEqual({
      grade: 'A+',
      numericScore: 97,
      confidence: 'high',
      methodology: 'academic_plus_minus',
      trend: 'improving',
      validationCoverage: null,
      remediationVelocity: null,
      runsInWindow: 4,
      rationale: [
        'No unresolved critical or high findings are depressing the current posture.',
        'Recent testing and validation coverage support a strong grade.',
      ],
      openFindings: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    });
  });

  it('uses reopened findings when deriving the summary posture trajectory', async () => {
    mockSelectSequence([
      [{ severity: 'high', state: 'confirmed', count: 1 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ nextRunAt: null }],
      [],
      [{ date: '2026-04-02', fromState: 'resolved', toState: 'confirmed', count: 1 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
    ]);

    const response = await request(buildApp()).get('/api/app/dashboard/summary').query({ scopeId });

    expect(response.status).toBe(200);
    expect(response.body.securityPosture.trend).toBe('regressing');
  });

  it('returns overview-v2 without the retired technique projection', async () => {
    const runActivityService = {
      getSummaryForRun: vi.fn().mockResolvedValue({
        generatedAt: '2026-04-03T11:00:00.000Z',
        totals: {
          requests: 12,
          uniqueHosts: 2,
          uniqueEndpoints: 7,
          blockedActions: 1,
        },
      }),
    };

    mockSelectSequence([
      [
        { date: '2026-04-01', count: 2 },
        { date: '2026-04-03', count: 1 },
      ],
      [{ date: '2026-04-02', fromState: 'confirmed', toState: 'resolved', count: 1 }],
      [{ count: 4 }],
      [{ count: 1 }],
      [
        { severity: 'critical', state: 'confirmed', count: 1 },
        { severity: 'high', state: 'confirmed', count: 2 },
        { severity: 'medium', state: 'resolved', count: 1 },
      ],
      [{ activeCount: 4, validatedCount: 3 }],
      [
        {
          findingId: 'finding-1',
          findingCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
          resolvedAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
      [
        { date: '2026-04-01', count: 1 },
        { date: '2026-04-03', count: 2 },
      ],
      [{ count: 0 }],
      [
        {
          id: 'run-1',
          displayId: 1,
          title: 'Recent run',
          goal: 'Assess admin portal',
          status: 'completed',
          createdAt: new Date('2026-04-03T10:30:00.000Z'),
        },
      ],
      [
        { status: 'completed', count: 2 },
        { status: 'awaiting_user', count: 1 },
      ],
      [
        { trigger: 'manual', count: 2 },
        { trigger: 'automation', count: 1 },
      ],
      [{ nextRunAt: new Date('2026-04-04T08:00:00.000Z') }],
      [
        {
          assetId: 'asset-1',
          weightedRisk: 13,
          openCount: 3,
          criticalCount: 1,
          highCount: 2,
          lastSeenAt: new Date('2026-04-03T10:00:00.000Z'),
        },
      ],
      [{ owaspCategory: 'A05:2021-Security Misconfiguration', count: 2 }],
      [{ id: 'asset-1', value: 'api.example.com' }],
      [{ id: scopeId }],
      [{ total: 2, verified: 2 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 2 }],
      [{ status: 'online' }],
      [
        {
          id: 'run-1',
          scopeId,
          title: 'Recent run',
          goal: 'Assess admin portal',
          status: 'completed',
          trigger: 'manual',
          createdAt: new Date('2026-04-03T10:30:00.000Z'),
          completedAt: new Date('2026-04-03T11:00:00.000Z'),
          sessionId: 'session-1',
          plannerSessionId: 'planner-1',
          executorSessionId: 'executor-1',
        },
      ],
    ]);

    const response = await request(buildApp({ runActivityService }))
      .get('/api/app/dashboard/overview-v2')
      .query({ scopeId, days: 3 });

    expect(response.status).toBe(200);
    expect(response.body.window).toEqual({
      days: 3,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-03T12:00:00.000Z',
    });
    expect(response.body.cadence).toEqual({
      heatmap: [
        { date: '2026-04-01', count: 1 },
        { date: '2026-04-02', count: 0 },
        { date: '2026-04-03', count: 2 },
      ],
      statusMix: {
        completed: 2,
        paused: 1,
      },
      triggerMix: {
        manual: 2,
        automation: 1,
      },
      nextScheduledRun: '2026-04-04T08:00:00.000Z',
    });
    expect(response.body).not.toHaveProperty('techniques');
    expect(response.body.activeRuns).toBe(0);
    expect(response.body.recentRuns).toEqual([
      {
        id: 'run-1',
        displayId: 1,
        title: 'Recent run',
        goal: 'Assess admin portal',
        status: 'completed',
        createdAt: '2026-04-03T10:30:00.000Z',
      },
    ]);
    expect(response.body.securityPosture).toMatchObject({
      grade: 'F',
      openFindings: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
    });
    expect(response.body.readiness).toEqual({
      targetState: 'verified',
      runnerState: 'ready',
      accessMaterialsCount: 1,
      connectedRepoCount: 1,
      whiteboxEnabled: true,
      activeAutomations: 2,
    });
    expect(response.body).not.toHaveProperty('recommendations');
    expect(response.body.latestActivity).toEqual({
      runId: 'run-1',
      title: 'Recent run',
      createdAt: '2026-04-03T10:30:00.000Z',
      totals: {
        requests: 12,
        uniqueHosts: 2,
        uniqueEndpoints: 7,
        blockedActions: 1,
      },
    });
  });

  it('does not expose the retired technique-memory endpoint', async () => {
    vi.useRealTimers();
    const response = await request(buildApp()).get('/api/app/dashboard/technique-memory');

    expect(response.status).toBe(404);
    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it('returns scope readiness metrics for internal scopes', async () => {
    mockSelectSequence([
      [{ id: scopeId, executionNetwork: 'internal' }],
      [{ total: 4, verified: 3 }],
      [{ count: 2 }],
      [{ count: 1 }],
      [{ count: 3 }],
      [{ status: 'online' }, { status: 'busy' }, { status: 'offline' }],
    ]);

    const response = await request(buildApp()).get('/api/app/dashboard/readiness').query({ scopeId });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      scopeId,
      targetState: 'verified',
      targetCount: 4,
      verifiedTargetCount: 3,
      scopeExecutionNetwork: 'external',
      runnerState: 'ready',
      assignedRunnerCount: 3,
      onlineRunnerCount: 2,
      accessMaterialsCount: 1,
      connectedRepoCount: 2,
      whiteboxEnabled: true,
      activeAutomations: 3,
    });
  });

  it('returns latest run activity using the injected activity service', async () => {
    const runActivityService = {
      getSummaryForRun: vi.fn().mockResolvedValue({
        generatedAt: '2026-04-03T11:00:00.000Z',
        totals: {
          requests: 42,
          uniqueHosts: 3,
          uniqueEndpoints: 17,
          blockedActions: 2,
        },
      }),
    };

    mockSelectSequence([
      [
        {
          id: 'run-1',
          scopeId,
          title: 'April validation sweep',
          goal: 'Validate high-risk scope targets',
          status: 'completed',
          trigger: 'manual',
          createdAt: new Date('2026-04-03T09:00:00.000Z'),
          completedAt: new Date('2026-04-03T10:45:00.000Z'),
          sessionId: 'session-1',
          plannerSessionId: 'planner-1',
          executorSessionId: 'executor-1',
        },
      ],
    ]);

    const response = await request(buildApp({ runActivityService: runActivityService as never }))
      .get('/api/app/dashboard/latest-activity')
      .query({ scopeId });

    expect(response.status).toBe(200);
    expect(runActivityService.getSummaryForRun).toHaveBeenCalledWith({
      id: 'run-1',
      sessionId: 'session-1',
      plannerSessionId: 'planner-1',
      executorSessionId: 'executor-1',
    });
    expect(response.body.latestActivity).toEqual({
      runId: 'run-1',
      scopeId,
      title: 'April validation sweep',
      createdAt: '2026-04-03T09:00:00.000Z',
      completedAt: '2026-04-03T10:45:00.000Z',
      status: 'completed',
      trigger: 'manual',
      generatedAt: '2026-04-03T11:00:00.000Z',
      totals: {
        requests: 42,
        uniqueHosts: 3,
        uniqueEndpoints: 17,
        blockedActions: 2,
      },
    });
  });
});
