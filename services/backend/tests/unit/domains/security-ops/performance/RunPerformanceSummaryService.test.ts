import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '@/db/client';
import type { TimelineEvent } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import { RunPerformanceSummaryService } from '@/domains/security-ops/performance/RunPerformanceSummaryService';
import type { PrometheusRangePoint, PrometheusRangeQueryClient } from '@/domains/security-ops/performance/PrometheusQueryClient';
import type { RunTraceResponse } from '@/domains/security-ops/runs/RunTraceService';

const fakeDb = (selectRows: Array<Array<Record<string, unknown>>> = [[]]): DatabaseClient => {
  let selectIndex = 0;
  return ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => selectRows[selectIndex++] ?? [],
      }),
    }),
  }),
  insert: () => ({
    values: () => ({
      onConflictDoUpdate: async () => undefined,
    }),
  }),
}) as unknown as DatabaseClient;
};

const event = (overrides: Partial<TimelineEvent> & { id: string; event: string; ts: string }): TimelineEvent => ({
  id: overrides.id,
  sessionId: overrides.sessionId ?? 'session-1',
  runId: overrides.runId ?? 'run-1',
  turn: overrides.turn ?? 1,
  ts: overrides.ts,
  event: overrides.event,
  severity: overrides.severity ?? 'info',
  payload: overrides.payload,
});

const traceResponse = (events: TimelineEvent[]): RunTraceResponse => ({
  runId: 'run-1',
  sessionIds: ['session-1'],
  generatedAt: '2026-06-22T10:00:00.000Z',
  events,
  total: events.length,
  stats: {
    events: events.length,
    sessions: 1,
    byEvent: {},
    bySeverity: {},
    toolCalls: events.filter((entry) => entry.event === 'tool.finish').length,
    modelCalls: events.filter((entry) => entry.event === 'model.call.finish').length,
    actions: 0,
    discoveries: 0,
    linkedArtifacts: 0,
    totalTokens: 42,
    failures: events.filter((entry) => entry.severity === 'error').length,
  },
  summary: {
    startedAt: events[0]?.ts ?? null,
    completedAt: events[events.length - 1]?.ts ?? null,
    durationMs: 60_000,
    eventTypes: [],
    roles: [],
  },
  pagination: { offset: 0, limit: events.length, hasMore: false },
  integrity: {
    status: 'complete',
    sessions: [],
  },
});

describe('RunPerformanceSummaryService', () => {
  it('creates a trace-only summary when Prometheus is not configured', async () => {
    const service = new RunPerformanceSummaryService({ database: fakeDb() });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: {
          containerId: 'abcdef1234567890',
          containerName: 'ns-agent-session-1',
          profile: 'default',
          limits: { cpuQuota: 2, memoryMb: 1024, pidsLimit: 256 },
        },
      }),
      event({ id: 'tool-1', event: 'tool.finish', ts: '2026-06-22T10:00:30.000Z' }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:01:00.000Z', payload: { containerId: 'abcdef1234567890' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'running' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('unavailable');
    expect(summary.metricUnavailableReason).toBe('prometheus_not_configured');
    expect(summary.containers).toHaveLength(1);
    expect(summary.containers[0]?.limits).toEqual(expect.objectContaining({ memoryMb: 1024, pidsLimit: 256 }));
    expect(summary.containers[0]?.durationMs).toBe(60_000);
    expect(summary.containers[0]?.warnings).toContain('sandbox_limits_configured_but_not_docker_enforced');
    expect(summary.missingSources).toEqual(expect.arrayContaining(['prometheus_not_configured', 'workspace_size_not_collected']));
    expect(summary.trace.toolCalls).toBe(1);
  });

  it('populates container metrics from docker-stats trace events without Prometheus', async () => {
    const service = new RunPerformanceSummaryService({ database: fakeDb() });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: { containerId: 'abcdef1234567890', containerName: 'ns-run-1', limits: { memoryMb: 2048, pidsLimit: 512 } },
      }),
      event({
        id: 'stats-1',
        event: 'sandbox.stats',
        ts: '2026-06-22T10:00:55.000Z',
        payload: {
          containerId: 'abcdef1234567890',
          sessionId: 'session-1',
          source: 'docker_stats',
          samples: 6,
          cpuCores: { samples: 6, avg: 0.4, max: 1.2, p95: 1.1, last: 0.3 },
          memoryBytes: { samples: 6, avg: 120_000_000, max: 256_000_000, p95: 240_000_000, last: 130_000_000 },
          pids: { samples: 6, avg: 8, max: 19, p95: 18, last: 7 },
          networkRxBytesPerSecond: { samples: 5, avg: 1000, max: 5000, p95: 4800, last: 900 },
          networkTxBytesPerSecond: { samples: 5, avg: 500, max: 2000, p95: 1900, last: 400 },
          networkRxBytesEstimatedTotal: 5_320_000,
          networkTxBytesEstimatedTotal: 1_440_000,
        },
      }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:01:00.000Z', payload: { containerId: 'abcdef1234567890' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'completed' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('available');
    expect(summary.source).toBe('docker_stats');
    expect(summary.containers[0]?.memoryBytes.max).toBe(256_000_000);
    expect(summary.containers[0]?.cpuCores.max).toBe(1.2);
    expect(summary.containers[0]?.pids.max).toBe(19);
    expect(summary.containers[0]?.networkRxBytesEstimatedTotal).toBe(5_320_000);
    expect(summary.capacity.peakMemoryBytes).toBe(256_000_000);
    expect(summary.totals.maxPids).toBe(19);
  });

  it('uses sandbox.attached events as container anchors for compliance performance summaries', async () => {
    const service = new RunPerformanceSummaryService({ database: fakeDb() });
    const events = [
      event({
        id: 'attached-1',
        event: 'sandbox.attached',
        ts: '2026-06-22T10:00:00.000Z',
        sessionId: 'compliance-session',
        payload: {
          containerId: 'attached1234567890',
          containerName: 'ns-run-run-1',
          containerScope: 'run',
          runId: 'run-1',
          limits: { memoryMb: 2048, pidsLimit: 512, enforced: true, source: 'docker' },
        },
      }),
      event({
        id: 'stats-1',
        event: 'sandbox.stats',
        ts: '2026-06-22T10:00:30.000Z',
        sessionId: 'compliance-session',
        payload: {
          containerId: 'attached1234567890',
          source: 'docker_stats',
          samples: 4,
          cpuCores: { samples: 4, avg: 0.5, max: 1.1, p95: 1.0, last: 0.4 },
          memoryBytes: { samples: 4, avg: 200_000_000, max: 300_000_000, p95: 280_000_000, last: 220_000_000 },
          pids: { samples: 4, avg: 10, max: 22, p95: 20, last: 12 },
        },
      }),
    ];
    const trace = {
      ...traceResponse(events),
      sessionIds: ['compliance-session'],
    };

    const summary = await service.getRunSummary({
      run: { id: 'run-1', executorSessionId: 'compliance-session', status: 'running' },
      trace,
    });

    expect(summary.containers).toHaveLength(1);
    expect(summary.containers[0]?.memoryBytes.max).toBe(300_000_000);
    expect(summary.warnings).not.toContain('no_sandbox_container_in_trace');
    expect(summary.missingSources).not.toContain('sandbox_container_trace_events');
    expect(summary.sessions[0]?.missingSources).not.toContain('no_sandbox_container_in_trace');
  });

  it('keeps run-scoped sandbox metrics visible for phase sessions attached after creation', async () => {
    const service = new RunPerformanceSummaryService({ database: fakeDb() });
    const events = [
      event({
        id: 'sandbox-created',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        sessionId: 'planner-session',
        runId: 'run-1',
        payload: {
          containerId: 'runscoped1234567890',
          containerName: 'ns-run-run-1',
          containerScope: 'run',
          runId: 'run-1',
          limits: { memoryMb: 4096, pidsLimit: 512, enforced: true, source: 'docker' },
        },
      }),
      event({
        id: 'sandbox-attached',
        event: 'sandbox.attached',
        ts: '2026-06-22T10:05:00.000Z',
        sessionId: 'compliance-session',
        runId: 'run-1',
        payload: {
          containerId: 'runscoped1234567890',
          containerName: 'ns-run-run-1',
          containerScope: 'run',
          runId: 'run-1',
        },
      }),
      event({
        id: 'stats-1',
        event: 'sandbox.stats',
        ts: '2026-06-22T10:05:30.000Z',
        sessionId: 'compliance-session',
        runId: 'run-1',
        payload: {
          containerId: 'runscoped1234567890',
          sessionId: 'compliance-session',
          source: 'docker_stats',
          samples: 3,
          cpuCores: { samples: 3, avg: 0.7, max: 1.4, p95: 1.3, last: 0.6 },
          memoryBytes: { samples: 3, avg: 512_000_000, max: 1_024_000_000, p95: 900_000_000, last: 600_000_000 },
          pids: { samples: 3, avg: 18, max: 30, p95: 29, last: 20 },
        },
      }),
    ];
    const trace = {
      ...traceResponse(events),
      sessionIds: ['planner-session', 'compliance-session'],
      stats: { ...traceResponse(events).stats, sessions: 2 },
    };

    const summary = await service.getRunSummary({
      run: { id: 'run-1', plannerSessionId: 'planner-session', executorSessionId: 'compliance-session', status: 'running' },
      trace,
    });

    const complianceSession = summary.sessions.find((session) => session.sessionId === 'compliance-session');
    expect(summary.source).toBe('mixed');
    expect(summary.containers[0]?.limits).toEqual(expect.objectContaining({ memoryMb: 4096, enforced: true }));
    expect(complianceSession?.containers).toHaveLength(1);
    expect(complianceSession?.metricStatus).not.toBe('unavailable');
    expect(['docker_stats', 'mixed']).toContain(complianceSession?.source);
    expect(complianceSession?.containers[0]?.memoryBytes.max).toBe(1_024_000_000);
    expect(complianceSession?.missingSources).not.toContain('no_sandbox_container_in_trace');
  });

  it('does not warn about configured-only limits when the trace reports Docker-enforced limits', async () => {
    const service = new RunPerformanceSummaryService({ database: fakeDb() });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: {
          containerId: 'dockerlimit123456',
          containerName: 'ns-agent-session-1',
          limits: { cpuQuota: 2, memoryMb: 1024, pidsLimit: 256, enforced: true, source: 'docker' },
        },
      }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:01:00.000Z', payload: { containerId: 'dockerlimit123456' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'running' },
      trace: traceResponse(events),
    });

    expect(summary.containers[0]?.limits).toEqual(expect.objectContaining({ enforced: true, source: 'docker' }));
    expect(summary.containers[0]?.warnings).not.toContain('sandbox_limits_configured_but_not_docker_enforced');
  });

  it('marks Prometheus data partial when only some metric families have samples', async () => {
    const prometheusClient: PrometheusRangeQueryClient = {
      queryRange: vi.fn(async ({ query }) => {
        if (!query.includes('container_cpu_usage_seconds_total')) return [];
        return [{
          metric: { id: '/docker/partial1234567890', name: 'ns-agent-session-1' },
          values: [[1, '0.25'], [2, '0.50']] as PrometheusRangePoint[],
        }];
      }),
    };
    const service = new RunPerformanceSummaryService({ database: fakeDb(), prometheusClient });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: { containerId: 'partial1234567890', containerName: 'ns-agent-session-1' },
      }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:01:00.000Z', payload: { containerId: 'partial1234567890' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'running' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('partial');
    expect(summary.metricUnavailableReason).toBe('some_container_metric_samples_missing');
    expect(summary.containers[0]?.metricCoverage).toEqual({
      cpu: true,
      memory: false,
      networkRx: false,
      networkTx: false,
      pids: false,
    });
    expect(summary.warnings).toEqual(expect.arrayContaining([
      'some_container_metric_samples_missing',
      'memory_metric_missing',
      'pids_metric_missing',
    ]));
    expect(summary.missingSources).toEqual(expect.arrayContaining([
      'memory_metrics',
      'network_metrics',
      'pid_or_thread_metrics',
    ]));
  });

  it('merges cAdvisor Prometheus samples onto traced containers', async () => {
    const prometheusClient: PrometheusRangeQueryClient = {
      queryRange: vi.fn(async ({ query }) => {
        const metric = {
          id: '/docker/abcdef1234567890',
          name: 'ns-agent-session-1',
          container_label_nullai_session_id: 'session-1',
        };
        if (query.includes('memory_working_set')) {
          return [{ metric, values: [[1, '1024'], [2, '2048']] as PrometheusRangePoint[] }];
        }
        if (query.includes('container_threads')) {
          return [{ metric, values: [[1, '5'], [2, '8']] as PrometheusRangePoint[] }];
        }
        return [{ metric, values: [[1, '0.25'], [2, '0.75']] as PrometheusRangePoint[] }];
      }),
    };
    const service = new RunPerformanceSummaryService({
      database: fakeDb(),
      prometheusClient,
      queryStepSeconds: 15,
    });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: {
          containerId: 'abcdef1234567890',
          containerName: 'ns-agent-session-1',
          limits: { cpuQuota: 1, memoryBytes: 2048, pidsLimit: 10 },
        },
      }),
      event({ id: 'tool-1', event: 'tool.finish', ts: '2026-06-22T10:01:00.000Z' }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:02:00.000Z', payload: { containerId: 'abcdef1234567890' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'running' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('available');
    expect(summary.source).toBe('prometheus');
    expect(summary.totals.avgCpuCores).toBeCloseTo(0.5);
    expect(summary.totals.maxMemoryBytes).toBe(2048);
    expect(summary.totals.maxPids).toBe(8);
    expect(summary.totals.networkRxBytesEstimatedTotal).toBe(60);
    expect(summary.capacity.memoryUtilizationRatio).toBeCloseTo(1);
    expect(summary.capacity.cpuQuotaUtilizationRatio).toBeCloseTo(0.75);
    expect(summary.warnings).toEqual(expect.arrayContaining([
      'memory_peak_above_85_percent_of_configured_policy',
      'sandbox_limits_configured_but_not_docker_enforced',
    ]));
    expect(summary.missingSources).toEqual(['workspace_size_not_collected']);
    expect(prometheusClient.queryRange).toHaveBeenCalledTimes(5);
  });

  it('recomputes an unavailable persisted summary when Prometheus is configured', async () => {
    const persistedUnavailable = {
      schemaVersion: 1,
      subject: 'run',
      runId: 'run-1',
      generatedAt: '2026-06-22T09:00:00.000Z',
      status: 'unavailable',
      source: 'trace_only',
      metricStatus: 'unavailable',
      metricUnavailableReason: 'prometheus_not_configured',
      window: { startedAt: null, endedAt: null, durationMs: null },
      trace: { events: 0, sessions: 1, toolCalls: 0, modelCalls: 0, failures: 0, totalTokens: 0 },
      containers: [],
      sessions: [],
      totals: { containerCount: 0, avgCpuCores: null, maxCpuCores: null, p95CpuCores: null, maxMemoryBytes: null, p95MemoryBytes: null, maxPids: null, networkRxBytesPerSecondAvg: null, networkTxBytesPerSecondAvg: null, networkRxBytesPerSecondMax: null, networkTxBytesPerSecondMax: null, networkRxBytesEstimatedTotal: null, networkTxBytesEstimatedTotal: null },
      capacity: { configuredMemoryBytes: null, peakMemoryBytes: null, memoryUtilizationRatio: null, configuredPidsLimit: null, peakPids: null, pidsUtilizationRatio: null, configuredCpuQuota: null, peakCpuCores: null, cpuQuotaUtilizationRatio: null },
      warnings: ['prometheus_not_configured'],
      missingSources: ['prometheus_not_configured'],
    };
    const prometheusClient: PrometheusRangeQueryClient = {
      queryRange: vi.fn(async () => [{
        metric: { id: '/docker/abcdef1234567890', name: 'ns-agent-session-1' },
        values: [[1, '1'], [2, '2']] as PrometheusRangePoint[],
      }]),
    };
    const service = new RunPerformanceSummaryService({
      database: fakeDb([[{ summary: persistedUnavailable }]]),
      prometheusClient,
    });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: { containerId: 'abcdef1234567890', containerName: 'ns-agent-session-1' },
      }),
      event({ id: 'tool-1', event: 'tool.finish', ts: '2026-06-22T10:01:00.000Z' }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'completed' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('available');
    expect(summary.containers).toHaveLength(1);
    expect(prometheusClient.queryRange).toHaveBeenCalled();
  });

  it('does not reuse an unavailable terminal cache when the fresh trace contains docker stats', async () => {
    const persistedUnavailable = {
      schemaVersion: 1,
      subject: 'run',
      runId: 'run-1',
      generatedAt: '2026-06-22T09:00:00.000Z',
      status: 'unavailable',
      source: 'trace_only',
      metricStatus: 'unavailable',
      metricUnavailableReason: 'no_sandbox_container_in_trace',
      window: { startedAt: null, endedAt: null, durationMs: null },
      trace: { events: 10, sessions: 1, toolCalls: 0, modelCalls: 0, failures: 0, totalTokens: 0 },
      containers: [],
      sessions: [],
      totals: { containerCount: 0, avgCpuCores: null, maxCpuCores: null, p95CpuCores: null, maxMemoryBytes: null, p95MemoryBytes: null, maxPids: null, networkRxBytesPerSecondAvg: null, networkTxBytesPerSecondAvg: null, networkRxBytesPerSecondMax: null, networkTxBytesPerSecondMax: null, networkRxBytesEstimatedTotal: null, networkTxBytesEstimatedTotal: null },
      capacity: { configuredMemoryBytes: null, peakMemoryBytes: null, memoryUtilizationRatio: null, configuredPidsLimit: null, peakPids: null, pidsUtilizationRatio: null, configuredCpuQuota: null, peakCpuCores: null, cpuQuotaUtilizationRatio: null },
      warnings: ['no_sandbox_container_in_trace'],
      missingSources: ['sandbox_container_trace_events'],
    };
    const service = new RunPerformanceSummaryService({
      database: fakeDb([[{ summary: persistedUnavailable }]]),
    });
    const events = [
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: { containerId: 'abcdef1234567890', containerName: 'ns-agent-session-1' },
      }),
      event({
        id: 'stats-1',
        event: 'sandbox.stats',
        ts: '2026-06-22T10:00:30.000Z',
        payload: {
          containerId: 'abcdef1234567890',
          source: 'docker_stats',
          samples: 2,
          cpuCores: { samples: 2, avg: 0.25, max: 0.5, p95: 0.5, last: 0.2 },
          memoryBytes: { samples: 2, avg: 100_000_000, max: 150_000_000, p95: 150_000_000, last: 90_000_000 },
          pids: { samples: 2, avg: 6, max: 8, p95: 8, last: 5 },
        },
      }),
      event({ id: 'destroy-1', event: 'sandbox.destroyed', ts: '2026-06-22T10:01:00.000Z', payload: { containerId: 'abcdef1234567890' } }),
    ];

    const summary = await service.getRunSummary({
      run: { id: 'run-1', sessionId: 'session-1', status: 'completed' },
      trace: traceResponse(events),
    });

    expect(summary.metricStatus).toBe('partial');
    expect(summary.source).toBe('mixed');
    expect(summary.trace.events).toBe(3);
    expect(summary.containers).toHaveLength(1);
    expect(summary.warnings).not.toContain('no_sandbox_container_in_trace');
    expect(summary.missingSources).not.toContain('sandbox_container_trace_events');
  });

  it('force-refreshes performance bundle entries from the supplied full trace', async () => {
    const persistedUnavailable = {
      schemaVersion: 1,
      subject: 'run',
      runId: 'run-1',
      generatedAt: '2026-06-22T09:00:00.000Z',
      status: 'unavailable',
      source: 'trace_only',
      metricStatus: 'unavailable',
      metricUnavailableReason: 'no_sandbox_container_in_trace',
      window: { startedAt: null, endedAt: null, durationMs: null },
      trace: { events: 1, sessions: 1, toolCalls: 0, modelCalls: 0, failures: 0, totalTokens: 0 },
      containers: [],
      sessions: [],
      totals: { containerCount: 0, avgCpuCores: null, maxCpuCores: null, p95CpuCores: null, maxMemoryBytes: null, p95MemoryBytes: null, maxPids: null, networkRxBytesPerSecondAvg: null, networkTxBytesPerSecondAvg: null, networkRxBytesPerSecondMax: null, networkTxBytesPerSecondMax: null, networkRxBytesEstimatedTotal: null, networkTxBytesEstimatedTotal: null },
      capacity: { configuredMemoryBytes: null, peakMemoryBytes: null, memoryUtilizationRatio: null, configuredPidsLimit: null, peakPids: null, pidsUtilizationRatio: null, configuredCpuQuota: null, peakCpuCores: null, cpuQuotaUtilizationRatio: null },
      warnings: ['no_sandbox_container_in_trace'],
      missingSources: ['sandbox_container_trace_events'],
    };
    const service = new RunPerformanceSummaryService({
      database: fakeDb([[{ summary: persistedUnavailable }]]),
    });
    const trace = traceResponse([
      event({
        id: 'sandbox-1',
        event: 'sandbox.created',
        ts: '2026-06-22T10:00:00.000Z',
        payload: { containerId: 'abcdef1234567890', containerName: 'ns-agent-session-1' },
      }),
      event({
        id: 'stats-1',
        event: 'sandbox.stats',
        ts: '2026-06-22T10:00:30.000Z',
        payload: {
          containerId: 'abcdef1234567890',
          source: 'docker_stats',
          samples: 2,
          cpuCores: { samples: 2, avg: 0.25, max: 0.5, p95: 0.5, last: 0.2 },
          memoryBytes: { samples: 2, avg: 100_000_000, max: 150_000_000, p95: 150_000_000, last: 90_000_000 },
          pids: { samples: 2, avg: 6, max: 8, p95: 8, last: 5 },
        },
      }),
    ]);

    const entries = await service.getRunBundleEntries(
      { id: 'run-1', sessionId: 'session-1', status: 'completed' },
      trace,
    );
    const runPerformanceEntry = entries.find((entry) => entry.path === 'performance/run-performance.json');
    const runPerformanceContent =
      typeof runPerformanceEntry?.content === 'string'
        ? runPerformanceEntry.content
        : (runPerformanceEntry?.content?.toString('utf8') ?? '{}');
    const runPerformance = JSON.parse(runPerformanceContent) as {
      metricStatus?: string;
      trace?: { events?: number };
      containers?: unknown[];
    };

    expect(runPerformance.metricStatus).toBe('partial');
    expect(runPerformance.trace?.events).toBe(2);
    expect(runPerformance.containers).toHaveLength(1);
  });
});
