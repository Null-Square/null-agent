import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent, TimelineResponse } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import {
  RunActivityService,
  buildRunActivitySummaryFromEvents,
  type ProxyCaptureEvent,
  type RunPhaseSourceRow,
  type ValidationQueueRow,
} from '@/domains/security-ops/runs/RunActivityService';

function buildActionSummaryEvent({
  ts,
  action,
  outcome,
  statusCode,
  durationMs,
  tool = 'http_payload',
}: {
  ts: string;
  action: string;
  outcome: 'success' | 'failure' | 'blocked' | 'timeout' | 'error' | 'skipped';
  statusCode?: number;
  durationMs: number;
  tool?: string;
}): TimelineEvent {
  return {
    id: `${tool}-${ts}`,
    sessionId: 'session-1',
    turn: 1,
    ts,
    event: 'action.summary',
    severity: 'info',
    payload: {
      tool,
      toolCallId: `call-${ts}`,
      action,
      outcome,
      statusCode,
      durationMs,
    },
  };
}

function buildTimelineResponse(events: TimelineEvent[], hasMore = false, offset = 0, limit = 500): TimelineResponse {
  return {
    events,
    total: events.length,
    stats: {
      actionsCount: 0,
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      errorCount: 0,
      timeoutCount: 0,
      skippedCount: 0,
      discoveriesCount: 0,
      milestonesCount: 0,
      memoryUpdatesCount: 0,
    },
    pagination: {
      offset,
      limit,
      hasMore,
    },
  };
}

function buildDiscoveryEvent({
  id,
  event = 'discovery',
  ts = '2026-04-02T10:03:00.000Z',
  summary,
  key,
}: {
  id: string;
  event?: 'discovery' | 'finding';
  ts?: string;
  summary: string;
  key: string;
}): TimelineEvent {
  return {
    id,
    sessionId: 'session-1',
    turn: 1,
    ts,
    event,
    severity: 'info',
    payload: {
      key,
      summary,
      category: event === 'finding' ? 'vulnerability' : 'data',
      confidence: event === 'finding' ? 0.9 : 0.7,
    },
  };
}

describe('RunActivityService', () => {
  it('builds telemetry-first run activity analytics from HTTP action summaries', () => {
    const summary = buildRunActivitySummaryFromEvents([
      buildActionSummaryEvent({
        ts: '2026-04-02T10:00:00.000Z',
        action: 'GET https://api.example.com/api/users',
        outcome: 'success',
        statusCode: 200,
        durationMs: 85,
      }),
      buildActionSummaryEvent({
        ts: '2026-04-02T10:01:00.000Z',
        action: 'POST https://app.example.com/login',
        outcome: 'failure',
        statusCode: 401,
        durationMs: 640,
      }),
      buildActionSummaryEvent({
        ts: '2026-04-02T10:04:00.000Z',
        action: 'GET https://api.example.com/api/users?page=2',
        outcome: 'success',
        statusCode: 200,
        durationMs: 1_200,
      }),
      buildActionSummaryEvent({
        ts: '2026-04-02T10:05:00.000Z',
        action: 'GET https://static.example.com/assets/main.js',
        outcome: 'blocked',
        durationMs: 50,
      }),
      buildActionSummaryEvent({
        ts: '2026-04-02T10:05:30.000Z',
        action: 'cat README.md',
        outcome: 'success',
        durationMs: 12,
        tool: 'shell_run',
      }),
    ]);

    expect(summary.totals).toEqual({
      requests: 4,
      uniqueHosts: 3,
      uniqueEndpoints: 3,
      failures: 1,
      blockedActions: 1,
      averageDurationMs: 494,
    });
    expect(summary.distributions.statusCodes).toEqual([
      { key: '2xx', label: '2xx', count: 2, percentage: 50 },
      { key: '4xx', label: '4xx', count: 1, percentage: 25 },
      { key: 'unknown', label: 'Unknown', count: 1, percentage: 25 },
    ]);
    expect(summary.distributions.methods).toEqual([
      { key: 'GET', label: 'GET', count: 3, percentage: 75 },
      { key: 'POST', label: 'POST', count: 1, percentage: 25 },
    ]);
    expect(summary.distributions.responseTimes).toEqual([
      { key: 'lt_100ms', label: '<100ms', count: 2, percentage: 50 },
      { key: '1_3s', label: '1-3s', count: 1, percentage: 25 },
      { key: '500_1000ms', label: '500ms-1s', count: 1, percentage: 25 },
    ]);
    expect(summary.timeline.hosts).toEqual([
      'api.example.com',
      'app.example.com',
      'static.example.com',
    ]);
    expect(summary.timeline.buckets).toHaveLength(2);
    expect(summary.topEndpoints[0]).toMatchObject({
      id: 'api.example.com/api/users',
      host: 'api.example.com',
      path: '/api/users',
      requestCount: 2,
      failureCount: 0,
      methods: [{ method: 'GET', count: 2 }],
      statusBand: '2xx',
    });
    expect(summary.topEndpoints[1]).toMatchObject({
      host: 'app.example.com',
      path: '/login',
      failureCount: 1,
      statusBand: '4xx',
    });
    expect(summary.topEndpoints[2]).toMatchObject({
      host: 'static.example.com',
      path: '/assets/main.js',
      statusBand: 'none',
    });
    expect(summary.topHosts[0]).toMatchObject({
      host: 'api.example.com',
      requestCount: 2,
      failureCount: 0,
      firstSeenAt: '2026-04-02T10:00:00.000Z',
      lastSeenAt: '2026-04-02T10:04:00.000Z',
    });
    expect(summary.coverage.source).toBe('action.summary');
    expect(summary.coverage.limitations.length).toBeGreaterThan(0);
    expect(summary.securityHeaders).toEqual({
      totalEndpoints: 0,
      missingHeaders: [],
    });
    expect(summary.operatorActivity[0]).toMatchObject({
      action: 'GET https://api.example.com/api/users',
      rationale: expect.stringContaining('request and response evidence'),
      evidenceProduced: expect.stringContaining('HTTP 200'),
      nextStep: expect.stringContaining('Continue the current mission'),
      source: 'http_payload',
    });
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('builds operator-facing activity rows even when a run has no HTTP telemetry', () => {
    const summary = buildRunActivitySummaryFromEvents([
      {
        id: 'finding-1',
        sessionId: 'session-1',
        turn: 3,
        ts: '2026-04-02T10:10:00.000Z',
        event: 'finding',
        severity: 'info',
        payload: {
          key: 'finding-1',
          summary: 'Candidate SQL injection recorded',
        },
      },
    ]);

    expect(summary.totals.requests).toBe(0);
    expect(summary.operatorActivity).toEqual([
      expect.objectContaining({
        action: 'Candidate SQL injection recorded',
        rationale: expect.stringContaining('vulnerability signal'),
        evidenceProduced: 'finding-1',
        nextStep: expect.stringContaining('evidence floor'),
        source: 'finding',
      }),
    ]);
  });

  it('surfaces workbench action trace events in operator activity', () => {
    const summary = buildRunActivitySummaryFromEvents([
      {
        id: 'workbench-redirect-1',
        sessionId: 'session-1',
        turn: 2,
        ts: '2026-04-02T10:12:00.000Z',
        event: 'workbench.action',
        severity: 'info',
        payload: {
          action: 'redirect',
          result: 'offered',
          operatorId: 'operator-1',
          targetSessionId: 'session-active',
          selectedSessionId: 'session-stale',
          runId: 'run-1',
          phaseKey: 'validation',
        },
      },
    ]);

    expect(summary.operatorActivity).toEqual([
      expect.objectContaining({
        action: 'Workbench redirect',
        rationale: 'Record an operator workbench intervention or routing decision.',
        evidenceProduced: 'target session session-active',
        nextStep: 'Open the active phase session before dispatching more work.',
        outcome: 'neutral',
        source: 'workbench.action',
      }),
    ]);
  });

  it('merges proxy capture telemetry, dedupes matching action summaries, and prefers captured headers', () => {
    const summary = buildRunActivitySummaryFromEvents([
      buildActionSummaryEvent({
        ts: '2026-04-02T10:00:00.000Z',
        action: 'GET https://app.example.com/login',
        outcome: 'success',
        statusCode: 200,
        durationMs: 120,
      }),
    ], [
      {
        ts: '2026-04-02T10:00:00.100Z',
        tsMs: Date.parse('2026-04-02T10:00:00.100Z'),
        method: 'GET',
        host: 'app.example.com',
        path: '/login',
        statusCode: 200,
        contentType: 'text/html',
        durationMs: 96,
        outcome: 'success',
        rawHeaders: [
          'content-type: text/html; charset=utf-8',
          'strict-transport-security: max-age=31536000',
          "content-security-policy: default-src 'self'",
          'x-frame-options: DENY',
          'x-content-type-options: nosniff',
        ].join('\r\n'),
      },
    ]);

    expect(summary.totals.requests).toBe(1);
    expect(summary.coverage.source).toBe('action.summary+http_capture');
    expect(summary.distributions.contentTypes).toEqual([
      { key: 'HTML', label: 'HTML', count: 1, percentage: 100 },
    ]);
    expect(summary.securityHeaders.totalEndpoints).toBe(1);
    expect(summary.securityHeaders.missingHeaders).toEqual(
      expect.arrayContaining([
        { header: 'HSTS', missingCount: 0, percentage: 0 },
        { header: 'CSP', missingCount: 0, percentage: 0 },
        { header: 'X-Frame-Options', missingCount: 0, percentage: 0 },
        { header: 'X-Content-Type-Options', missingCount: 0, percentage: 0 },
      ]),
    );
  });

  it('audits captured security headers even when the endpoint was first seen without raw headers', () => {
    const summary = buildRunActivitySummaryFromEvents([
      buildActionSummaryEvent({
        ts: '2026-04-02T10:00:00.000Z',
        action: 'GET https://app.example.com/login',
        outcome: 'success',
        statusCode: 200,
        durationMs: 120,
      }),
    ], [
      {
        ts: '2026-04-02T10:00:01.000Z',
        tsMs: Date.parse('2026-04-02T10:00:01.000Z'),
        method: 'GET',
        host: 'app.example.com',
        path: '/login',
        statusCode: 200,
        contentType: 'text/html',
        durationMs: 96,
        outcome: 'success',
        rawHeaders: [
          'content-type: text/html; charset=utf-8',
          'strict-transport-security: max-age=31536000',
          'x-content-type-options: nosniff',
        ].join('\r\n'),
      },
    ]);

    expect(summary.securityHeaders.totalEndpoints).toBe(1);
    expect(summary.securityHeaders.missingHeaders).toEqual(
      expect.arrayContaining([
        { header: 'HSTS', missingCount: 0, percentage: 0 },
        { header: 'X-Content-Type-Options', missingCount: 0, percentage: 0 },
        { header: 'CSP', missingCount: 1, percentage: 100 },
        { header: 'X-Frame-Options', missingCount: 1, percentage: 100 },
      ]),
    );
  });

  it('reads paginated planner and executor summaries before aggregating a run', async () => {
    const timelineService = {
      getActionSummaries: vi.fn(async (sessionId: string, options?: { offset?: number; limit?: number }) => {
        if (sessionId === 'session-planner') {
          return buildTimelineResponse([
            buildActionSummaryEvent({
              ts: '2026-04-02T10:00:00.000Z',
              action: 'GET https://planner.example.com/plan',
              outcome: 'success',
              statusCode: 200,
              durationMs: 120,
            }),
          ], false, options?.offset ?? 0, options?.limit ?? 500);
        }

        if ((options?.offset ?? 0) === 0) {
          return buildTimelineResponse([
            buildActionSummaryEvent({
              ts: '2026-04-02T10:05:00.000Z',
              action: 'GET https://api.example.com/users',
              outcome: 'success',
              statusCode: 200,
              durationMs: 80,
            }),
          ], true, 0, options?.limit ?? 500);
        }

        return buildTimelineResponse([
          buildActionSummaryEvent({
            ts: '2026-04-02T10:06:00.000Z',
            action: 'POST https://api.example.com/users',
            outcome: 'failure',
            statusCode: 500,
            durationMs: 980,
          }),
        ], false, options?.offset ?? 500, options?.limit ?? 500);
      }),
    };
    const service = new RunActivityService({ timelineService });

    const summary = await service.getSummaryForRun({
      sessionId: 'session-executor',
      plannerSessionId: 'session-planner',
      executorSessionId: 'session-executor',
    });

    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.uniqueHosts).toBe(2);
    expect(summary.totals.failures).toBe(1);
    expect(summary.topEndpoints[0]).toMatchObject({
      host: 'api.example.com',
      path: '/users',
      requestCount: 2,
      failureCount: 1,
      statusBand: 'mixed',
    });
    expect(timelineService.getActionSummaries).toHaveBeenCalledWith(
      'session-planner',
      expect.objectContaining({ offset: 0, limit: 500 }),
    );
    expect(timelineService.getActionSummaries).toHaveBeenCalledWith(
      'session-executor',
      expect.objectContaining({ offset: 0, limit: 500 }),
    );
    expect(timelineService.getActionSummaries).toHaveBeenCalledWith(
      'session-executor',
      expect.objectContaining({ offset: 500, limit: 500 }),
    );
  });

  it('includes run-linked worker sessions when a session resolver is provided', async () => {
    const timelineService = {
      getActionSummaries: vi.fn(async (sessionId: string) => {
        if (sessionId === 'session-worker') {
          return buildTimelineResponse([
            buildActionSummaryEvent({
              ts: '2026-04-02T10:07:00.000Z',
              action: 'GET https://worker.example.com/artifact',
              outcome: 'success',
              statusCode: 200,
              durationMs: 110,
            }),
          ]);
        }

        return buildTimelineResponse([
          buildActionSummaryEvent({
            ts: '2026-04-02T10:05:00.000Z',
            action: 'GET https://api.example.com/users',
            outcome: 'success',
            statusCode: 200,
            durationMs: 80,
          }),
        ]);
      }),
    };
    const service = new RunActivityService({
      timelineService,
      sessionResolver: {
        listIdsByRunId: vi.fn(async () => ['session-executor', 'session-worker']),
      },
    });

    const summary = await service.getSummaryForRun({
      id: 'run-1',
      sessionId: 'session-executor',
      executorSessionId: 'session-executor',
    });

    expect(summary.totals.requests).toBe(2);
    expect(summary.totals.uniqueHosts).toBe(2);
    expect(timelineService.getActionSummaries).toHaveBeenCalledWith(
      'session-worker',
      expect.objectContaining({ offset: 0, limit: 500 }),
    );
  });

  it('projects durable run phases and validation queue progress without session telemetry', async () => {
    const phaseRows: RunPhaseSourceRow[] = [
      {
        id: 'phase-validation',
        phaseKey: 'validation',
        ordinal: 3,
        status: 'handoff_submitted',
        startedAt: new Date('2026-04-02T10:10:00.000Z'),
        completedAt: null,
      },
      {
        id: 'phase-recon',
        phaseKey: 'recon',
        ordinal: 1,
        status: 'completed',
        startedAt: new Date('2026-04-02T10:00:00.000Z'),
        completedAt: new Date('2026-04-02T10:05:00.000Z'),
      },
      {
        id: 'phase-internal',
        phaseKey: 'planner',
        ordinal: 0,
        status: 'completed',
        startedAt: new Date('2026-04-02T09:59:00.000Z'),
        completedAt: new Date('2026-04-02T10:00:00.000Z'),
      },
    ];
    const validationQueueRows: ValidationQueueRow[] = [
      { phaseId: 'phase-validation', status: 'validated' },
      { phaseId: 'phase-validation', status: 'pending' },
      { phaseId: 'phase-validation', status: 'false_positive' },
      { phaseId: null, status: 'validated' },
    ];
    const timelineService = {
      getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
    };
    const phaseSource = {
      listByRunId: vi.fn(async () => phaseRows),
    };
    const validationQueueSource = {
      listByRunId: vi.fn(async () => validationQueueRows),
    };
    const service = new RunActivityService({
      timelineService,
      phaseSource,
      validationQueueSource,
    });

    const summary = await service.getSummaryForRun({ id: 'run-1' });

    expect(summary.totals.requests).toBe(0);
    expect(timelineService.getActionSummaries).not.toHaveBeenCalled();
    expect(phaseSource.listByRunId).toHaveBeenCalledWith('run-1');
    expect(validationQueueSource.listByRunId).toHaveBeenCalledWith('run-1');
    expect(summary.phases).toEqual([
      expect.objectContaining({
        phase: 'recon',
        label: 'Recon',
        ordinal: 1,
        status: 'completed',
        startedAt: '2026-04-02T10:00:00.000Z',
        completedAt: '2026-04-02T10:05:00.000Z',
        durationMs: 300_000,
      }),
      expect.objectContaining({
        phase: 'validation',
        label: 'Validation',
        ordinal: 3,
        status: 'running',
        startedAt: '2026-04-02T10:10:00.000Z',
        completedAt: null,
        durationMs: null,
        validationProgress: { total: 3, completed: 2, pending: 1 },
      }),
    ]);
  });

  it('projects unfinished phases as failed for cancelled runs even when stored rows are stale', async () => {
    const phaseRows: RunPhaseSourceRow[] = [
      {
        id: 'phase-recon',
        phaseKey: 'recon',
        ordinal: 1,
        status: 'completed',
        startedAt: new Date('2026-04-02T10:00:00.000Z'),
        completedAt: new Date('2026-04-02T10:05:00.000Z'),
      },
      {
        id: 'phase-enumeration',
        phaseKey: 'enumeration',
        ordinal: 2,
        status: 'active',
        startedAt: new Date('2026-04-02T10:06:00.000Z'),
        completedAt: null,
      },
      {
        id: 'phase-validation',
        phaseKey: 'validation',
        ordinal: 3,
        status: 'pending',
        startedAt: null,
        completedAt: null,
      },
    ];
    const service = new RunActivityService({
      timelineService: {
        getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
      },
      phaseSource: {
        listByRunId: vi.fn(async () => phaseRows),
      },
    });

    const summary = await service.getSummaryForRun({ id: 'run-1', status: 'cancelled' });

    expect(summary.phases.map((phase) => ({ phase: phase.phase, status: phase.status }))).toEqual([
      { phase: 'recon', status: 'completed' },
      { phase: 'enumeration', status: 'failed' },
      { phase: 'validation', status: 'failed' },
    ]);
  });

  it('projects unfinished phases as completed for completed runs when stored rows are stale', async () => {
    const phaseRows: RunPhaseSourceRow[] = [
      {
        id: 'phase-validation',
        phaseKey: 'validation',
        ordinal: 3,
        status: 'handoff_submitted',
        startedAt: new Date('2026-04-02T10:10:00.000Z'),
        completedAt: null,
      },
      {
        id: 'phase-reporting',
        phaseKey: 'reporting',
        ordinal: 4,
        status: 'active',
        startedAt: new Date('2026-04-02T10:20:00.000Z'),
        completedAt: null,
      },
    ];
    const service = new RunActivityService({
      timelineService: {
        getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
      },
      phaseSource: {
        listByRunId: vi.fn(async () => phaseRows),
      },
    });

    const summary = await service.getSummaryForRun({ id: 'run-1', status: 'completed' });

    expect(summary.phases.map((phase) => ({ phase: phase.phase, status: phase.status }))).toEqual([
      { phase: 'validation', status: 'completed' },
      { phase: 'reporting', status: 'completed' },
    ]);
  });

  it('keeps the typed reason when controlled exploitation is skipped', async () => {
    const service = new RunActivityService({
      timelineService: {
        getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
      },
      phaseSource: {
        listByRunId: vi.fn(async () => [{
          id: 'phase-exploitation',
          phaseKey: 'exploitation',
          ordinal: 4,
          status: 'completed',
          startedAt: new Date('2026-07-25T10:00:00.000Z'),
          completedAt: new Date('2026-07-25T10:00:01.000Z'),
          lastError: 'controlled_exploitation_skipped:no_same_run_validated_finding',
        }]),
      },
    });

    const summary = await service.getSummaryForRun({ id: 'run-1', status: 'running' });

    expect(summary.phases).toEqual([
      expect.objectContaining({
        phase: 'exploitation',
        status: 'skipped',
        reason: 'no_same_run_validated_finding',
      }),
    ]);
  });

  it('uses full timeline reads when available so discoveries and findings are included', async () => {
    const timelineService = {
      getTimeline: vi.fn(async () => buildTimelineResponse([
        buildActionSummaryEvent({
          ts: '2026-04-02T10:00:00.000Z',
          action: 'GET https://api.example.com/users',
          outcome: 'success',
          statusCode: 200,
          durationMs: 80,
        }),
        buildDiscoveryEvent({
          id: 'discovery-1',
          key: 'asset-1',
          summary: 'Admin export endpoint discovered',
        }),
        buildDiscoveryEvent({
          id: 'finding-1',
          event: 'finding',
          key: 'finding-1',
          summary: 'Authorization bypass candidate recorded',
        }),
      ])),
      getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
    };
    const service = new RunActivityService({ timelineService });

    const summary = await service.getSummaryForRun({ sessionId: 'session-1' });

    expect(timelineService.getTimeline).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        offset: 0,
        limit: 500,
        types: ['action.summary', 'discovery', 'finding'],
      }),
    );
    expect(timelineService.getActionSummaries).not.toHaveBeenCalled();
    expect(summary.discoveries).toEqual([
      expect.objectContaining({ key: 'asset-1', summary: 'Admin export endpoint discovered' }),
      expect.objectContaining({ key: 'finding-1', summary: 'Authorization bypass candidate recorded' }),
    ]);
    expect(summary.operatorActivity.map((row) => row.source)).toEqual([
      'http_payload',
      'discovery',
      'finding',
    ]);
  });

  it('loads proxy capture events for all resolved sessions', async () => {
    const timelineService = {
      getActionSummaries: vi.fn(async () => buildTimelineResponse([])),
    };
    const proxyEvents: ProxyCaptureEvent[] = [
      {
        ts: '2026-04-02T10:08:00.000Z',
        method: 'GET',
        host: 'proxy.example.com',
        path: '/captured',
        statusCode: 200,
        contentType: 'application/json',
        durationMs: 44,
        rawResponseHeaders: [
          'content-type: application/json',
          'strict-transport-security: max-age=31536000',
        ].join('\r\n'),
      },
    ];
    const proxyCaptureSource = {
      listEventsForSessions: vi.fn(async () => proxyEvents),
    };
    const service = new RunActivityService({
      timelineService,
      sessionResolver: {
        listIdsByRunId: vi.fn(async () => ['session-worker']),
      },
      proxyCaptureSource,
    });

    const summary = await service.getSummaryForRun({
      id: 'run-1',
      plannerSessionId: 'session-planner',
      executorSessionId: 'session-executor',
    });

    expect(proxyCaptureSource.listEventsForSessions).toHaveBeenCalledWith([
      'session-planner',
      'session-executor',
      'session-worker',
    ]);
    expect(summary.totals.requests).toBe(1);
    expect(summary.coverage.source).toBe('action.summary+http_capture');
    expect(summary.topEndpoints[0]).toMatchObject({
      host: 'proxy.example.com',
      path: '/captured',
      requestCount: 1,
    });
  });
});
