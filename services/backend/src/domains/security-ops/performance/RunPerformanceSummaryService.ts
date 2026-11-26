import { eq } from 'drizzle-orm';

import { db as defaultDb, type DatabaseClient } from '@/db/client';
import { runPerformanceSummaries, sessionPerformanceSummaries } from '@/db/schema';
import type { TimelineEvent } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import type { RunTraceBundleEntry, RunTraceResponse, RunTraceRunRef } from '@/domains/security-ops/runs/RunTraceService';
import { logger } from '@/shared/logger';

import type { PrometheusRangeQueryClient, PrometheusRangeSeries } from './PrometheusQueryClient';
import type {
  ContainerPerformanceSummary,
  ContainerMetricCoverage,
  MetricAvailability,
  NumericStats,
  PerformanceCapacitySignals,
  PerformanceResourceTotals,
  PerformanceSummarySource,
  PerformanceSummaryStatus,
  PerformanceTraceStats,
  PerformanceWindow,
  RunPerformanceSummary,
  SandboxLimitSnapshot,
  SessionPerformanceSummary,
} from './types';

export type RunPerformanceSummaryServiceDeps = {
  database?: DatabaseClient;
  prometheusClient?: PrometheusRangeQueryClient;
  enabled?: boolean;
  maxRangeHours?: number;
  queryStepSeconds?: number;
};

type PrometheusMetricKey = 'cpuCores' | 'memoryBytes' | 'networkRxBytesPerSecond' | 'networkTxBytesPerSecond' | 'pids';

type MetricLoadResult = {
  status: MetricAvailability;
  reason?: string | null;
  source: PerformanceSummarySource;
};

const EMPTY_STATS: NumericStats = Object.freeze({
  samples: 0,
  avg: null,
  max: null,
  p95: null,
  last: null,
});

const EMPTY_COVERAGE: ContainerMetricCoverage = Object.freeze({
  cpu: false,
  memory: false,
  networkRx: false,
  networkTx: false,
  pids: false,
});

const EMPTY_CAPACITY: PerformanceCapacitySignals = Object.freeze({
  configuredMemoryBytes: null,
  peakMemoryBytes: null,
  memoryUtilizationRatio: null,
  configuredPidsLimit: null,
  peakPids: null,
  pidsUtilizationRatio: null,
  configuredCpuQuota: null,
  peakCpuCores: null,
  cpuQuotaUtilizationRatio: null,
});

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DOUBLE_QUOTE = String.fromCharCode(34);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
};

const asLimitSource = (value: unknown): SandboxLimitSnapshot['source'] => {
  if (value === 'docker' || value === 'config') return value;
  return null;
};

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
};

const dateFromIso = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

const cloneEmptyStats = (): NumericStats => ({ ...EMPTY_STATS });
const cloneEmptyCoverage = (): ContainerMetricCoverage => ({ ...EMPTY_COVERAGE });
const cloneEmptyCapacity = (): PerformanceCapacitySignals => ({ ...EMPTY_CAPACITY });

const safeRatio = (value: number | null | undefined, limit: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  return value / limit;
};

const durationBetween = (startedAt: string | null | undefined, endedAt: string | null | undefined): number | null => {
  if (!startedAt || !endedAt) return null;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
};

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
};

const computeStats = (values: number[]): NumericStats => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return cloneEmptyStats();
  const sum = finite.reduce((total, value) => total + value, 0);
  return {
    samples: finite.length,
    avg: sum / finite.length,
    max: Math.max(...finite),
    p95: percentile(finite, 95),
    last: finite[finite.length - 1] ?? null,
  };
};

const normalizeStat = (value: NumericStats | undefined): NumericStats => value ?? cloneEmptyStats();

/** Coerce a NumericStats-shaped value from a trace payload (sandbox.stats event). */
const coerceNumericStats = (value: unknown): NumericStats => {
  const record = asRecord(value);
  if (!record) return cloneEmptyStats();
  return {
    samples: asNumber(record.samples) ?? 0,
    avg: asNumber(record.avg),
    max: asNumber(record.max),
    p95: asNumber(record.p95),
    last: asNumber(record.last),
  };
};

const sumNullable = (values: Array<number | null | undefined>): number | null => {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((total, value) => total + value, 0) : null;
};

const maxNullable = (values: Array<number | null | undefined>): number | null => {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : null;
};

const escapePrometheusRegex = (value: string): string =>
  value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

const escapePrometheusString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(new RegExp(DOUBLE_QUOTE, 'g'), '\\' + DOUBLE_QUOTE);

const sourceForMetricStatus = (status: MetricAvailability): PerformanceSummarySource => {
  if (status === 'available') return 'prometheus';
  if (status === 'partial') return 'mixed';
  return 'trace_only';
};

const statusForMetricStatus = (status: MetricAvailability): PerformanceSummaryStatus => {
  if (status === 'available') return 'ready';
  if (status === 'partial') return 'partial';
  return 'unavailable';
};

export class RunPerformanceSummaryService {
  private readonly db: DatabaseClient;
  private readonly enabled: boolean;
  private readonly maxRangeHours: number;
  private readonly queryStepSeconds: number;
  private readonly log = logger.child({ scope: 'RunPerformanceSummaryService' });

  constructor(private readonly deps: RunPerformanceSummaryServiceDeps = {}) {
    this.db = deps.database ?? defaultDb;
    this.enabled = deps.enabled ?? true;
    this.maxRangeHours = deps.maxRangeHours ?? 24;
    this.queryStepSeconds = deps.queryStepSeconds ?? 30;
  }

  async getRunSummary(params: {
    run: RunTraceRunRef;
    trace: RunTraceResponse;
    forceRefresh?: boolean;
  }): Promise<RunPerformanceSummary> {
    const runId = params.run.id ?? params.trace.runId;
    if (!runId) {
      throw new Error('run_performance_missing_run_id');
    }

    const terminal = params.run.status ? TERMINAL_RUN_STATUSES.has(params.run.status) : false;
    if (!params.forceRefresh && terminal) {
      const persisted = await this.getPersistedRunSummary(runId);
      if (persisted && this.canUsePersistedRunSummary(persisted, params.trace)) {
        return persisted;
      }
    }

    const generatedAt = new Date().toISOString();
    const window = this.resolveWindow(params.trace.events, params.trace.summary);
    const containers = this.extractContainers(params.trace.events, runId);
    const loadedMetrics = await this.loadContainerMetrics(containers, window, params.trace.events);
    this.decorateContainers(containers, loadedMetrics);
    const metricLoad = this.finalizeMetricLoad(containers, loadedMetrics);
    const sessions = params.trace.sessionIds.map((sessionId) => this.buildSessionSummary({
      sessionId,
      runId,
      events: params.trace.events.filter((event) => event.sessionId === sessionId),
      containers: this.containersForSession(containers, sessionId, runId),
      generatedAt,
      inheritedMetricLoad: metricLoad,
    }));
    const summary: RunPerformanceSummary = {
      schemaVersion: 1,
      subject: 'run',
      runId,
      generatedAt,
      status: statusForMetricStatus(metricLoad.status),
      source: metricLoad.source,
      metricStatus: metricLoad.status,
      metricUnavailableReason: metricLoad.reason ?? null,
      window,
      trace: {
        events: params.trace.stats.events,
        sessions: params.trace.sessionIds.length,
        toolCalls: params.trace.stats.toolCalls,
        modelCalls: params.trace.stats.modelCalls,
        failures: params.trace.stats.failures,
        totalTokens: params.trace.stats.totalTokens,
      },
      containers,
      sessions,
      totals: this.computeTotals(containers),
      capacity: this.computeCapacity(containers),
      warnings: this.collectWarnings(containers, metricLoad),
      missingSources: this.collectMissingSources(containers, metricLoad),
    };

    await this.persistRunSummary(summary).catch((error) => {
      this.log.warn({ err: error, runId }, 'Failed to persist run performance summary');
    });
    await Promise.all(summary.sessions.map((session) => this.persistSessionSummary(session).catch((error) => {
      this.log.warn({ err: error, sessionId: session.sessionId }, 'Failed to persist session performance summary');
    })));
    return summary;
  }

  async getSessionSummary(params: {
    sessionId: string;
    events: TimelineEvent[];
    runId?: string | null;
    forceRefresh?: boolean;
  }): Promise<SessionPerformanceSummary> {
    if (!params.forceRefresh) {
      const persisted = await this.getPersistedSessionSummary(params.sessionId);
      if (persisted && this.canUsePersistedSessionSummary(persisted, params.events)) {
        return persisted;
      }
    }

    const runId = params.runId ?? this.inferRunId(params.events);
    const generatedAt = new Date().toISOString();
    const window = this.resolveWindow(params.events);
    const containers = this.extractContainers(params.events, runId ?? undefined)
      .filter((container) => container.sessionId === params.sessionId || (runId && container.scope === 'run' && container.runId === runId));
    const loadedMetrics = await this.loadContainerMetrics(containers, window, params.events);
    this.decorateContainers(containers, loadedMetrics);
    const metricLoad = this.finalizeMetricLoad(containers, loadedMetrics);
    const summary = this.buildSessionSummary({
      sessionId: params.sessionId,
      runId,
      events: params.events,
      containers,
      generatedAt,
      inheritedMetricLoad: metricLoad,
    });
    await this.persistSessionSummary(summary).catch((error) => {
      this.log.warn({ err: error, sessionId: params.sessionId }, 'Failed to persist session performance summary');
    });
    return summary;
  }

  async getRunBundleEntries(run: RunTraceRunRef, trace: RunTraceResponse): Promise<RunTraceBundleEntry[]> {
    const summary = await this.getRunSummary({ run, trace, forceRefresh: true });
    return [
      { path: 'performance/run-performance.json', content: JSON.stringify(summary, null, 2) },
      { path: 'performance/run-performance.md', content: this.createRunMarkdown(summary) },
      ...summary.sessions.map((session) => ({
        path: `performance/sessions/${session.sessionId}.json`,
        content: JSON.stringify(session, null, 2),
      })),
    ];
  }

  private canUsePersistedRunSummary(
    persisted: RunPerformanceSummary,
    trace: RunTraceResponse,
  ): boolean {
    if ((persisted.trace?.events ?? 0) < trace.stats.events) {
      return false;
    }
    if (persisted.metricStatus === 'unavailable' && this.traceHasSandboxMetricSource(trace.events)) {
      return false;
    }
    if (this.deps.prometheusClient && persisted.metricStatus === 'unavailable') {
      return false;
    }
    return true;
  }

  private canUsePersistedSessionSummary(
    persisted: SessionPerformanceSummary,
    events: TimelineEvent[],
  ): boolean {
    if ((persisted.trace?.events ?? 0) < events.length) {
      return false;
    }
    if (persisted.metricStatus === 'unavailable' && this.traceHasSandboxMetricSource(events)) {
      return false;
    }
    if (this.deps.prometheusClient && persisted.metricStatus === 'unavailable') {
      return false;
    }
    return true;
  }

  private traceHasSandboxMetricSource(events: TimelineEvent[]): boolean {
    return events.some((event) =>
      event.event === 'sandbox.created' ||
      event.event === 'sandbox.attached' ||
      event.event === 'sandbox.sidecar.created' ||
      event.event === 'sandbox.stats',
    );
  }

  private buildSessionSummary(params: {
    sessionId: string;
    runId?: string | null;
    events: TimelineEvent[];
    containers: ContainerPerformanceSummary[];
    generatedAt: string;
    inheritedMetricLoad: MetricLoadResult;
  }): SessionPerformanceSummary {
    const noContainers = params.containers.length === 0;
    const metricStatus = noContainers ? 'unavailable' : params.inheritedMetricLoad.status;
    const reason = noContainers ? 'no_sandbox_container_in_trace' : params.inheritedMetricLoad.reason ?? null;
    return {
      schemaVersion: 1,
      subject: 'session',
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      generatedAt: params.generatedAt,
      status: statusForMetricStatus(metricStatus),
      source: sourceForMetricStatus(metricStatus),
      metricStatus,
      metricUnavailableReason: reason,
      window: this.resolveWindow(params.events),
      trace: this.computeTraceStats(params.events),
      containers: params.containers,
      totals: this.computeTotals(params.containers),
      capacity: this.computeCapacity(params.containers),
      warnings: this.collectWarnings(params.containers, params.inheritedMetricLoad),
      missingSources: this.collectMissingSources(params.containers, params.inheritedMetricLoad),
    };
  }

  private async loadContainerMetrics(
    containers: ContainerPerformanceSummary[],
    window: PerformanceWindow,
    events: TimelineEvent[] = [],
  ): Promise<MetricLoadResult> {
    if (!this.enabled) {
      return { status: 'unavailable', source: 'trace_only', reason: 'performance_summary_disabled' };
    }
    if (containers.length === 0) {
      return { status: 'unavailable', source: 'trace_only', reason: 'no_sandbox_container_in_trace' };
    }
    // Docker-stats samples (captured live during the run) work without cAdvisor/Prometheus.
    const dockerStatsMerged = this.mergeDockerStatsEvents(containers, events);
    if (!this.deps.prometheusClient) {
      return dockerStatsMerged
        ? { status: 'available', source: 'docker_stats', reason: null }
        : { status: 'unavailable', source: 'trace_only', reason: 'prometheus_not_configured' };
    }
    const startedAt = dateFromIso(window.startedAt);
    const endedAt = dateFromIso(window.endedAt) ?? new Date();
    if (!startedAt || endedAt.getTime() <= startedAt.getTime()) {
      return { status: 'unavailable', source: 'trace_only', reason: 'invalid_metric_window' };
    }

    const maxMs = this.maxRangeHours * 60 * 60 * 1000;
    const start = endedAt.getTime() - startedAt.getTime() > maxMs
      ? new Date(endedAt.getTime() - maxMs)
      : startedAt;
    const clamped = start.getTime() !== startedAt.getTime();
    const selectors = this.buildPrometheusSelectors(containers);
    const queries: Array<{ key: PrometheusMetricKey; query: string }> = [
      { key: 'cpuCores', query: this.buildPrometheusQuery('container_cpu_usage_seconds_total', selectors, '1m') },
      { key: 'memoryBytes', query: this.buildPrometheusQuery('container_memory_working_set_bytes', selectors) },
      { key: 'networkRxBytesPerSecond', query: this.buildPrometheusQuery('container_network_receive_bytes_total', selectors, '1m') },
      { key: 'networkTxBytesPerSecond', query: this.buildPrometheusQuery('container_network_transmit_bytes_total', selectors, '1m') },
      { key: 'pids', query: this.buildPrometheusQuery('container_threads', selectors) },
    ];

    const results = await Promise.allSettled(queries.map(async (query) => ({
      key: query.key,
      series: await this.deps.prometheusClient!.queryRange({
        query: query.query,
        start,
        end: endedAt,
        stepSeconds: this.queryStepSeconds,
      }),
    })));

    let fulfilled = 0;
    let hasSamples = false;
    const errors: string[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        continue;
      }
      fulfilled += 1;
      hasSamples = this.mergeMetricSeries(containers, result.value.key, result.value.series) || hasSamples;
    }

    if (!hasSamples) {
      // Prometheus had nothing, but live docker-stats samples may have filled the gap.
      return dockerStatsMerged
        ? { status: 'available', source: 'docker_stats', reason: null }
        : {
          status: 'unavailable',
          source: 'trace_only',
          reason: errors[0] ?? 'prometheus_returned_no_container_samples',
        };
    }
    if (errors.length > 0 || fulfilled < queries.length || clamped) {
      return {
        status: 'partial',
        source: 'mixed',
        reason: clamped ? `metric_window_clamped_to_${this.maxRangeHours}h` : errors[0] ?? 'some_prometheus_queries_failed',
      };
    }
    return { status: 'available', source: 'prometheus', reason: null };
  }

  private buildPrometheusQuery(metric: string, selectors: string[], rateWindow?: string): string {
    return selectors
      .map((selector) => {
        const scopedMetric = `${metric}{${selector}}`;
        return rateWindow ? `rate(${scopedMetric}[${rateWindow}])` : scopedMetric;
      })
      .join(' or ');
  }

  private containersForSession(
    containers: ContainerPerformanceSummary[],
    sessionId: string,
    runId?: string | null,
  ): ContainerPerformanceSummary[] {
    return containers.filter(
      (container) =>
        container.sessionId === sessionId ||
        (Boolean(runId) && container.scope === 'run' && container.runId === runId),
    );
  }

  private buildPrometheusSelectors(containers: ContainerPerformanceSummary[]): string[] {
    const idTokens = Array.from(new Set(containers.flatMap((container) => [
      container.containerId,
      container.containerId.slice(0, 12),
    ]).filter(Boolean)));
    const nameTokens = Array.from(new Set(containers.map((container) => container.name).filter((value): value is string => Boolean(value))));
    const sessionTokens = Array.from(new Set(containers.map((container) => container.sessionId).filter(Boolean)));

    const selectors: string[] = [];
    if (idTokens.length > 0) {
      selectors.push('id=~' + DOUBLE_QUOTE + escapePrometheusString('.*(' + idTokens.map(escapePrometheusRegex).join('|') + ').*') + DOUBLE_QUOTE);
    }
    if (nameTokens.length > 0) {
      selectors.push('name=~' + DOUBLE_QUOTE + escapePrometheusString('.*(' + nameTokens.map(escapePrometheusRegex).join('|') + ').*') + DOUBLE_QUOTE);
    }
    const sessionRegex = Array.from(new Set(containers.map((container) => container.sessionId)))
      .map(escapePrometheusRegex)
      .join('|');
    if (sessionTokens.length > 0 && sessionRegex.length > 0) {
      selectors.push('container_label_nullai_session_id=~' + DOUBLE_QUOTE + escapePrometheusString(sessionRegex) + DOUBLE_QUOTE);
    }
    return selectors;
  }

  /**
   * Merge live `docker stats` aggregates (emitted as `sandbox.stats` trace events
   * by the sandbox sampler) onto the extracted containers. Works without
   * cAdvisor/Prometheus. Returns true if any container received samples.
   */
  private mergeDockerStatsEvents(
    containers: ContainerPerformanceSummary[],
    events: TimelineEvent[],
  ): boolean {
    const byContainer = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      if (event.event !== 'sandbox.stats') continue;
      const payload = asRecord(event.payload);
      const containerId = payload && asString(payload.containerId);
      if (!payload || !containerId) continue;
      const samples = asNumber(payload.samples) ?? 0;
      const existing = byContainer.get(containerId);
      const existingSamples = existing ? asNumber(existing.samples) ?? 0 : -1;
      if (!existing || samples >= existingSamples) byContainer.set(containerId, payload);
    }
    if (byContainer.size === 0) return false;

    let merged = false;
    for (const container of containers) {
      const payload =
        byContainer.get(container.containerId) ??
        byContainer.get(container.containerId.slice(0, 12)) ??
        [...byContainer.entries()].find(([id]) =>
          id.startsWith(container.containerId.slice(0, 12)) ||
          container.containerId.startsWith(id.slice(0, 12)),
        )?.[1];
      if (!payload) continue;
      container.cpuCores = coerceNumericStats(payload.cpuCores);
      container.memoryBytes = coerceNumericStats(payload.memoryBytes);
      container.pids = coerceNumericStats(payload.pids);
      container.networkRxBytesPerSecond = coerceNumericStats(payload.networkRxBytesPerSecond);
      container.networkTxBytesPerSecond = coerceNumericStats(payload.networkTxBytesPerSecond);
      const rxTotal = asNumber(payload.networkRxBytesEstimatedTotal);
      const txTotal = asNumber(payload.networkTxBytesEstimatedTotal);
      if (rxTotal != null) container.networkRxBytesEstimatedTotal = rxTotal;
      if (txTotal != null) container.networkTxBytesEstimatedTotal = txTotal;
      merged = true;
    }
    return merged;
  }

  private mergeMetricSeries(
    containers: ContainerPerformanceSummary[],
    key: PrometheusMetricKey,
    series: PrometheusRangeSeries[],
  ): boolean {
    const valuesByContainerId = new Map<string, number[]>();
    for (const item of series) {
      const container = this.resolveSeriesContainer(containers, item.metric);
      if (!container) continue;
      const values = item.values
        .map(([, raw]) => Number(raw))
        .filter((value) => Number.isFinite(value) && value >= 0);
      if (values.length === 0) continue;
      const existing = valuesByContainerId.get(container.containerId) ?? [];
      existing.push(...values);
      valuesByContainerId.set(container.containerId, existing);
    }

    for (const container of containers) {
      const values = valuesByContainerId.get(container.containerId);
      if (!values || values.length === 0) continue;
      container[key] = computeStats(values);
    }
    return valuesByContainerId.size > 0;
  }

  private resolveSeriesContainer(
    containers: ContainerPerformanceSummary[],
    metric: Record<string, string>,
  ): ContainerPerformanceSummary | null {
    const metricId = metric.id ?? '';
    const metricName = (metric.name ?? metric.container ?? '').replace(/^\/+/, '');
    const sessionId = metric.container_label_nullai_session_id;
    const direct = containers.find((container) =>
      metricId.includes(container.containerId) || metricId.includes(container.containerId.slice(0, 12)),
    );
    if (direct) return direct;
    const named = containers.find((container) =>
      container.name && (metricName === container.name || metricName.endsWith(container.name)),
    );
    if (named) return named;
    const sameSession = containers.filter((container) => container.sessionId === sessionId);
    if (sameSession.length === 1) return sameSession[0] ?? null;
    return null;
  }

  private extractContainers(events: TimelineEvent[], runId?: string | null): ContainerPerformanceSummary[] {
    const byId = new Map<string, ContainerPerformanceSummary>();
    for (const event of events) {
      const payload = asRecord(event.payload) ?? {};
      const containerId = asString(payload.containerId);
      if (!containerId) continue;
      if (event.event === 'sandbox.created' || event.event === 'sandbox.sidecar.created' || event.event === 'sandbox.attached') {
        const existing = byId.get(containerId);
        const limits = this.extractLimits(payload) ?? existing?.limits ?? null;
        byId.set(containerId, {
          containerId,
          sessionId: event.sessionId,
          runId: asString(payload.runId) ?? event.runId ?? runId ?? null,
          kind: event.event === 'sandbox.sidecar.created' ? 'sidecar' : existing?.kind ?? 'sandbox',
          name: asString(payload.containerName) ?? asString(payload.name) ?? existing?.name,
          image: asString(payload.image) ?? existing?.image,
          profile: asString(payload.profile) ?? existing?.profile,
          scope: asString(payload.containerScope) === 'run'
            ? 'run'
            : asString(payload.containerScope) === 'session'
              ? 'session'
              : existing?.scope ?? null,
          createdAt: existing?.createdAt ?? toIso(event.ts),
          destroyedAt: existing?.destroyedAt ?? null,
          durationMs: existing?.durationMs ?? null,
          limits,
          metricCoverage: existing?.metricCoverage ?? cloneEmptyCoverage(),
          capacity: existing?.capacity ?? cloneEmptyCapacity(),
          warnings: existing?.warnings ?? [],
          networkRxBytesEstimatedTotal: existing?.networkRxBytesEstimatedTotal ?? null,
          networkTxBytesEstimatedTotal: existing?.networkTxBytesEstimatedTotal ?? null,
          cpuCores: existing?.cpuCores ?? cloneEmptyStats(),
          memoryBytes: existing?.memoryBytes ?? cloneEmptyStats(),
          networkRxBytesPerSecond: existing?.networkRxBytesPerSecond ?? cloneEmptyStats(),
          networkTxBytesPerSecond: existing?.networkTxBytesPerSecond ?? cloneEmptyStats(),
          pids: existing?.pids ?? cloneEmptyStats(),
        });
      }
      if (event.event === 'sandbox.destroyed') {
        const existing = byId.get(containerId);
        if (existing) {
          existing.destroyedAt = toIso(event.ts);
          existing.durationMs = durationBetween(existing.createdAt, existing.destroyedAt);
        }
      }
    }
    return Array.from(byId.values()).sort((left, right) =>
      (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.containerId.localeCompare(right.containerId),
    );
  }

  private extractLimits(payload: Record<string, unknown>): SandboxLimitSnapshot | null {
    const nested = asRecord(payload.limits);
    const source = nested ?? payload;
    const cpuQuota = asNumber(source.cpuQuota);
    const memoryMb = asNumber(source.memoryMb);
    const memoryBytes = asNumber(source.memoryBytes) ?? (memoryMb ? memoryMb * 1024 * 1024 : null);
    const pidsLimit = asNumber(source.pidsLimit);
    if (cpuQuota === null && memoryMb === null && memoryBytes === null && pidsLimit === null) {
      return null;
    }
    return {
      cpuQuota,
      memoryMb,
      memoryBytes,
      pidsLimit,
      enforced: asBoolean(source.enforced) ?? false,
      source: asLimitSource(source.source) ?? 'config',
    };
  }

  private finalizeMetricLoad(containers: ContainerPerformanceSummary[], metricLoad: MetricLoadResult): MetricLoadResult {
    if (metricLoad.status === 'unavailable' || containers.length === 0) return metricLoad;
    const allContainersFullyCovered = containers.every((container) =>
      container.metricCoverage.cpu &&
      container.metricCoverage.memory &&
      container.metricCoverage.networkRx &&
      container.metricCoverage.networkTx &&
      container.metricCoverage.pids,
    );
    if (allContainersFullyCovered) return metricLoad;
    return {
      status: 'partial',
      source: 'mixed',
      reason: metricLoad.reason ?? 'some_container_metric_samples_missing',
    };
  }

  private decorateContainers(containers: ContainerPerformanceSummary[], metricLoad: MetricLoadResult): void {
    for (const container of containers) {
      container.durationMs = container.durationMs ?? durationBetween(container.createdAt, container.destroyedAt);
      container.metricCoverage = this.computeMetricCoverage(container);
      // docker stats reports cumulative network totals directly (authoritative);
      // only estimate from rate*duration when a real total is not already present.
      container.networkRxBytesEstimatedTotal =
        container.networkRxBytesEstimatedTotal ??
        this.estimateNetworkTotal(container.networkRxBytesPerSecond, container.durationMs);
      container.networkTxBytesEstimatedTotal =
        container.networkTxBytesEstimatedTotal ??
        this.estimateNetworkTotal(container.networkTxBytesPerSecond, container.durationMs);
      container.capacity = this.computeContainerCapacity(container);
      container.warnings = this.collectContainerWarnings(container, metricLoad);
    }
  }

  private computeMetricCoverage(container: ContainerPerformanceSummary): ContainerMetricCoverage {
    return {
      cpu: normalizeStat(container.cpuCores).samples > 0,
      memory: normalizeStat(container.memoryBytes).samples > 0,
      networkRx: normalizeStat(container.networkRxBytesPerSecond).samples > 0,
      networkTx: normalizeStat(container.networkTxBytesPerSecond).samples > 0,
      pids: normalizeStat(container.pids).samples > 0,
    };
  }

  private estimateNetworkTotal(stats: NumericStats, durationMs: number | null): number | null {
    if (typeof stats.avg !== 'number' || !Number.isFinite(stats.avg)) return null;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    return stats.avg * (durationMs / 1000);
  }

  private computeContainerCapacity(container: ContainerPerformanceSummary): PerformanceCapacitySignals {
    const memoryLimit = container.limits?.memoryBytes ?? null;
    const peakMemory = normalizeStat(container.memoryBytes).max;
    const pidsLimit = container.limits?.pidsLimit ?? null;
    const peakPids = normalizeStat(container.pids).max;
    const cpuQuota = container.limits?.cpuQuota ?? null;
    const peakCpu = normalizeStat(container.cpuCores).max;
    return {
      configuredMemoryBytes: memoryLimit,
      peakMemoryBytes: peakMemory,
      memoryUtilizationRatio: safeRatio(peakMemory, memoryLimit),
      configuredPidsLimit: pidsLimit,
      peakPids,
      pidsUtilizationRatio: safeRatio(peakPids, pidsLimit),
      configuredCpuQuota: cpuQuota,
      peakCpuCores: peakCpu,
      cpuQuotaUtilizationRatio: safeRatio(peakCpu, cpuQuota),
    };
  }

  private collectContainerWarnings(container: ContainerPerformanceSummary, metricLoad: MetricLoadResult): string[] {
    const warnings = new Set<string>();
    if (!container.destroyedAt) {
      warnings.add('container_destroy_event_missing_or_container_still_running');
    }
    if (container.limits?.source === 'config' && container.limits.enforced === false) {
      warnings.add('sandbox_limits_configured_but_not_docker_enforced');
    }
    if (metricLoad.status !== 'unavailable') {
      if (!container.metricCoverage.cpu) warnings.add('cpu_metric_missing');
      if (!container.metricCoverage.memory) warnings.add('memory_metric_missing');
      if (!container.metricCoverage.pids) warnings.add('pids_metric_missing');
    }
    if ((container.capacity.memoryUtilizationRatio ?? 0) >= 0.85) {
      warnings.add('memory_peak_above_85_percent_of_configured_policy');
    }
    if ((container.capacity.pidsUtilizationRatio ?? 0) >= 0.85) {
      warnings.add('pids_peak_above_85_percent_of_configured_policy');
    }
    if ((container.capacity.cpuQuotaUtilizationRatio ?? 0) >= 0.85) {
      warnings.add('cpu_peak_above_85_percent_of_configured_policy');
    }
    return Array.from(warnings).sort();
  }

  private computeCapacity(containers: ContainerPerformanceSummary[]): PerformanceCapacitySignals {
    if (containers.length === 0) return cloneEmptyCapacity();
    return {
      configuredMemoryBytes: sumNullable(containers.map((container) => container.limits?.memoryBytes)),
      peakMemoryBytes: maxNullable(containers.map((container) => container.capacity.peakMemoryBytes)),
      memoryUtilizationRatio: maxNullable(containers.map((container) => container.capacity.memoryUtilizationRatio)),
      configuredPidsLimit: sumNullable(containers.map((container) => container.limits?.pidsLimit)),
      peakPids: maxNullable(containers.map((container) => container.capacity.peakPids)),
      pidsUtilizationRatio: maxNullable(containers.map((container) => container.capacity.pidsUtilizationRatio)),
      configuredCpuQuota: sumNullable(containers.map((container) => container.limits?.cpuQuota)),
      peakCpuCores: maxNullable(containers.map((container) => container.capacity.peakCpuCores)),
      cpuQuotaUtilizationRatio: maxNullable(containers.map((container) => container.capacity.cpuQuotaUtilizationRatio)),
    };
  }

  private collectWarnings(containers: ContainerPerformanceSummary[], metricLoad: MetricLoadResult): string[] {
    const warnings = new Set<string>();
    if (metricLoad.reason) warnings.add(metricLoad.reason);
    if (containers.length === 0) warnings.add('no_sandbox_container_in_trace');
    for (const container of containers) {
      for (const warning of container.warnings) warnings.add(warning);
    }
    return Array.from(warnings).sort();
  }

  private collectMissingSources(containers: ContainerPerformanceSummary[], metricLoad: MetricLoadResult): string[] {
    const missing = new Set<string>();
    missing.add('workspace_size_not_collected');
    if (metricLoad.status === 'unavailable') {
      missing.add(metricLoad.reason ?? 'prometheus_metrics_unavailable');
    }
    if (containers.length === 0) {
      missing.add('sandbox_container_trace_events');
      return Array.from(missing).sort();
    }
    const coverage = containers.reduce((acc, container) => ({
      cpu: acc.cpu || container.metricCoverage.cpu,
      memory: acc.memory || container.metricCoverage.memory,
      networkRx: acc.networkRx || container.metricCoverage.networkRx,
      networkTx: acc.networkTx || container.metricCoverage.networkTx,
      pids: acc.pids || container.metricCoverage.pids,
    }), cloneEmptyCoverage());
    if (metricLoad.status !== 'unavailable') {
      if (!coverage.cpu) missing.add('cpu_metrics');
      if (!coverage.memory) missing.add('memory_metrics');
      if (!coverage.networkRx || !coverage.networkTx) missing.add('network_metrics');
      if (!coverage.pids) missing.add('pid_or_thread_metrics');
      if (coverage.cpu && containers.some((container) => !container.metricCoverage.cpu)) missing.add('cpu_metrics_partial');
      if (coverage.memory && containers.some((container) => !container.metricCoverage.memory)) missing.add('memory_metrics_partial');
      if (
        (coverage.networkRx || coverage.networkTx) &&
        containers.some((container) => !container.metricCoverage.networkRx || !container.metricCoverage.networkTx)
      ) {
        missing.add('network_metrics_partial');
      }
      if (coverage.pids && containers.some((container) => !container.metricCoverage.pids)) missing.add('pid_or_thread_metrics_partial');
    }
    return Array.from(missing).sort();
  }

  private resolveWindow(
    events: TimelineEvent[],
    fallback?: RunTraceResponse['summary'],
  ): PerformanceWindow {
    const startedAt = fallback?.startedAt ?? events[0]?.ts ?? null;
    const endedAt = fallback?.completedAt ?? events[events.length - 1]?.ts ?? null;
    const startMs = startedAt ? Date.parse(startedAt) : NaN;
    const endMs = endedAt ? Date.parse(endedAt) : NaN;
    return {
      startedAt: toIso(startedAt),
      endedAt: toIso(endedAt),
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null,
    };
  }

  private computeTraceStats(events: TimelineEvent[]): PerformanceTraceStats {
    let toolCalls = 0;
    let modelCalls = 0;
    let failures = 0;
    let totalTokens = 0;
    for (const event of events) {
      const payload = asRecord(event.payload) ?? {};
      if (event.event === 'tool.finish') toolCalls += 1;
      if (event.event === 'model.call.finish') {
        modelCalls += 1;
        const tokens = asRecord(payload.tokens);
        totalTokens += asNumber(tokens?.total) ?? 0;
      }
      if (
        event.severity === 'error' ||
        payload.outcome === 'failure' ||
        payload.outcome === 'error' ||
        payload.outcome === 'blocked' ||
        payload.success === false
      ) {
        failures += 1;
      }
    }
    return { events: events.length, toolCalls, modelCalls, failures, totalTokens };
  }

  private computeTotals(containers: ContainerPerformanceSummary[]): PerformanceResourceTotals {
    return {
      containerCount: containers.length,
      avgCpuCores: sumNullable(containers.map((container) => normalizeStat(container.cpuCores).avg)),
      maxCpuCores: sumNullable(containers.map((container) => normalizeStat(container.cpuCores).max)),
      p95CpuCores: sumNullable(containers.map((container) => normalizeStat(container.cpuCores).p95)),
      maxMemoryBytes: maxNullable(containers.map((container) => normalizeStat(container.memoryBytes).max)),
      p95MemoryBytes: maxNullable(containers.map((container) => normalizeStat(container.memoryBytes).p95)),
      maxPids: maxNullable(containers.map((container) => normalizeStat(container.pids).max)),
      networkRxBytesPerSecondAvg: sumNullable(containers.map((container) => normalizeStat(container.networkRxBytesPerSecond).avg)),
      networkTxBytesPerSecondAvg: sumNullable(containers.map((container) => normalizeStat(container.networkTxBytesPerSecond).avg)),
      networkRxBytesPerSecondMax: sumNullable(containers.map((container) => normalizeStat(container.networkRxBytesPerSecond).max)),
      networkTxBytesPerSecondMax: sumNullable(containers.map((container) => normalizeStat(container.networkTxBytesPerSecond).max)),
      networkRxBytesEstimatedTotal: sumNullable(containers.map((container) => container.networkRxBytesEstimatedTotal)),
      networkTxBytesEstimatedTotal: sumNullable(containers.map((container) => container.networkTxBytesEstimatedTotal)),
    };
  }

  private inferRunId(events: TimelineEvent[]): string | null {
    return events.map((event) => event.runId).find((value): value is string => Boolean(value)) ?? null;
  }

  private async getPersistedRunSummary(runId: string): Promise<RunPerformanceSummary | null> {
    const [row] = await this.db
      .select({ summary: runPerformanceSummaries.summary })
      .from(runPerformanceSummaries)
      .where(eq(runPerformanceSummaries.runId, runId))
      .limit(1);
    const summary = row?.summary as Partial<RunPerformanceSummary> | undefined;
    return summary?.schemaVersion === 1 && summary.subject === 'run' ? summary as RunPerformanceSummary : null;
  }

  private async getPersistedSessionSummary(sessionId: string): Promise<SessionPerformanceSummary | null> {
    const [row] = await this.db
      .select({ summary: sessionPerformanceSummaries.summary })
      .from(sessionPerformanceSummaries)
      .where(eq(sessionPerformanceSummaries.sessionId, sessionId))
      .limit(1);
    const summary = row?.summary as Partial<SessionPerformanceSummary> | undefined;
    return summary?.schemaVersion === 1 && summary.subject === 'session' ? summary as SessionPerformanceSummary : null;
  }

  private async persistRunSummary(summary: RunPerformanceSummary): Promise<void> {
    const now = new Date();
    await this.db.insert(runPerformanceSummaries).values({
      runId: summary.runId,
      status: summary.status,
      source: summary.source,
      startedAt: dateFromIso(summary.window.startedAt),
      endedAt: dateFromIso(summary.window.endedAt),
      durationMs: summary.window.durationMs,
      summary,
      generatedAt: dateFromIso(summary.generatedAt) ?? now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: runPerformanceSummaries.runId,
      set: {
        status: summary.status,
        source: summary.source,
        startedAt: dateFromIso(summary.window.startedAt),
        endedAt: dateFromIso(summary.window.endedAt),
        durationMs: summary.window.durationMs,
        summary,
        generatedAt: dateFromIso(summary.generatedAt) ?? now,
        updatedAt: now,
      },
    });
  }

  private async persistSessionSummary(summary: SessionPerformanceSummary): Promise<void> {
    const now = new Date();
    await this.db.insert(sessionPerformanceSummaries).values({
      sessionId: summary.sessionId,
      runId: summary.runId ?? null,
      status: summary.status,
      source: summary.source,
      startedAt: dateFromIso(summary.window.startedAt),
      endedAt: dateFromIso(summary.window.endedAt),
      durationMs: summary.window.durationMs,
      summary,
      generatedAt: dateFromIso(summary.generatedAt) ?? now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: sessionPerformanceSummaries.sessionId,
      set: {
        runId: summary.runId ?? null,
        status: summary.status,
        source: summary.source,
        startedAt: dateFromIso(summary.window.startedAt),
        endedAt: dateFromIso(summary.window.endedAt),
        durationMs: summary.window.durationMs,
        summary,
        generatedAt: dateFromIso(summary.generatedAt) ?? now,
        updatedAt: now,
      },
    });
  }

  private createRunMarkdown(summary: RunPerformanceSummary): string {
    const format = (value: number | null, digits = 2) =>
      typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    return [
      '# Run Performance Summary',
      '',
      `Run: ${summary.runId}`,
      `Generated: ${summary.generatedAt}`,
      `Source: ${summary.source}`,
      `Metric status: ${summary.metricStatus}${summary.metricUnavailableReason ? ` (${summary.metricUnavailableReason})` : ''}`,
      `Window: ${summary.window.startedAt ?? 'n/a'} -> ${summary.window.endedAt ?? 'n/a'}`,
      '',
      '## Totals',
      '',
      `Containers: ${summary.totals.containerCount}`,
      `Average CPU cores: ${format(summary.totals.avgCpuCores)}`,
      `Peak CPU cores: ${format(summary.totals.maxCpuCores)}`,
      `Peak memory bytes: ${format(summary.totals.maxMemoryBytes, 0)}`,
      `Peak PIDs: ${format(summary.totals.maxPids, 0)}`,
      `Estimated RX bytes: ${format(summary.totals.networkRxBytesEstimatedTotal, 0)}`,
      `Estimated TX bytes: ${format(summary.totals.networkTxBytesEstimatedTotal, 0)}`,
      '',
      '## Capacity Signals',
      '',
      `Configured memory bytes: ${format(summary.capacity.configuredMemoryBytes, 0)}`,
      `Peak memory utilization: ${format(summary.capacity.memoryUtilizationRatio === null ? null : summary.capacity.memoryUtilizationRatio * 100)}%`,
      `Configured CPU quota: ${format(summary.capacity.configuredCpuQuota)}`,
      `Peak CPU quota utilization: ${format(summary.capacity.cpuQuotaUtilizationRatio === null ? null : summary.capacity.cpuQuotaUtilizationRatio * 100)}%`,
      `Configured PID limit: ${format(summary.capacity.configuredPidsLimit, 0)}`,
      `Peak PID utilization: ${format(summary.capacity.pidsUtilizationRatio === null ? null : summary.capacity.pidsUtilizationRatio * 100)}%`,
      '',
      '## Warnings',
      '',
      ...(summary.warnings.length > 0 ? summary.warnings.map((warning) => `- ${warning}`) : ['- none']),
      '',
      '## Missing Sources',
      '',
      ...(summary.missingSources.length > 0 ? summary.missingSources.map((source) => `- ${source}`) : ['- none']),
      '',
      '## Trace',
      '',
      `Sessions: ${summary.trace.sessions}`,
      `Events: ${summary.trace.events}`,
      `Tool calls: ${summary.trace.toolCalls}`,
      `Model calls: ${summary.trace.modelCalls}`,
      `Failures: ${summary.trace.failures}`,
      `Total tokens: ${summary.trace.totalTokens}`,
      '',
    ].join('\n');
  }
}
