import { promises as fs } from 'fs';
import path from 'path';
import type { RiskState, RunWorkflowDiscipline } from '@/db/schema';
import type { TimelineEvent, TimelineService } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import { buildFindingReportCompleteness } from '@/domains/security-ops/findings/findingReportCompleteness';
import {
  reconcileTraceIntegrity,
  type TraceIntegrityResult,
  type TraceIntegrityStatus,
} from '@/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';

type TimelineServicePort = Pick<TimelineService, 'getAllEvents'>;

export interface RunTraceDbToolExecutionRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown> | null;
  result?: unknown;
  status: string;
  claimedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  durationMs?: number | null;
  error?: string | null;
}

export interface RunTraceDbRunEventRecord {
  id: string;
  runId: string;
  type: string;
  note?: string | null;
  createdAt: Date | string;
}

export interface RunTraceDbPhaseReplanRecord {
  id: string;
  runId: string;
  phaseId: string;
  status: string;
  requestedPhaseStatus: string;
  handoffRef?: string | null;
  reason?: string | null;
  dispatchAttempts?: number | null;
  lastDispatchAt?: Date | string | null;
  lastDispatchError?: string | null;
  requestedAt?: Date | string | null;
  appliedAt?: Date | string | null;
  closedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface RunTraceDbFallbackSource {
  listToolExecutionRecords(sessionIds: readonly string[]): Promise<RunTraceDbToolExecutionRecord[]>;
  listRunEvents(runId: string): Promise<RunTraceDbRunEventRecord[]>;
  listRunPhaseReplans?(runId: string): Promise<RunTraceDbPhaseReplanRecord[]>;
}

export interface RunTraceReportFindingRecord {
  id: string;
  title: string;
  severity: string;
  state: RiskState;
  summary?: string | null;
  businessImpact?: string | null;
  technicalAnalysis?: string | null;
  pocDescription?: string | null;
  assumptions?: string | null;
  remediation?: string | null;
  fixEffort?: string | null;
  cweId?: string | null;
  cweIds?: string[] | null;
  owaspCategory?: string | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  dedupeKey?: string | null;
  assetKind?: string | null;
  assetValue?: string | null;
  lastSeenAt?: Date | string | null;
}

export interface RunTraceReportFindingsSource {
  listReportFindings(run: RunTraceRunRef, sessionIds: readonly string[]): Promise<RunTraceReportFindingRecord[]>;
}

export interface RunTraceCloseoutArtifactSource {
  listCloseoutArtifacts(run: RunTraceRunRef, sessionIds: readonly string[]): Promise<RunTraceBundleEntry[]>;
}

export interface RunTracePerformanceBundleSource {
  getRunBundleEntries(run: RunTraceRunRef, trace: RunTraceResponse): Promise<RunTraceBundleEntry[]>;
}

export interface RunTraceComplianceBundleSource {
  getRunBundleEntries(
    run: RunTraceRunRef,
    sessionIds: readonly string[],
    closeoutEntries: readonly RunTraceBundleEntry[],
    trace?: RunTraceResponse,
  ): Promise<RunTraceBundleEntry[]>;
}

export interface RunTraceRunRef {
  id?: string | null;
  organizationId?: string | null;
  scopeId?: string | null;
  sessionId?: string | null;
  plannerSessionId?: string | null;
  executorSessionId?: string | null;
  status?: string | null;
  workflowDiscipline?: RunWorkflowDiscipline | null;
}

export type RunTraceBundleMode = 'review' | 'forensic';

export interface RunTraceBundleOptions {
  mode?: RunTraceBundleMode;
}

interface RunTraceSessionResolverPort {
  listIdsByRunId?(runId: string): Promise<string[]>;
}

interface RunTraceIntegritySourcePort {
  find(sessionId: string): Promise<{
    acceptedHighWater: number;
    persistedHighWater: number;
    integrityStatus: string;
    integrityDetails: unknown;
  } | null>;
}

interface RunTracePhaseRow {
  id: string;
  phaseKey: string;
  ordinal: number;
  sessionId?: string | null;
}

interface RunTracePhaseSourcePort {
  listByRunId(runId: string): Promise<RunTracePhaseRow[]>;
}

export interface RunTraceQuery {
  types?: string[];
  severity?: string[];
  search?: string;
  offset?: number;
  limit?: number;
  includeDebug?: boolean;
}

export interface RunTraceStats {
  events: number;
  sessions: number;
  byEvent: Record<string, number>;
  bySeverity: Record<string, number>;
  toolCalls: number;
  modelCalls: number;
  actions: number;
  discoveries: number;
  linkedArtifacts: number;
  totalTokens: number;
  failures: number;
}

export interface RunTraceResponse {
  runId: string;
  sessionIds: string[];
  generatedAt: string;
  events: TimelineEvent[];
  total: number;
  stats: RunTraceStats;
  summary: {
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    eventTypes: string[];
    roles: string[];
  };
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  integrity: {
    status: TraceIntegrityStatus;
    sessions: TraceIntegrityResult[];
  };
}

export interface RunTraceBundleEntry {
  path: string;
  content: Buffer | string;
}

export interface RunTraceServiceDeps {
  timelineService: TimelineServicePort;
  sessionResolver?: RunTraceSessionResolverPort;
  phaseSource?: RunTracePhaseSourcePort;
  dbFallbackSource?: RunTraceDbFallbackSource;
  reportFindingsSource?: RunTraceReportFindingsSource;
  closeoutArtifactSource?: RunTraceCloseoutArtifactSource;
  performanceBundleSource?: RunTracePerformanceBundleSource;
  complianceBundleSource?: RunTraceComplianceBundleSource;
  integritySource?: RunTraceIntegritySourcePort;
  traceRoot?: string;
  s3Client?: S3StorageService;
}

const TRACE_PAGE_LIMIT_MAX = 1000;
const DEFAULT_TRACE_PAGE_LIMIT = 250;
const RUN_WORKFLOW_DISCIPLINES = new Set<RunWorkflowDiscipline>([
  'pentest',
  'compliance',
  'code_review',
]);

export const isRunWorkflowDiscipline = (
  value: string | null | undefined,
): value is RunWorkflowDiscipline =>
  typeof value === 'string' && RUN_WORKFLOW_DISCIPLINES.has(value as RunWorkflowDiscipline);

export const resolveRunTraceBundleMode = (
  run: RunTraceRunRef,
  requestedMode: RunTraceBundleMode,
): RunTraceBundleMode =>
  requestedMode === 'review' && isRunWorkflowDiscipline(run.workflowDiscipline)
    ? 'review'
    : 'forensic';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTraceIntegrityResult = (value: unknown): value is TraceIntegrityResult => {
  if (!isRecord(value) || value.schema !== 'trace-integrity/v1') return false;
  return typeof value.sessionId === 'string'
    && (value.status === 'complete' || value.status === 'degraded' || value.status === 'failed')
    && typeof value.acceptedHighWater === 'number'
    && typeof value.persistedHighWater === 'number'
    && Array.isArray(value.issues)
    && isRecord(value.surfaces);
};

const aggregateIntegrityStatus = (sessions: TraceIntegrityResult[]): TraceIntegrityStatus =>
  sessions.some((session) => session.status === 'failed')
    ? 'failed'
    : sessions.some((session) => session.status === 'degraded') || sessions.length === 0
      ? 'degraded'
      : 'complete';

const asPayloadRecord = (event: TimelineEvent): Record<string, unknown> =>
  isRecord(event.payload) ? event.payload : {};

const isDbFallbackEvent = (event: TimelineEvent): boolean =>
  asPayloadRecord(event).fallback === true;

/**
 * Tools whose successful call means the run wrote something durable a customer can read.
 * This is what `discoveries` is meant to measure: canonical records produced, not regex
 * patterns matched inside a truncated response preview.
 *
 * The tools declare this themselves as `progressKind: 'canonical'` and `tool.finish` now
 * carries the declaration, so a tool added or renamed later is counted without anyone
 * remembering to edit a list here. The list below is only the reader for traces recorded
 * before the declaration was on the event, and holds names that exist today.
 */
/**
 * Canonical writes that record how the run is progressing rather than what it learned about
 * the target. They are real records and they are not discoveries; run r1 would have counted
 * six phase handoffs as knowledge about the customer's estate.
 */
export const WORKFLOW_CANONICAL_TOOLS = new Set([
  'submit_phase_handoff',
  'submit_phase_checkpoint',
]);

export const LEGACY_CANONICAL_DISCOVERY_TOOLS = new Set([
  'report_finding',
  'report_asset',
  'report_service',
  'report_note',
  'ingest_scan_artifact',
  'promote_finding',
  'submit_validation_lead_outcome',
  'submit_validation_outcome',
  'submit_exposure_verification',
  'submit_finding_disposition_outcome',
  'record_control_check',
  'report_code_review_candidate',
]);

const countsAsCanonicalDiscovery = (payload: Record<string, unknown>): boolean => {
  const succeeded = payload.success !== false && payload.ok !== false;
  if (!succeeded) {
    return false;
  }
  const toolName = typeof payload.toolName === 'string'
    ? payload.toolName
    : typeof payload.tool === 'string' ? payload.tool : undefined;
  if (toolName !== undefined && WORKFLOW_CANONICAL_TOOLS.has(toolName)) {
    return false;
  }
  if (typeof payload.progressKind === 'string') {
    return payload.progressKind === 'canonical';
  }
  return toolName !== undefined && LEGACY_CANONICAL_DISCOVERY_TOOLS.has(toolName);
};

/**
 * D2 — the execution axis is the only one that may count as a failure. `execution` is
 * authoritative when the event carries it; older events fall back to the single-axis
 * fields, which is why an HTTP status code is explicitly not consulted here.
 */
const isExecutionFailure = (
  event: TimelineEvent,
  payload: Record<string, unknown>,
): boolean => {
  if (typeof payload.execution === 'string') {
    return payload.execution !== 'succeeded' && payload.execution !== 'skipped';
  }
  if (event.severity === 'error') {
    return true;
  }
  return payload.outcome === 'failure'
    || payload.outcome === 'error'
    || payload.outcome === 'blocked'
    || payload.success === false;
};

const asPositiveInt = (value: number | undefined, fallback: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));

const severityRank = (severity: string | null | undefined): number => {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    case 'info':
      return 4;
    default:
      return 5;
  }
};

const sortTimelineEvents = (events: TimelineEvent[]): TimelineEvent[] =>
  [...events].sort((left, right) => {
    const leftTs = Date.parse(left.ts);
    const rightTs = Date.parse(right.ts);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    if (typeof left.tsp === 'number' && typeof right.tsp === 'number' && left.tsp !== right.tsp) {
      return left.tsp - right.tsp;
    }
    return left.id.localeCompare(right.id);
  });

const escapeCsv = (value: unknown): string => {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
};

const stringifyNdjson = (events: TimelineEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');

const toIsoString = (value: Date | string | null | undefined): string =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' && value.trim() ? value : new Date(0).toISOString();

const turnFromTurnId = (turnId: string | null | undefined): number => {
  const match = typeof turnId === 'string' ? turnId.match(/\d+/u) : null;
  return match ? Number.parseInt(match[0]!, 10) : 0;
};

const normalizeCsvStringArray = (values: unknown[]): string[] =>
  Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean),
    ),
  );

function resolveRunSessionIds(
  run: RunTraceRunRef,
  additionalSessionIds: ReadonlyArray<string | null | undefined>,
): string[] {
  const currentSessionId = typeof run.sessionId === 'string' && run.sessionId.trim() ? run.sessionId.trim() : null;
  const plannerSessionId =
    typeof run.plannerSessionId === 'string' && run.plannerSessionId.trim() ? run.plannerSessionId.trim() : null;
  const executorSessionId =
    typeof run.executorSessionId === 'string' && run.executorSessionId.trim() ? run.executorSessionId.trim() : null;

  return uniqueStrings([
    plannerSessionId ?? (!executorSessionId ? currentSessionId : null),
    executorSessionId ?? (plannerSessionId && currentSessionId && currentSessionId !== plannerSessionId ? currentSessionId : null),
    currentSessionId,
    ...additionalSessionIds,
  ]);
}

/**
 * The run summary counters, as a pure function so they can be exercised directly. What an
 * operator reads as "this run failed 86 times and discovered nothing" is decided here.
 */
export const computeRunTraceStats = (
events: TimelineEvent[],
sessionCount: number,
): RunTraceStats => {
  const byEvent: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let toolCalls = 0;
  let modelCalls = 0;
  let actions = 0;
  let discoveries = 0;
  let linkedArtifacts = 0;
  let totalTokens = 0;
  let failures = 0;

  for (const event of events) {
    byEvent[event.event] = (byEvent[event.event] ?? 0) + 1;
    bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
    linkedArtifacts += event.links ? Object.keys(event.links).length : 0;
    const payload = asPayloadRecord(event);
    if (event.event === 'tool.finish') {
      toolCalls += 1;
    }
    if (event.event === 'model.call.finish') {
      modelCalls += 1;
      const tokens = isRecord(payload.tokens) ? payload.tokens : undefined;
      totalTokens += typeof tokens?.total === 'number' ? tokens.total : 0;
    }
    if (event.event === 'action.summary') {
      actions += 1;
    }
    // D21 — `discovery` and `finding` are event names nothing in the codebase writes, so
    // this counter reported 0 for a run that mapped hosts, wrote inventory and filed two
    // findings. Count what the run actually produced: emitted discoveries, and successful
    // calls to the tools that write a canonical record.
    if (event.event === 'discovery' || event.event.startsWith('finding')) {
      discoveries += 1;
    } else if (event.event === 'tool.finish' && countsAsCanonicalDiscovery(payload)) {
      discoveries += 1;
    }
    // D2/D21 — only the execution axis may feed a failure counter. A target answering 401
    // or 404 is evidence, not a tool failure; 46 of run r1's 63 recorded failures were
    // ordinary HTTP responses. `execution` is authoritative when present, and the legacy
    // fields are read only for events written before it existed.
    if (isExecutionFailure(event, payload)) {
      failures += 1;
    }
  }

  return {
    events: events.length,
    sessions: sessionCount,
    byEvent,
    bySeverity,
    toolCalls,
    modelCalls,
    actions,
    discoveries,
    linkedArtifacts,
    totalTokens,
    failures,
  };
};

export class RunTraceService {
  private readonly traceRoot: string;

  constructor(private readonly deps: RunTraceServiceDeps) {
    this.traceRoot = deps.traceRoot ?? path.resolve(process.cwd(), 'storage', 'object-store', 'traces');
  }

  async getTraceForRun(run: RunTraceRunRef, query: RunTraceQuery = {}): Promise<RunTraceResponse> {
    const loaded = await this.loadRunEvents(run);
    const filtered = this.filterEvents(loaded.events, query);
    const offset = asPositiveInt(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = asPositiveInt(query.limit, DEFAULT_TRACE_PAGE_LIMIT, TRACE_PAGE_LIMIT_MAX);
    const events = filtered.slice(offset, offset + limit);

    return {
      runId: run.id ?? '',
      sessionIds: loaded.sessionIds,
      generatedAt: new Date().toISOString(),
      events,
      total: filtered.length,
      stats: this.computeStats(filtered, loaded.sessionIds.length),
      summary: this.createSummary(filtered),
      pagination: {
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      },
      integrity: loaded.integrity,
    };
  }

  async getTraceSnapshotForRun(run: RunTraceRunRef): Promise<RunTraceResponse> {
    const loaded = await this.loadRunEvents(run);
    return {
      runId: run.id ?? '',
      sessionIds: loaded.sessionIds,
      generatedAt: new Date().toISOString(),
      events: loaded.events,
      total: loaded.events.length,
      stats: this.computeStats(loaded.events, loaded.sessionIds.length),
      summary: this.createSummary(loaded.events),
      pagination: {
        offset: 0,
        limit: loaded.events.length,
        hasMore: false,
      },
      integrity: loaded.integrity,
    };
  }

  async getBundleEntries(
    run: RunTraceRunRef,
    options: RunTraceBundleOptions = {},
  ): Promise<RunTraceBundleEntry[]> {
    const loaded = await this.loadRunEvents(run);
    const response: RunTraceResponse = {
      runId: run.id ?? '',
      sessionIds: loaded.sessionIds,
      generatedAt: new Date().toISOString(),
      events: loaded.events,
      total: loaded.events.length,
      stats: this.computeStats(loaded.events, loaded.sessionIds.length),
      summary: this.createSummary(loaded.events),
      pagination: {
        offset: 0,
        limit: loaded.events.length,
        hasMore: false,
      },
      integrity: loaded.integrity,
    };

    const reportFindings = await this.loadReportFindings(run, loaded.sessionIds);
    const phaseReplans = await this.loadRunPhaseReplans(run);
    const mode = resolveRunTraceBundleMode(run, options.mode ?? 'forensic');

    if (mode === 'review') {
      return this.buildReviewBundleEntries({
        run,
        response,
        reportFindings,
        phaseReplans,
      });
    }

    return this.buildForensicBundleEntries({
      run,
      response,
      reportFindings,
      phaseReplans,
    });
  }

  private async buildForensicBundleEntries(params: {
    run: RunTraceRunRef;
    response: RunTraceResponse;
    reportFindings: RunTraceReportFindingRecord[];
    phaseReplans: RunTraceDbPhaseReplanRecord[];
  }): Promise<RunTraceBundleEntry[]> {
    const { run, response, reportFindings, phaseReplans } = params;
    const entries: RunTraceBundleEntry[] = [
      { path: 'run_summary.json', content: JSON.stringify(response, null, 2) },
      { path: 'run_summary.md', content: this.createMarkdownSummary(response) },
      { path: 'trace.ndjson', content: stringifyNdjson(response.events) },
      { path: 'trace.md', content: this.createMarkdownTrace(response) },
      { path: 'trace-findings.csv', content: this.createTraceFindingsCsv(response.events) },
      { path: 'report-findings.csv', content: this.createReportFindingsCsv(reportFindings) },
      { path: 'run-phase-replans.json', content: JSON.stringify(phaseReplans, null, 2) },
    ];

    entries.push(...await this.loadPerformanceEntries(run, response));

    for (const sessionId of response.sessionIds) {
      const [traceNdjson, traceMarkdown] = await Promise.all([
        this.readSessionFile(sessionId, 'trace.ndjson'),
        this.readSessionFile(sessionId, 'trace.md'),
      ]);
      const fallbackSessionEvents = response.events.filter(
        (event) => event.sessionId === sessionId && isDbFallbackEvent(event),
      );
      if (traceNdjson) {
        entries.push({ path: `sessions/${sessionId}/trace.ndjson`, content: traceNdjson });
      } else if (fallbackSessionEvents.length > 0) {
        entries.push({ path: `sessions/${sessionId}/trace.ndjson`, content: stringifyNdjson(fallbackSessionEvents) });
      }
      if (traceMarkdown) {
        entries.push({ path: `sessions/${sessionId}/trace.md`, content: traceMarkdown });
      } else if (fallbackSessionEvents.length > 0) {
        entries.push({
          path: `sessions/${sessionId}/trace.md`,
          content: this.createMarkdownTrace({
            ...response,
            sessionIds: [sessionId],
            events: fallbackSessionEvents,
            total: fallbackSessionEvents.length,
            stats: this.computeStats(fallbackSessionEvents, 1),
            summary: this.createSummary(fallbackSessionEvents),
            pagination: {
              offset: 0,
              limit: fallbackSessionEvents.length,
              hasMore: false,
            },
          }),
        });
      }
    }

    entries.push(...await this.readLinkedArtifacts(response.events));
    const closeoutEntries = await this.loadCloseoutArtifacts(run, response.sessionIds);
    entries.push(...closeoutEntries);
    entries.push(...await this.loadComplianceEntries(run, response.sessionIds, closeoutEntries, response));
    return entries;
  }

  private async buildReviewBundleEntries(params: {
    run: RunTraceRunRef;
    response: RunTraceResponse;
    reportFindings: RunTraceReportFindingRecord[];
    phaseReplans: RunTraceDbPhaseReplanRecord[];
  }): Promise<RunTraceBundleEntry[]> {
    const { run, response, reportFindings, phaseReplans } = params;
    const workflowDiscipline = run.workflowDiscipline as RunWorkflowDiscipline;
    const agentTypes = uniqueStrings(response.events.map((event) => {
      const value = asPayloadRecord(event).agentType;
      return typeof value === 'string' ? value : null;
    }));
    const workerTypes = uniqueStrings(response.events.map((event) => {
      const value = asPayloadRecord(event).workerType;
      return typeof value === 'string' ? value : null;
    }));
    const reviewSummary = {
      schemaVersion: 1,
      bundleMode: 'review',
      runId: response.runId,
      workflowDiscipline,
      status: run.status ?? null,
      generatedAt: response.generatedAt,
      timing: {
        startedAt: response.summary.startedAt,
        completedAt: response.summary.completedAt,
        durationMs: response.summary.durationMs,
      },
      participants: {
        sessionIds: response.sessionIds,
        agentRoles: response.summary.roles,
        agentTypes,
        workerTypes,
      },
      stats: response.stats,
      eventTypes: response.summary.eventTypes,
      reportFindings: reportFindings.length,
      phaseReplans: phaseReplans.length,
    };

    const performanceEntries = await this.loadPerformanceEntries(run, response);
    const runPerformanceEntry = performanceEntries.find(
      (entry) => entry.path === 'performance/run-performance.json',
    ) ?? performanceEntries.find(
      (entry) => entry.path === 'performance/run-performance.md',
    );
    const allCloseoutEntries = await this.loadCloseoutArtifacts(run, response.sessionIds);
    const closeoutEntries = allCloseoutEntries.filter((entry) =>
      workflowDiscipline === 'compliance' || !entry.path.endsWith('/.artifacts/report/compliance-context.json'),
    );

    const entries: RunTraceBundleEntry[] = [
      { path: 'review/summary.json', content: JSON.stringify(reviewSummary, null, 2) },
      { path: 'run-phase-replans.json', content: JSON.stringify(phaseReplans, null, 2) },
      { path: 'report-findings.csv', content: this.createReportFindingsCsv(reportFindings) },
      { path: 'trace-findings.csv', content: this.createTraceFindingsCsv(response.events) },
      { path: 'trace.ndjson', content: stringifyNdjson(response.events) },
    ];
    if (runPerformanceEntry) {
      entries.push(runPerformanceEntry);
    }
    entries.push(...closeoutEntries);
    entries.push(...await this.readLinkedArtifacts(response.events));
    if (workflowDiscipline === 'compliance') {
      entries.push(...await this.loadComplianceEntries(
        run,
        response.sessionIds,
        closeoutEntries,
        response,
      ));
    }

    const primaryFiles = entries
      .map((entry) => entry.path)
      .filter((entryPath) => this.isPrimaryReviewFile(entryPath, workflowDiscipline));
    const primaryFileSet = new Set(primaryFiles);
    const supportingFiles = entries
      .map((entry) => entry.path)
      .filter((entryPath) => !primaryFileSet.has(entryPath));
    const reviewIndex = {
      schemaVersion: 1,
      bundleMode: 'review',
      runId: response.runId,
      workflowDiscipline,
      selectionBasis: {
        workflowDiscipline,
        agentRoles: response.summary.roles,
        agentTypes,
        workerTypes,
      },
      primaryFiles,
      supportingFiles,
      fullForensicBundleAvailable: true,
    };

    return [
      {
        path: 'review/README.md',
        content: this.createReviewBundleReadme(workflowDiscipline),
      },
      {
        path: 'review/index.json',
        content: JSON.stringify(reviewIndex, null, 2),
      },
      ...entries,
    ];
  }

  private isPrimaryReviewFile(
    entryPath: string,
    workflowDiscipline: RunWorkflowDiscipline,
  ): boolean {
    if (
      entryPath === 'review/summary.json'
      || entryPath === 'run-phase-replans.json'
      || entryPath === 'report-findings.csv'
      || entryPath === 'trace-findings.csv'
      || entryPath === 'performance/run-performance.json'
      || entryPath === 'performance/run-performance.md'
      || /\/closeout\/[^/]+\/(summary|report)\.md$/u.test(`/${entryPath}`)
    ) {
      return true;
    }
    return workflowDiscipline === 'compliance'
      && entryPath.startsWith('compliance/')
      && !entryPath.includes('/evidence/');
  }

  private createReviewBundleReadme(
    workflowDiscipline: RunWorkflowDiscipline,
  ): string {
    return [
      '# Run Review Bundle',
      '',
      `Workflow: ${workflowDiscipline}`,
      '',
      'This bundle contains the files relevant to this run workflow.',
      'Start with review/index.json and review/summary.json.',
      'Read the final summary, report, findings, replans, and performance summary next.',
      'Open trace.ndjson and linked artifacts only when the review needs detailed proof.',
      '',
      'The merged trace keeps every participating planner, executor, and worker role.',
      'Duplicate trace renderings and per-session trace copies are not included.',
      workflowDiscipline === 'compliance'
        ? 'Compliance proof is included because this is a Compliance run.'
        : 'Compliance proof is not included because this is not a Compliance run.',
      'Use the full forensic bundle when complete raw preservation is required.',
      '',
    ].join('\n');
  }

  private async loadComplianceEntries(
    run: RunTraceRunRef,
    sessionIds: readonly string[],
    closeoutEntries: readonly RunTraceBundleEntry[],
    trace: RunTraceResponse,
  ): Promise<RunTraceBundleEntry[]> {
    if (!this.deps.complianceBundleSource) {
      return [];
    }
    return this.deps.complianceBundleSource.getRunBundleEntries(run, sessionIds, closeoutEntries, trace);
  }

  private async loadCloseoutArtifacts(
    run: RunTraceRunRef,
    sessionIds: readonly string[],
  ): Promise<RunTraceBundleEntry[]> {
    if (!this.deps.closeoutArtifactSource) {
      return [];
    }
    return this.deps.closeoutArtifactSource.listCloseoutArtifacts(run, sessionIds).catch(() => []);
  }

  private async loadPerformanceEntries(
    run: RunTraceRunRef,
    trace: RunTraceResponse,
  ): Promise<RunTraceBundleEntry[]> {
    if (!this.deps.performanceBundleSource) {
      return [];
    }
    return this.deps.performanceBundleSource.getRunBundleEntries(run, trace).catch(() => []);
  }

  private async loadReportFindings(
    run: RunTraceRunRef,
    sessionIds: readonly string[],
  ): Promise<RunTraceReportFindingRecord[]> {
    if (!this.deps.reportFindingsSource) {
      return [];
    }
    const rows = await this.deps.reportFindingsSource.listReportFindings(run, sessionIds).catch(() => []);
    const byId = new Map<string, RunTraceReportFindingRecord>();
    for (const row of rows) {
      if (!row.id || byId.has(row.id)) {
        continue;
      }
      byId.set(row.id, row);
    }
    return Array.from(byId.values()).sort((left, right) => {
      const leftRank = severityRank(left.severity);
      const rightRank = severityRank(right.severity);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.title.localeCompare(right.title);
    });
  }

  private async loadRunPhaseReplans(run: RunTraceRunRef): Promise<RunTraceDbPhaseReplanRecord[]> {
    if (!run.id || !this.deps.dbFallbackSource?.listRunPhaseReplans) {
      return [];
    }
    return this.deps.dbFallbackSource.listRunPhaseReplans(run.id).catch(() => []);
  }

  private async loadRunEvents(run: RunTraceRunRef): Promise<{
    sessionIds: string[];
    events: TimelineEvent[];
    integrity: RunTraceResponse['integrity'];
  }> {
    const phases =
      run.id && this.deps.phaseSource
        ? await this.deps.phaseSource.listByRunId(run.id).catch(() => [])
        : [];
    const additionalSessionIds =
      run.id && typeof this.deps.sessionResolver?.listIdsByRunId === 'function'
        ? await this.deps.sessionResolver.listIdsByRunId(run.id).catch(() => [])
        : [];
    const sessionIds = resolveRunSessionIds(run, [
      ...additionalSessionIds,
      ...phases.map((phase) => phase.sessionId ?? null),
    ]);
    const phaseBySessionId = new Map(
      phases
        .filter((phase) => typeof phase.sessionId === 'string' && phase.sessionId.trim().length > 0)
        .map((phase) => [phase.sessionId as string, phase.id]),
    );

    const pages = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const events = await this.deps.timelineService.getAllEvents(sessionId, 'hydrated').catch(() => []);
        return {
          sessionId,
          events: events.map((event) => ({
            ...event,
            runId: event.runId ?? run.id ?? undefined,
            phaseId: event.phaseId ?? phaseBySessionId.get(event.sessionId),
            agentRole: event.agentRole ?? this.inferAgentRole(run, event.sessionId),
          })),
        };
      }),
    );
    const traceEvents = pages.flatMap((page) => page.events);
    const fallbackEvents = await this.loadDbFallbackEvents({
      run,
      sessionIds,
      pages,
      phaseBySessionId,
    });
    const integritySessions = await Promise.all(pages.map(async (page): Promise<TraceIntegrityResult> => {
      const stored = await this.deps.integritySource?.find(page.sessionId).catch(() => null);
      if (stored && isTraceIntegrityResult(stored.integrityDetails)) {
        return stored.integrityDetails;
      }
      const observedHighWater = page.events.reduce(
        (maximum, event) => Math.max(maximum, event.acceptedOrdinal ?? 0),
        0,
      );
      return reconcileTraceIntegrity({
        sessionId: page.sessionId,
        acceptedHighWater: stored?.acceptedHighWater ?? observedHighWater,
        persistedHighWater: stored?.persistedHighWater ?? observedHighWater,
        terminalReceipt: false,
      });
    }));

    return {
      sessionIds,
      events: sortTimelineEvents([...traceEvents, ...fallbackEvents]),
      integrity: {
        status: aggregateIntegrityStatus(integritySessions),
        sessions: integritySessions,
      },
    };
  }

  private async loadDbFallbackEvents(params: {
    run: RunTraceRunRef;
    sessionIds: string[];
    pages: Array<{ sessionId: string; events: TimelineEvent[] }>;
    phaseBySessionId: Map<string, string>;
  }): Promise<TimelineEvent[]> {
    const source = this.deps.dbFallbackSource;
    if (!source) {
      return [];
    }

    const fallbackSessionIds = params.pages
      .filter((page) => page.events.length === 0)
      .map((page) => page.sessionId);
    const events: TimelineEvent[] = [];

    if (fallbackSessionIds.length > 0) {
      const toolRecords = await source.listToolExecutionRecords(fallbackSessionIds).catch(() => []);
      for (const record of toolRecords) {
        events.push(this.toolExecutionRecordToEvent(params.run, record, params.phaseBySessionId));
      }
    }

    if (params.run.id) {
      const sessionId = params.run.sessionId ?? params.sessionIds[0] ?? 'run';
      const runEvents = await source.listRunEvents(params.run.id).catch(() => []);
      for (const record of runEvents) {
        events.push({
          schemaVersion: 2,
          id: `db-run-event:${record.id}`,
          sessionId,
          runId: params.run.id,
          agentRole: this.inferAgentRole(params.run, sessionId),
          turn: 0,
          ts: toIsoString(record.createdAt),
          event: 'run.event',
          severity: ['failed', 'cancelled'].includes(record.type) ? 'error' : 'info',
          payload: {
            source: 'db.run_events',
            type: record.type,
            note: record.note ?? null,
            fallback: true,
          },
          note: record.note ?? `run event: ${record.type}`,
        });
      }
    }

    return events;
  }

  private toolExecutionRecordToEvent(
    run: RunTraceRunRef,
    record: RunTraceDbToolExecutionRecord,
    phaseBySessionId: Map<string, string>,
  ): TimelineEvent {
    const success = record.status === 'completed' || record.status === 'succeeded';
    return {
      schemaVersion: 2,
      id: `db-tool:${record.id}`,
      sessionId: record.sessionId,
      runId: run.id ?? undefined,
      agentRole: this.inferAgentRole(run, record.sessionId),
      phaseId: phaseBySessionId.get(record.sessionId),
      turn: turnFromTurnId(record.turnId),
      ts: toIsoString(record.completedAt ?? record.startedAt ?? record.claimedAt),
      event: 'tool.finish',
      severity: success ? 'info' : 'error',
      payload: {
        source: 'db.tool_execution_records',
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        status: record.status,
        args: record.args ?? null,
        result: record.result ?? null,
        durationMs: record.durationMs ?? null,
        error: record.error ?? null,
        success,
        outcome: success ? 'success' : 'failure',
        fallback: true,
      },
      note: `db fallback ${record.toolName} ${record.status}`,
    };
  }

  private inferAgentRole(run: RunTraceRunRef, sessionId: string): string | undefined {
    if (sessionId === run.plannerSessionId) {
      return 'planner';
    }
    if (sessionId === run.executorSessionId || sessionId === run.sessionId) {
      return 'executor';
    }
    return undefined;
  }

  private filterEvents(events: TimelineEvent[], query: RunTraceQuery): TimelineEvent[] {
    let filtered = events;
    if (query.types?.length) {
      const types = new Set(query.types);
      filtered = filtered.filter((event) => types.has(event.event));
    }
    if (query.severity?.length) {
      const severity = new Set(query.severity);
      filtered = filtered.filter((event) => severity.has(event.severity));
    }
    if (query.includeDebug !== true) {
      filtered = filtered.filter((event) => event.severity !== 'debug');
    }
    if (query.search?.trim()) {
      const search = query.search.trim().toLowerCase();
      filtered = filtered.filter((event) => {
        const payload = asPayloadRecord(event);
        return [
          event.event,
          event.note,
          event.agentRole,
          payload.action,
          payload.summary,
          payload.toolName,
          payload.name,
          payload.outcomeReason,
        ]
          .filter((value) => typeof value === 'string')
          .some((value) => String(value).toLowerCase().includes(search));
      });
    }
    return filtered;
  }

  private computeStats(events: TimelineEvent[], sessionCount: number): RunTraceStats {
    return computeRunTraceStats(events, sessionCount);
  }

  private createSummary(events: TimelineEvent[]): RunTraceResponse['summary'] {
    const sorted = sortTimelineEvents(events);
    const startedAt = sorted[0]?.ts ?? null;
    const completedAt = sorted[sorted.length - 1]?.ts ?? null;
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    const completedMs = completedAt ? Date.parse(completedAt) : NaN;
    return {
      startedAt,
      completedAt,
      durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null,
      eventTypes: Object.keys(this.computeStats(events, 0).byEvent).sort(),
      roles: uniqueStrings(events.map((event) => event.agentRole)),
    };
  }

  private createMarkdownSummary(response: RunTraceResponse): string {
    return [
      `# Run Trace Summary`,
      '',
      `Run: ${response.runId || 'unknown'}`,
      'Corpus unit: run',
      `Session projection: ${response.sessionIds.length === 1 ? response.sessionIds[0] : `${response.sessionIds.length} sessions`}`,
      `Generated: ${response.generatedAt}`,
      `Sessions: ${response.sessionIds.length}`,
      `Events: ${response.stats.events}`,
      `Tool calls: ${response.stats.toolCalls}`,
      `Model calls: ${response.stats.modelCalls}`,
      `Actions: ${response.stats.actions}`,
      `Discoveries: ${response.stats.discoveries}`,
      `Failures: ${response.stats.failures}`,
      `Total tokens: ${response.stats.totalTokens}`,
      `Evidence integrity: ${response.integrity.status}`,
      '',
    ].join('\n');
  }

  private createMarkdownTrace(response: RunTraceResponse): string {
    const lines = [
      `# Run Trace`,
      '',
      `Run: ${response.runId || 'unknown'}`,
      'Corpus unit: run',
      `Session projection: ${response.sessionIds.length === 1 ? response.sessionIds[0] : `${response.sessionIds.length} sessions`}`,
      'File unit: trace event',
      `Generated: ${response.generatedAt}`,
      '',
      '## Timeline',
      '',
    ];
    for (const event of response.events) {
      const role = event.agentRole ? ` role=${event.agentRole}` : '';
      const phase = event.phaseId ? ` phase=${event.phaseId}` : '';
      const worker = event.workerTaskId ? ` worker=${event.workerTaskId}` : '';
      const note = event.note ? ` ${event.note}` : '';
      lines.push(`- ${event.ts} [${event.severity}] ${event.event} session=${event.sessionId} turn=${event.turn}${role}${phase}${worker}${note}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private createTraceFindingsCsv(events: TimelineEvent[]): string {
    const rows = [['ts', 'event', 'category', 'key', 'summary', 'confidence', 'sessionId', 'sourceToolCallId']];
    for (const event of events) {
      if (event.event !== 'discovery' && event.event !== 'finding') {
        continue;
      }
      const payload = asPayloadRecord(event);
      rows.push([
        event.ts,
        event.event,
        String(payload.category ?? ''),
        String(payload.key ?? ''),
        String(payload.summary ?? event.note ?? ''),
        String(payload.confidence ?? ''),
        event.sessionId,
        String(payload.sourceToolCallId ?? ''),
      ]);
    }
    return rows.map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
  }

  private createReportFindingsCsv(findings: RunTraceReportFindingRecord[]): string {
    const rows = [[
      'id',
      'title',
      'severity',
      'state',
      'assetKind',
      'assetValue',
      'dedupeKey',
      'lastSeenAt',
      'summary',
      'businessImpact',
      'technicalAnalysis',
      'pocDescription',
      'assumptions',
      'remediation',
      'fixEffort',
      'cweIds',
      'owaspCategory',
      'cvssScore',
      'cvssVector',
      'missingReportFields',
      'advisoryMissingFields',
    ]];
    for (const finding of findings) {
      const reportCompleteness = buildFindingReportCompleteness(finding);
      const cweIds = normalizeCsvStringArray([
        ...(Array.isArray(finding.cweIds) ? finding.cweIds : []),
        finding.cweId,
      ]);
      rows.push([
        finding.id,
        finding.title,
        finding.severity,
        finding.state,
        finding.assetKind ?? '',
        finding.assetValue ?? '',
        finding.dedupeKey ?? '',
        finding.lastSeenAt ? toIsoString(finding.lastSeenAt) : '',
        finding.summary ?? '',
        finding.businessImpact ?? '',
        finding.technicalAnalysis ?? '',
        finding.pocDescription ?? '',
        finding.assumptions ?? '',
        finding.remediation ?? '',
        finding.fixEffort ?? '',
        cweIds.join(';'),
        finding.owaspCategory ?? '',
        finding.cvssScore === null || finding.cvssScore === undefined ? '' : String(finding.cvssScore),
        finding.cvssVector ?? '',
        reportCompleteness.missingReportFields.join(';'),
        reportCompleteness.advisoryMissingFields.join(';'),
      ]);
    }
    return rows.map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
  }

  private async readSessionFile(sessionId: string, fileName: 'trace.ndjson' | 'trace.md'): Promise<Buffer | null> {
    if (this.deps.s3Client) {
      return this.deps.s3Client.getObjectBuffer(`${sessionId}/${fileName}`).catch(() => null);
    }
    const sessionRoot = path.resolve(process.cwd(), this.traceRoot, sessionId);
    const filePath = path.resolve(sessionRoot, fileName);
    if (!filePath.startsWith(sessionRoot + path.sep)) {
      return null;
    }
    return fs.readFile(filePath).catch(() => null);
  }

  private async readLinkedArtifacts(events: TimelineEvent[]): Promise<RunTraceBundleEntry[]> {
    const entries: RunTraceBundleEntry[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (!event.links) {
        continue;
      }
      for (const relativePath of Object.values(event.links)) {
        if (!relativePath || relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
          continue;
        }
        const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const key = `${event.sessionId}:${normalizedRelative}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const content = await this.readArtifact(event.sessionId, normalizedRelative);
        if (!content) {
          continue;
        }
        entries.push({
          path: `artifacts/${event.sessionId}/${normalizedRelative}`,
          content,
        });
      }
    }
    return entries;
  }

  private async readArtifact(sessionId: string, relativePath: string): Promise<Buffer | null> {
    if (this.deps.s3Client) {
      return this.deps.s3Client.getObjectBuffer(`${sessionId}/${relativePath}`).catch(() => null);
    }
    const sessionRoot = path.resolve(process.cwd(), this.traceRoot, sessionId);
    const artifactPath = path.resolve(sessionRoot, relativePath);
    if (!artifactPath.startsWith(sessionRoot + path.sep)) {
      return null;
    }
    return fs.readFile(artifactPath).catch(() => null);
  }
}
