import type { TimelineEvent, TimelineResponse } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import type { ActionOutcome, ActionSummaryPayload } from '@/domains/agent-brain/infrastructure/telemetry/types';

type RunActivityStatusBand = '2xx' | '3xx' | '4xx' | '5xx' | 'mixed' | 'none';
type RunActivityDistributionKey = '2xx' | '3xx' | '4xx' | '5xx' | 'unknown';
type RunActivityResponseTimeKey = 'lt_100ms' | '100_500ms' | '500_1000ms' | '1_3s' | '3s_plus';

interface TimelineServicePort {
  getActionSummaries(
    sessionId: string,
    options?: { offset?: number; limit?: number },
  ): Promise<TimelineResponse>;
  getTimeline?(
    sessionId: string,
    options?: { offset?: number; limit?: number; types?: string[] },
  ): Promise<TimelineResponse>;
}

export interface RunActivitySummary {
  totals: {
    requests: number;
    uniqueHosts: number;
    uniqueEndpoints: number;
    failures: number;
    blockedActions: number;
    averageDurationMs: number | null;
  };
  distributions: {
    statusCodes: Array<{ key: string; label: string; count: number; percentage: number }>;
    methods: Array<{ key: string; label: string; count: number; percentage: number }>;
    responseTimes: Array<{ key: string; label: string; count: number; percentage: number }>;
    contentTypes: Array<{ key: string; label: string; count: number; percentage: number }>;
  };
  timeline: {
    buckets: Array<{ ts: string; hosts: Array<{ host: string; count: number }> }>;
    hosts: string[];
  };
  topEndpoints: Array<{
    id: string;
    host: string;
    path: string;
    requestCount: number;
    failureCount: number;
    methods: Array<{ method: string; count: number }>;
    statusBand: RunActivityStatusBand;
  }>;
  topHosts: Array<{
    host: string;
    requestCount: number;
    failureCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  }>;
  discoveries: Array<{
    category: string;
    key: string;
    summary: string;
    confidence: number;
    ts: string;
    outcome: 'success' | 'failure' | 'neutral';
  }>;
  operatorActivity: Array<{
    ts: string;
    action: string;
    rationale: string;
    evidenceProduced: string;
    nextStep: string;
    outcome: 'success' | 'failure' | 'neutral';
    source: string;
  }>;
  authSurface: Array<{
    host: string;
    path: string;
    methods: string[];
    statusCodes: number[];
    requestCount: number;
  }>;
  securityHeaders: {
    totalEndpoints: number;
    missingHeaders: Array<{ header: string; missingCount: number; percentage: number }>;
  };
  coverage: {
    source: 'action.summary' | 'action.summary+http_capture';
    limitations: string[];
  };
  phases: RunPhaseTimelineEntry[];
  generatedAt: string;
}

export type RunPhaseSymbol =
  | 'recon'
  | 'enumeration'
  | 'validation'
  | 'exploitation'
  | 'evidence'
  | 'control_assessment'
  | 'reporting'
  | 'review_mapping'
  | 'review_analysis'
  | 'review_validation'
  | 'review_reporting';
export type RunPhaseDisplayStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface RunPhaseTimelineEntry {
  phase: RunPhaseSymbol;
  label: string;
  ordinal: number;
  status: RunPhaseDisplayStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  reason?: string | null;
  validationProgress?: { total: number; completed: number; pending: number };
}

// Backwards-compatible aliases (deprecated; will be removed once UI migrates).
export type AttackPhaseSymbol = RunPhaseSymbol;
export type AttackPhase = RunPhaseTimelineEntry;

export interface RunActivityRunRef {
  id?: string | null;
  sessionId?: string | null;
  plannerSessionId?: string | null;
  executorSessionId?: string | null;
  status?: string | null;
}

interface RunActivitySessionResolverPort {
  listIdsByRunId?(runId: string): Promise<string[]>;
}

export interface RunPhaseSourceRow {
  id: string;
  phaseKey: string;
  ordinal: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError?: string | null;
}

export interface RunPhaseSourcePort {
  listByRunId(runId: string): Promise<RunPhaseSourceRow[]>;
}

export interface ValidationQueueRow {
  phaseId: string | null;
  status: string;
}

export interface ValidationQueueSourcePort {
  listByRunId(runId: string): Promise<ValidationQueueRow[]>;
}

interface HttpActionTelemetry {
  ts: string;
  tsMs: number;
  method: string;
  host: string;
  path: string;
  statusCode: number | null;
  contentType: string | null;
  durationMs: number;
  outcome: ActionOutcome;
  rawHeaders: string;
}

export interface ProxyCaptureEvent {
  ts: string;
  method: string;
  host: string;
  path: string;
  statusCode: number | null;
  contentType: string | null;
  durationMs: number;
  rawResponseHeaders: string;
}

export interface ProxyCaptureSourcePort {
  listEventsForSessions(sessionIds: readonly string[]): Promise<ProxyCaptureEvent[]>;
}

interface EndpointAccumulator {
  id: string;
  host: string;
  path: string;
  requestCount: number;
  failureCount: number;
  methods: Map<string, number>;
  statusBands: Set<Exclude<RunActivityStatusBand, 'mixed' | 'none'>>;
}

interface HostAccumulator {
  host: string;
  requestCount: number;
  failureCount: number;
  firstSeenAt: string | null;
  firstSeenMs: number | null;
  lastSeenAt: string | null;
  lastSeenMs: number | null;
}

const ACTION_SUMMARY_PAGE_LIMIT = 500;
const TOP_ENDPOINT_LIMIT = 10;
const TOP_HOST_LIMIT = 8;
const TIMELINE_HOST_LIMIT = 6;
const OPERATOR_ACTIVITY_LIMIT = 25;
const COVERAGE_LIMITATIONS = [
  'Coverage combines action.summary telemetry with http_payload history and sandbox proxy capture when available; older runs may only have summarized action telemetry.',
];

function createEmptySummary(generatedAt: string): RunActivitySummary {
  return {
    totals: {
      requests: 0,
      uniqueHosts: 0,
      uniqueEndpoints: 0,
      failures: 0,
      blockedActions: 0,
      averageDurationMs: null,
    },
    distributions: {
      statusCodes: [],
      methods: [],
      responseTimes: [],
      contentTypes: [],
    },
    timeline: {
      buckets: [],
      hosts: [],
    },
    topEndpoints: [],
    topHosts: [],
    discoveries: [],
    operatorActivity: [],
    authSurface: [],
    securityHeaders: { totalEndpoints: 0, missingHeaders: [] },
    coverage: {
      source: 'action.summary',
      limitations: [...COVERAGE_LIMITATIONS],
    },
    phases: [],
    generatedAt,
  };
}

function resolveActivitySessionIds(
  run: RunActivityRunRef,
  additionalSessionIds: readonly string[] = [],
): string[] {
  const currentSessionId =
    typeof run.sessionId === 'string' && run.sessionId.trim().length > 0
      ? run.sessionId.trim()
      : null;
  const explicitPlannerSessionId =
    typeof run.plannerSessionId === 'string' && run.plannerSessionId.trim().length > 0
      ? run.plannerSessionId.trim()
      : null;
  const explicitExecutorSessionId =
    typeof run.executorSessionId === 'string' && run.executorSessionId.trim().length > 0
      ? run.executorSessionId.trim()
      : null;

  const plannerSessionId =
    explicitPlannerSessionId ?? (!explicitExecutorSessionId ? currentSessionId : null);
  const executorSessionId =
    explicitExecutorSessionId ??
    (explicitPlannerSessionId && currentSessionId && currentSessionId !== explicitPlannerSessionId
      ? currentSessionId
      : null);

  return Array.from(
    new Set(
      [plannerSessionId, executorSessionId, currentSessionId, ...additionalSessionIds]
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function asActionSummaryPayload(payload: unknown): ActionSummaryPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<ActionSummaryPayload>;
  if (typeof candidate.action !== 'string') return null;
  if (typeof candidate.outcome !== 'string') return null;
  if (typeof candidate.durationMs !== 'number' || Number.isNaN(candidate.durationMs)) return null;
  return candidate as ActionSummaryPayload;
}

function parseHttpAction(action: string): { method: string; host: string; path: string } | null {
  const match = action.trim().match(/^([A-Z]+)\s+(\S+)$/i);
  if (!match) return null;

  const method = match[1]?.toUpperCase();
  const urlValue = match[2];
  if (!method || !urlValue) return null;

  try {
    const parsedUrl = new URL(urlValue);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }

    return {
      method,
      host: parsedUrl.host.toLowerCase(),
      path: parsedUrl.pathname?.trim() || '/',
    };
  } catch {
    return null;
  }
}

function toIsoTimestamp(value: string): { iso: string; ms: number } | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return {
    iso: new Date(ms).toISOString(),
    ms,
  };
}

function isFailureOutcome(outcome: ActionOutcome, statusCode: number | null): boolean {
  if (statusCode !== null && statusCode >= 400) return true;
  return outcome === 'failure' || outcome === 'error' || outcome === 'timeout';
}

function toStatusDistributionKey(statusCode: number | null): RunActivityDistributionKey {
  if (statusCode === null) return 'unknown';
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return 'unknown';
}

function toEndpointStatusBand(
  bands: Set<Exclude<RunActivityStatusBand, 'mixed' | 'none'>>,
): RunActivityStatusBand {
  if (bands.size === 0) return 'none';
  if (bands.size === 1) return bands.values().next().value as Exclude<RunActivityStatusBand, 'mixed' | 'none'>;
  return 'mixed';
}

function toResponseTimeKey(durationMs: number): RunActivityResponseTimeKey {
  if (durationMs < 100) return 'lt_100ms';
  if (durationMs < 500) return '100_500ms';
  if (durationMs < 1_000) return '500_1000ms';
  if (durationMs < 3_000) return '1_3s';
  return '3s_plus';
}

function roundPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}

function mapDistribution(
  counts: Map<string, number>,
  options?: { labels?: Record<string, string> },
): Array<{ key: string; label: string; count: number; percentage: number }> {
  const entries = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return entries.map(([key, count]) => ({
    key,
    label: options?.labels?.[key] ?? key,
    count,
    percentage: total > 0 ? roundPercentage((count / total) * 100) : 0,
  }));
}

function compareHostsByTraffic(
  left: Pick<HostAccumulator, 'host' | 'requestCount'>,
  right: Pick<HostAccumulator, 'host' | 'requestCount'>,
): number {
  return right.requestCount - left.requestCount || left.host.localeCompare(right.host);
}

function buildTimeline(
  events: HttpActionTelemetry[],
  hosts: string[],
  overrideStartMs?: number | null,
  overrideEndMs?: number | null,
): RunActivitySummary['timeline'] {
  if (events.length === 0 || hosts.length === 0) {
    return { buckets: [], hosts: [] };
  }

  const sortedEvents = [...events].sort((left, right) => left.tsMs - right.tsMs);
  const bucketCount =
    sortedEvents.length <= 1
      ? 1
      : Math.min(12, Math.max(2, Math.ceil(Math.sqrt(sortedEvents.length))));
  
  const startMs = overrideStartMs ?? sortedEvents[0].tsMs;
  const endMs = overrideEndMs ?? sortedEvents[sortedEvents.length - 1].tsMs;
  const bucketSeeds = Array.from({ length: bucketCount }, (_, index) => ({
    ts:
      bucketCount === 1
        ? sortedEvents[0].ts
        : new Date(startMs + ((endMs - startMs) * index) / (bucketCount - 1)).toISOString(),
    counts: new Map<string, number>(),
  }));

  for (const event of sortedEvents) {
    if (!hosts.includes(event.host)) continue;
    const bucketIndex =
      bucketCount === 1 || endMs === startMs
        ? 0
        : Math.min(
            bucketCount - 1,
            Math.round(((event.tsMs - startMs) / (endMs - startMs)) * (bucketCount - 1)),
          );
    const currentCount = bucketSeeds[bucketIndex].counts.get(event.host) ?? 0;
    bucketSeeds[bucketIndex].counts.set(event.host, currentCount + 1);
  }

  return {
    hosts,
    buckets: bucketSeeds.map((bucket) => ({
      ts: bucket.ts,
      hosts: hosts
        .map((host) => ({ host, count: bucket.counts.get(host) ?? 0 }))
        .filter((entry) => entry.count > 0),
    })),
  };
}

function extractHttpActionTelemetry(events: TimelineEvent[]): HttpActionTelemetry[] {
  const telemetry: HttpActionTelemetry[] = [];

  for (const event of events) {
    const payload = asActionSummaryPayload(event.payload);
    if (!payload) continue;

    const timestamp = toIsoTimestamp(event.ts);
    if (!timestamp) continue;

    const action = parseHttpAction(payload.action);
    if (!action) continue;

    telemetry.push({
      ts: timestamp.iso,
      tsMs: timestamp.ms,
      method: action.method,
      host: action.host,
      path: action.path,
      statusCode: typeof payload.statusCode === 'number' ? payload.statusCode : null,
      contentType: typeof payload.contentType === 'string' ? payload.contentType : null,
      durationMs: payload.durationMs,
      outcome: payload.outcome,
      rawHeaders: '',
    });
  }

  return telemetry;
}

const CONTENT_TYPE_LABELS: Record<string, string> = {
  'text/html': 'HTML',
  'application/json': 'JSON',
  'application/javascript': 'JS',
  'text/javascript': 'JS',
  'text/css': 'CSS',
  'text/xml': 'XML',
  'application/xml': 'XML',
  'text/plain': 'Text',
  'application/octet-stream': 'Binary',
  'application/pdf': 'PDF',
  'application/x-www-form-urlencoded': 'Form',
  'multipart/form-data': 'Form',
};

function toContentTypeLabel(raw: string): string {
  const ct = raw.split(';')[0].trim().toLowerCase();
  if (CONTENT_TYPE_LABELS[ct]) return CONTENT_TYPE_LABELS[ct];
  if (ct.startsWith('image/')) return 'Image';
  if (ct.startsWith('font/') || ct.includes('woff')) return 'Font';
  if (ct.startsWith('video/')) return 'Video';
  if (ct.startsWith('audio/')) return 'Audio';
  return ct;
}

interface DiscoveryEventPayload {
  category?: string;
  key?: string;
  summary?: string;
  confidence?: number;
}

function extractDiscoveries(events: TimelineEvent[]): RunActivitySummary['discoveries'] {
  const seen = new Set<string>();
  const discoveries: RunActivitySummary['discoveries'] = [];

  for (const event of events) {
    if (event.event !== 'discovery' && event.event !== 'finding') continue;
    const payload = (event.payload as DiscoveryEventPayload) || {};
    const key = payload.key ?? event.ts;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    discoveries.push({
      category: payload.category ?? (event.event === 'finding' ? 'vulnerability' : 'data'),
      key,
      summary: payload.summary ?? (event.event === 'finding' ? 'Vulnerability identified' : 'New discovery identified'),
      confidence: payload.confidence ?? 1.0,
      ts: event.ts,
      outcome: event.event === 'finding' ? 'success' : 'neutral',
    });
  }
  return discoveries;
}

const compactText = (value: string, maxLength = 180): string => {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function inferActionRationale(payload: ActionSummaryPayload): string {
  const tool = payload.tool.toLowerCase();
  if (tool.includes('http') || parseHttpAction(payload.action)) return 'Collect request and response evidence from the target surface.';
  if (tool.includes('report_finding')) return 'Record a candidate finding from observed evidence.';
  if (tool.includes('promote_finding')) return 'Promote durable evidence to the reportable finding set.';
  if (tool.includes('report_finalizer_preflight')) return 'Check final/interim closeout readiness before report drafting.';
  if (tool.includes('prepare_report_context')) return 'Package canonical run state for authored reporting.';
  if (tool.includes('finalize_run_artifacts')) return 'Validate authored closeout artifacts against canonical run state.';
  if (tool.includes('report_note')) return 'Persist run evidence, coverage, blocker, or digest context for operators and future planning.';
  if (tool.includes('spawn_worker')) return 'Delegate a bounded mission to improve coverage, confidence, or speed.';
  return `Execute ${payload.tool} for the current mission.`;
}

function inferEvidenceProduced(payload: ActionSummaryPayload): string {
  if (payload.finding) return compactText(payload.finding);
  const status = typeof payload.statusCode === 'number' ? `HTTP ${payload.statusCode}` : '';
  const contentType = typeof payload.contentType === 'string' ? payload.contentType : '';
  const pieces = [status, contentType, payload.outcomeReason].filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  );
  return pieces.length > 0 ? compactText(pieces.join(' - ')) : 'Action telemetry recorded.';
}

function inferNextStep(payload: ActionSummaryPayload): string {
  if (payload.outcome === 'blocked') return 'Record the blocker or choose a non-overlapping path.';
  if (payload.outcome === 'failure' || payload.outcome === 'error' || payload.outcome === 'timeout') {
    return 'Change the hypothesis, inputs, or stop condition before retrying.';
  }
  const tool = payload.tool.toLowerCase();
  if (tool.includes('report_finding')) return 'Validate evidence and call promote_finding only if the reportable gate is met.';
  if (tool.includes('promote_finding')) return 'Keep synthesis aligned to the promoted finding and dedupe state.';
  if (tool.includes('report_finalizer_preflight')) return 'Use finalizer preflight to choose final or interim closeout.';
  if (tool.includes('prepare_report_context')) return 'Author summary.md and report.md from the prepared report context.';
  if (tool.includes('finalize_run_artifacts')) return 'Review the validated summary.md and report.md artifacts.';
  return 'Continue the current mission until the stop condition is met.';
}

function extractOperatorActivity(events: TimelineEvent[]): RunActivitySummary['operatorActivity'] {
  const rows: RunActivitySummary['operatorActivity'] = [];
  const sortedEvents = [...events].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));

  for (const event of sortedEvents) {
    const timestamp = toIsoTimestamp(event.ts);
    if (!timestamp) continue;

    const actionPayload = asActionSummaryPayload(event.payload);
    if (actionPayload) {
      rows.push({
        ts: timestamp.iso,
        action: compactText(actionPayload.action || actionPayload.tool),
        rationale: inferActionRationale(actionPayload),
        evidenceProduced: inferEvidenceProduced(actionPayload),
        nextStep: inferNextStep(actionPayload),
        outcome: actionPayload.outcome === 'success' ? 'success' : actionPayload.outcome === 'skipped' ? 'neutral' : 'failure',
        source: actionPayload.tool,
      });
      continue;
    }

    const payload = asRecord(event.payload);
    if (event.event === 'workbench.action') {
      const action = typeof payload?.action === 'string' ? payload.action : 'workbench action';
      const result = typeof payload?.result === 'string' ? payload.result : 'recorded';
      rows.push({
        ts: timestamp.iso,
        action: compactText(`Workbench ${action}`),
        rationale: 'Record an operator workbench intervention or routing decision.',
        evidenceProduced: typeof payload?.targetSessionId === 'string'
          ? `target session ${payload.targetSessionId}`
          : 'Workbench action trace recorded.',
        nextStep: action === 'redirect'
          ? 'Open the active phase session before dispatching more work.'
          : action === 'pause'
            ? 'Resume only when the operator is ready for the agent to continue.'
            : 'Continue from the updated workbench state.',
        outcome: result === 'rejected' ? 'failure' : result === 'offered' ? 'neutral' : 'success',
        source: 'workbench.action',
      });
      continue;
    }

    if (event.event === 'discovery' || event.event === 'finding') {
      const summary = typeof payload?.summary === 'string'
        ? payload.summary
        : event.event === 'finding'
          ? 'Finding identified'
          : 'Discovery recorded';
      rows.push({
        ts: timestamp.iso,
        action: compactText(summary),
        rationale: event.event === 'finding' ? 'Surface a notable vulnerability signal.' : 'Surface a notable discovery from run evidence.',
        evidenceProduced: typeof payload?.key === 'string' ? payload.key : event.event,
        nextStep: event.event === 'finding'
          ? 'Record or promote only after the evidence floor is met.'
          : 'Use the discovery to narrow the next mission.',
        outcome: event.event === 'finding' ? 'success' : 'neutral',
        source: event.event,
      });
      continue;
    }

    if (event.event.startsWith('worker.') || event.event === 'securityops.phase_transition') {
      rows.push({
        ts: timestamp.iso,
        action: compactText(event.note ?? event.event),
        rationale: event.event.startsWith('worker.')
          ? 'Coordinate bounded specialist execution.'
          : 'Record an advisory posture change.',
        evidenceProduced: typeof payload?.summary === 'string' ? compactText(payload.summary) : 'Trace event recorded.',
        nextStep: event.event.startsWith('worker.')
          ? 'Synthesize worker artifacts before duplicating work.'
          : 'Continue from the new posture only if evidence supports it.',
        outcome: event.severity === 'warn' || event.severity === 'error' ? 'failure' : 'neutral',
        source: event.event,
      });
    }
  }

  return rows.slice(-OPERATOR_ACTIVITY_LIMIT);
}

const PHASE_LABELS: Record<RunPhaseSymbol, string> = {
  recon: 'Recon',
  enumeration: 'Enumeration',
  validation: 'Validation',
  exploitation: 'Exploitation',
  evidence: 'Evidence',
  control_assessment: 'Control assessment',
  reporting: 'Reporting',
  review_mapping: 'Review mapping',
  review_analysis: 'Review analysis',
  review_validation: 'Review validation',
  review_reporting: 'Review reporting',
};

const CANONICAL_PHASE_KEYS = new Set<RunPhaseSymbol>([
  'recon',
  'enumeration',
  'validation',
  'exploitation',
  'evidence',
  'control_assessment',
  'reporting',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
]);

const TERMINAL_PHASE_RAW_STATUSES = new Set([
  'completed',
  'blocked',
  'failed',
  'timed_out',
  'aborted',
]);

function deriveDisplayStatus(rawStatus: string, lastError?: string | null): RunPhaseDisplayStatus {
  if (
    rawStatus === 'completed' &&
    typeof lastError === 'string' &&
    lastError.startsWith('controlled_exploitation_skipped:')
  ) {
    return 'skipped';
  }
  switch (rawStatus) {
    case 'pending':
      return 'pending';
    case 'active':
    case 'handoff_submitted':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed_out':
    case 'aborted':
      return 'failed';
    case 'blocked':
      return 'failed';
    default:
      return 'pending';
  }
}

function projectPhaseRows(
  rows: ReadonlyArray<RunPhaseSourceRow>,
  validationProgressByPhaseId: ReadonlyMap<string, { total: number; completed: number; pending: number }>,
  runStatus?: string | null,
): RunPhaseTimelineEntry[] {
  const completedRun = runStatus === 'completed';
  const terminalRunStatus = runStatus === 'cancelled' || runStatus === 'failed' ? runStatus : null;
  return rows
    .filter((row) => CANONICAL_PHASE_KEYS.has(row.phaseKey as RunPhaseSymbol))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => {
      const phase = row.phaseKey as RunPhaseSymbol;
      let rawStatus = row.status;
      if (completedRun && !TERMINAL_PHASE_RAW_STATUSES.has(row.status)) {
        rawStatus = 'completed';
      } else if (terminalRunStatus && !TERMINAL_PHASE_RAW_STATUSES.has(row.status)) {
        rawStatus = terminalRunStatus === 'cancelled' ? 'aborted' : 'failed';
      }
      const status = deriveDisplayStatus(rawStatus, row.lastError);
      const startedAt = row.startedAt ? row.startedAt.toISOString() : null;
      const completedAt = row.completedAt ? row.completedAt.toISOString() : null;
      const durationMs =
        row.startedAt && row.completedAt
          ? Math.max(0, row.completedAt.getTime() - row.startedAt.getTime())
          : null;
      const entry: RunPhaseTimelineEntry = {
        phase,
        label: PHASE_LABELS[phase],
        ordinal: row.ordinal,
        status,
        startedAt,
        completedAt,
        durationMs,
        reason:
          status === 'skipped' && typeof row.lastError === 'string'
            ? row.lastError.replace(/^controlled_exploitation_skipped:/u, '')
            : row.lastError ?? null,
      };
      if (phase === 'validation') {
        const progress = validationProgressByPhaseId.get(row.id);
        if (progress) {
          entry.validationProgress = progress;
        }
      }
      return entry;
    });
}

export function buildRunActivitySummaryFromEvents(
  events: TimelineEvent[],
  proxyEvents: readonly HttpActionTelemetry[] = [],
): RunActivitySummary {
  const generatedAt = new Date().toISOString();
  const actionHttpEvents = extractHttpActionTelemetry(events);
  const httpEvents = dedupeHttpEvents([...actionHttpEvents, ...proxyEvents]);
  const operatorActivity = extractOperatorActivity(events);

  const proxyTs = proxyEvents.map((e) => e.tsMs).filter((ts) => Number.isFinite(ts));
  const allTs = [
    ...events.map((e) => new Date(e.ts).getTime()).filter((ts) => !Number.isNaN(ts)),
    ...proxyTs,
  ];
  const minTs = allTs.length > 0 ? Math.min(...allTs) : null;
  const maxTs = allTs.length > 0 ? Math.max(...allTs) : null;

  if (httpEvents.length === 0) {
    return {
      ...createEmptySummary(generatedAt),
      operatorActivity,
    };
  }

  const hostCounts = new Map<string, HostAccumulator>();
  const endpointCounts = new Map<string, EndpointAccumulator>();
  const statusCounts = new Map<string, number>();
  const methodCounts = new Map<string, number>();
  const responseTimeCounts = new Map<string, number>();
  const contentTypeCounts = new Map<string, number>();

  // Auth surface: track endpoints returning 401/403
  const authEndpoints = new Map<string, { host: string; path: string; methods: Set<string>; statusCodes: Set<number>; count: number }>();

  // Security headers: track missing security headers per endpoint
  const SECURITY_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options'];
  const SECURITY_HEADER_LABELS: Record<string, string> = {
    'strict-transport-security': 'HSTS',
    'content-security-policy': 'CSP',
    'x-frame-options': 'X-Frame-Options',
    'x-content-type-options': 'X-Content-Type-Options',
  };
  const headerPresenceCounts = new Map<string, number>();
  for (const h of SECURITY_HEADERS) headerPresenceCounts.set(h, 0);
  let endpointsWithHeaders = 0;
  const endpointsAuditedForHeaders = new Set<string>();

  let failures = 0;
  let blockedActions = 0;
  let totalDurationMs = 0;

  for (const event of httpEvents) {
    const endpointId = `${event.host}${event.path}`;
    const requestFailed = isFailureOutcome(event.outcome, event.statusCode);

    totalDurationMs += event.durationMs;
    if (requestFailed) failures++;
    if (event.outcome === 'blocked') blockedActions++;

    statusCounts.set(
      toStatusDistributionKey(event.statusCode),
      (statusCounts.get(toStatusDistributionKey(event.statusCode)) ?? 0) + 1,
    );
    methodCounts.set(event.method, (methodCounts.get(event.method) ?? 0) + 1);
    responseTimeCounts.set(
      toResponseTimeKey(event.durationMs),
      (responseTimeCounts.get(toResponseTimeKey(event.durationMs)) ?? 0) + 1,
    );

    // Content type distribution
    if (event.contentType) {
      const ct = toContentTypeLabel(event.contentType);
      contentTypeCounts.set(ct, (contentTypeCounts.get(ct) ?? 0) + 1);
    }

    // Auth surface: track endpoints returning 401/403
    if (event.statusCode === 401 || event.statusCode === 403) {
      const authEntry = authEndpoints.get(endpointId) ?? {
        host: event.host,
        path: event.path,
        methods: new Set<string>(),
        statusCodes: new Set<number>(),
        count: 0,
      };
      authEntry.methods.add(event.method);
      authEntry.statusCodes.add(event.statusCode);
      authEntry.count += 1;
      authEndpoints.set(endpointId, authEntry);
    }

    // Security headers audit only counts endpoints with captured raw response
    // headers. Summarized action telemetry alone cannot prove headers missing.
    if (event.rawHeaders && !endpointsAuditedForHeaders.has(endpointId)) {
      endpointsAuditedForHeaders.add(endpointId);
      endpointsWithHeaders++;
      const headersLower = event.rawHeaders.toLowerCase();
      for (const h of SECURITY_HEADERS) {
        if (headersLower.includes(h + ':')) {
          headerPresenceCounts.set(h, (headerPresenceCounts.get(h) ?? 0) + 1);
        }
      }
    }

    const endpoint = endpointCounts.get(endpointId) ?? {
      id: endpointId,
      host: event.host,
      path: event.path,
      requestCount: 0,
      failureCount: 0,
      methods: new Map<string, number>(),
      statusBands: new Set<Exclude<RunActivityStatusBand, 'mixed' | 'none'>>(),
    };
    endpoint.requestCount += 1;
    if (requestFailed) endpoint.failureCount += 1;
    endpoint.methods.set(event.method, (endpoint.methods.get(event.method) ?? 0) + 1);
    const statusBand = toStatusDistributionKey(event.statusCode);
    if (statusBand !== 'unknown') {
      endpoint.statusBands.add(statusBand);
    }
    endpointCounts.set(endpointId, endpoint);

    const host = hostCounts.get(event.host) ?? {
      host: event.host,
      requestCount: 0,
      failureCount: 0,
      firstSeenAt: null,
      firstSeenMs: null,
      lastSeenAt: null,
      lastSeenMs: null,
    };
    host.requestCount += 1;
    if (requestFailed) host.failureCount += 1;
    if (host.firstSeenMs === null || event.tsMs < host.firstSeenMs) {
      host.firstSeenMs = event.tsMs;
      host.firstSeenAt = event.ts;
    }
    if (host.lastSeenMs === null || event.tsMs > host.lastSeenMs) {
      host.lastSeenMs = event.tsMs;
      host.lastSeenAt = event.ts;
    }
    hostCounts.set(event.host, host);
  }

  // Extract discoveries from timeline events
  const discoveries = extractDiscoveries(events);

  const sortedHosts = [...hostCounts.values()].sort(compareHostsByTraffic);
  const timelineHosts = sortedHosts.slice(0, TIMELINE_HOST_LIMIT).map((host) => host.host);

  // Build security headers audit. Do not fall back to all endpoints when no
  // raw headers were captured; that would turn unknown into 100% missing.
  const totalEp = endpointsWithHeaders;
  const missingHeaders =
    totalEp > 0
      ? SECURITY_HEADERS
          .map((h) => {
            const present = headerPresenceCounts.get(h) ?? 0;
            const missing = Math.max(0, totalEp - present);
            return {
              header: SECURITY_HEADER_LABELS[h] ?? h,
              missingCount: missing,
              percentage: roundPercentage((missing / totalEp) * 100),
            };
          })
          .sort((a, b) => b.missingCount - a.missingCount)
      : [];

  return {
    totals: {
      requests: httpEvents.length,
      uniqueHosts: hostCounts.size,
      uniqueEndpoints: endpointCounts.size,
      failures,
      blockedActions,
      averageDurationMs: httpEvents.length > 0 ? Math.round(totalDurationMs / httpEvents.length) : null,
    },
    distributions: {
      statusCodes: mapDistribution(statusCounts, {
        labels: {
          unknown: 'Unknown',
        },
      }),
      methods: mapDistribution(methodCounts),
      responseTimes: mapDistribution(responseTimeCounts, {
        labels: {
          lt_100ms: '<100ms',
          '100_500ms': '100-500ms',
          '500_1000ms': '500ms-1s',
          '1_3s': '1-3s',
          '3s_plus': '3s+',
        },
      }),
      contentTypes: mapDistribution(contentTypeCounts),
    },
    timeline: buildTimeline(httpEvents, timelineHosts, minTs, maxTs),
    topEndpoints: [...endpointCounts.values()]
      .sort((left, right) =>
        right.requestCount - left.requestCount ||
        right.failureCount - left.failureCount ||
        left.path.localeCompare(right.path) ||
        left.host.localeCompare(right.host))
      .slice(0, TOP_ENDPOINT_LIMIT)
      .map((endpoint) => ({
        id: endpoint.id,
        host: endpoint.host,
        path: endpoint.path,
        requestCount: endpoint.requestCount,
        failureCount: endpoint.failureCount,
        methods: [...endpoint.methods.entries()]
          .map(([method, count]) => ({ method, count }))
          .sort((left, right) => right.count - left.count || left.method.localeCompare(right.method)),
        statusBand: toEndpointStatusBand(endpoint.statusBands),
      })),
    topHosts: sortedHosts
      .slice(0, TOP_HOST_LIMIT)
      .map((host) => ({
        host: host.host,
        requestCount: host.requestCount,
        failureCount: host.failureCount,
        firstSeenAt: host.firstSeenAt,
        lastSeenAt: host.lastSeenAt,
      })),
    discoveries,
    operatorActivity,
    authSurface: [...authEndpoints.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_ENDPOINT_LIMIT)
      .map((e) => ({
        host: e.host,
        path: e.path,
        methods: [...e.methods],
        statusCodes: [...e.statusCodes].sort(),
        requestCount: e.count,
      })),
    securityHeaders: { totalEndpoints: totalEp, missingHeaders },
    coverage: {
      source: proxyEvents.length > 0 ? 'action.summary+http_capture' : 'action.summary',
      limitations: [...COVERAGE_LIMITATIONS],
    },
    phases: [],
    generatedAt,
  };
}

export interface RunActivityServiceDeps {
  timelineService: TimelineServicePort;
  sessionResolver?: RunActivitySessionResolverPort;
  phaseSource?: RunPhaseSourcePort;
  validationQueueSource?: ValidationQueueSourcePort;
  proxyCaptureSource?: ProxyCaptureSourcePort;
}

function proxyEventToTelemetry(entry: ProxyCaptureEvent): HttpActionTelemetry | null {
  const tsMs = Date.parse(entry.ts);
  if (Number.isNaN(tsMs)) return null;
  return {
    ts: entry.ts,
    tsMs,
    method: entry.method.toUpperCase(),
    host: entry.host.toLowerCase(),
    path: entry.path || '/',
    statusCode: entry.statusCode,
    contentType: entry.contentType,
    durationMs: Math.max(0, entry.durationMs ?? 0),
    outcome: 'success',
    rawHeaders: entry.rawResponseHeaders ?? '',
  };
}

function dedupeHttpEvents(entries: readonly HttpActionTelemetry[]): HttpActionTelemetry[] {
  // De-dup captured entries against agent-emitted action.summary entries that describe the
  // same exchange (same method+host+path within a 250ms window). Prefer the entry with
  // a non-empty rawHeaders (http_payload history/proxy capture has redacted response
  // headers; agent-emitted action.summary often does not).
  const sorted = [...entries].sort((a, b) => a.tsMs - b.tsMs);
  const kept: HttpActionTelemetry[] = [];
  for (const entry of sorted) {
    const overlap = kept.find(
      (existing) =>
        existing.method === entry.method &&
        existing.host === entry.host &&
        existing.path === entry.path &&
        Math.abs(existing.tsMs - entry.tsMs) < 250,
    );
    if (!overlap) {
      kept.push(entry);
      continue;
    }
    if (overlap.rawHeaders.length === 0 && entry.rawHeaders.length > 0) {
      const idx = kept.indexOf(overlap);
      kept[idx] = entry;
    }
  }
  return kept;
}

const VALIDATION_TERMINAL_STATUSES = new Set([
  'validated',
  'false_positive',
  'cancelled',
]);

function summarizeValidationQueue(
  rows: ReadonlyArray<ValidationQueueRow>,
): Map<string, { total: number; completed: number; pending: number }> {
  const acc = new Map<string, { total: number; completed: number; pending: number }>();
  for (const row of rows) {
    if (!row.phaseId) continue;
    const entry = acc.get(row.phaseId) ?? { total: 0, completed: 0, pending: 0 };
    entry.total += 1;
    if (VALIDATION_TERMINAL_STATUSES.has(row.status)) {
      entry.completed += 1;
    } else {
      entry.pending += 1;
    }
    acc.set(row.phaseId, entry);
  }
  return acc;
}

export class RunActivityService {
  constructor(private readonly deps: RunActivityServiceDeps) {}

  async getSummaryForRun(run: RunActivityRunRef): Promise<RunActivitySummary> {
    const additionalSessionIds =
      run.id && typeof this.deps.sessionResolver?.listIdsByRunId === 'function'
        ? await this.deps.sessionResolver.listIdsByRunId(run.id)
        : [];
    const sessionIds = resolveActivitySessionIds(run, additionalSessionIds);
    const phases = await this.loadPhaseTimeline(run.id ?? null, run.status ?? null);

    if (sessionIds.length === 0) {
      const empty = createEmptySummary(new Date().toISOString());
      return { ...empty, phases };
    }

    const [pages, proxyEvents] = await Promise.all([
      Promise.all(sessionIds.map((sessionId) => this.readAllActionSummaries(sessionId))),
      this.loadProxyCaptureEvents(sessionIds),
    ]);
    const summary = buildRunActivitySummaryFromEvents(pages.flat(), proxyEvents);
    return { ...summary, phases };
  }

  private async loadProxyCaptureEvents(sessionIds: readonly string[]): Promise<HttpActionTelemetry[]> {
    if (!this.deps.proxyCaptureSource || sessionIds.length === 0) return [];
    try {
      const events = await this.deps.proxyCaptureSource.listEventsForSessions(sessionIds);
      return events
        .map(proxyEventToTelemetry)
        .filter((entry): entry is HttpActionTelemetry => entry !== null);
    } catch {
      return [];
    }
  }

  private async loadPhaseTimeline(runId: string | null, runStatus: string | null): Promise<RunPhaseTimelineEntry[]> {
    if (!runId || !this.deps.phaseSource) {
      return [];
    }
    try {
      const [phaseRows, queueRows] = await Promise.all([
        this.deps.phaseSource.listByRunId(runId),
        this.deps.validationQueueSource?.listByRunId(runId) ?? Promise.resolve([]),
      ]);
      const validationProgress = summarizeValidationQueue(queueRows);
      return projectPhaseRows(phaseRows, validationProgress, runStatus);
    } catch {
      return [];
    }
  }

  private async readAllActionSummaries(sessionId: string): Promise<TimelineEvent[]> {
    // Pull action.summary plus discovery + finding events so the activity dashboard
    // can render real Discoveries instead of always showing zero. Falls back to the
    // narrow getActionSummaries call when the port does not expose getTimeline.
    if (typeof this.deps.timelineService.getTimeline === 'function') {
      return this.readAllTimelineEvents(sessionId, ['action.summary', 'discovery', 'finding']);
    }

    const events: TimelineEvent[] = [];
    let offset = 0;
    while (true) {
      const page = await this.deps.timelineService.getActionSummaries(sessionId, {
        offset,
        limit: ACTION_SUMMARY_PAGE_LIMIT,
      });
      events.push(...page.events);
      if (!page.pagination.hasMore || page.events.length === 0) break;
      offset += page.pagination.limit;
    }
    return events;
  }

  private async readAllTimelineEvents(sessionId: string, types: string[]): Promise<TimelineEvent[]> {
    const fetchPage = this.deps.timelineService.getTimeline;
    if (!fetchPage) return [];
    const events: TimelineEvent[] = [];
    let offset = 0;
    while (true) {
      const page = await fetchPage.call(this.deps.timelineService, sessionId, {
        offset,
        limit: ACTION_SUMMARY_PAGE_LIMIT,
        types,
      });
      events.push(...page.events);
      if (!page.pagination.hasMore || page.events.length === 0) break;
      offset += page.pagination.limit;
    }
    return events;
  }
}
