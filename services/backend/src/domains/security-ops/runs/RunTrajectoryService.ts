import { createHash } from 'node:crypto';

import type { TimelineEvent, TimelineService } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import type {
  TraceIntegrityResult,
  TraceIntegrityStatus,
} from '@/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';
import type { RunTraceRunRef } from '@/domains/security-ops/runs/RunTraceService';

export const RUN_TRAJECTORY_SCHEMA = 'run-trajectory/v1' as const;
export const TRAJECTORY_RECORD_SCHEMA = 'trajectory-record/v1' as const;

export const TRAJECTORY_KINDS = [
  'input',
  'request',
  'response',
  'tool',
  'context',
  'retry',
  'harness',
  'worker',
  'terminal',
] as const;

export type TrajectoryKind = (typeof TRAJECTORY_KINDS)[number];
export const TRAJECTORY_SIGNIFICANCE = ['primary', 'detail'] as const;

export type TrajectorySignificance = (typeof TRAJECTORY_SIGNIFICANCE)[number];

/** Provider-reported tokens for one model step. Absent fields were not reported. */
export interface TrajectoryTokens {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

/**
 * Where a record sits inside the millisecond it happened in.
 *
 * Every ledger stamps a time, and the projection orders by it — but several
 * records of one step routinely share a millisecond, and a tie broken by a
 * random v4 UUID is how "the second thing you said" came out first. This is the
 * causal order of one step, used only when the clock cannot separate two rows.
 */
const PHASE = {
  input: 0,
  context: 1,
  request: 2,
  attempt: 3,
  response: 4,
  toolInvoke: 5,
  toolResult: 6,
  trace: 7,
  terminal: 9,
} as const;

/**
 * One chronological scale shared by every ledger.
 *
 * Each source used to number its own records its own way — trace events by
 * `acceptedOrdinal` (1, 2, 3…), requests by `turn * 10_000`, tools by the same
 * again — so a comparison across two ledgers was meaningless and the sort fell
 * into strata: every trace event, then every message, then every attempt, then
 * every answer. A conversation came out as four blocks, which is exactly how it
 * read on the page. Time is the only scale they all share.
 */
const chronoOrdinal = (
  timestamp: Date | string | null | undefined,
  phase: number,
): number | undefined => {
  if (timestamp === null || timestamp === undefined) return undefined;
  const ms = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);
  return Number.isFinite(ms) ? ms * 10 + phase : undefined;
};

export type TrajectoryIntegrityStatus = TraceIntegrityStatus;

export interface TrajectorySessionRow {
  id: string;
  agentType: string;
  metadata: Record<string, unknown>;
  completed: boolean;
  blockedReason: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface TrajectoryMessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
}

export interface TrajectoryRequestRow {
  requestId: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  turn: number;
  callOrdinal: number;
  routeReason: string;
  provider: string;
  model: string;
  transformationRefs: string[];
  contextMeasurementRefs: string[];
  digest: string;
  createdAt: Date | string;
  envelope: Record<string, unknown>;
}

export interface TrajectoryContextRow {
  transactionId: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  turn: number;
  status: string;
  reducerProfile: string;
  reason: string;
  intent: string;
  inputMessageIds: string[];
  beforeMeasurement?: unknown;
  replacementSummary: string | null;
  replacementMessageId: string | null;
  afterMeasurement?: unknown;
  triggerRequestId: string | null;
  createdAt: Date | string;
  activatedAt: Date | string | null;
}

export interface TrajectoryAttemptRow {
  id: string;
  sessionId: string | null;
  turn: number | null;
  logicalCallKey: string;
  modelRequestId: string | null;
  attemptOrdinal: number;
  callOrdinal: number;
  providerRequestId: string | null;
  provider: string;
  reportedModel: string | null;
  requestStartedAt: Date | string;
  requestCompletedAt: Date | string | null;
  status: string;
  errorClass: string | null;
  retryDecision: string | null;
  backoffMs: number | null;
  promptTokens?: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface TrajectoryToolRow {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  modelRequestId: string | null;
  args: Record<string, unknown> | null;
  result: unknown;
  status: string;
  claimedAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  durationMs: number | null;
  error: string | null;
}

export interface RunTrajectoryLedgerSnapshot {
  sessions: TrajectorySessionRow[];
  messages: TrajectoryMessageRow[];
  requests: TrajectoryRequestRow[];
  contexts: TrajectoryContextRow[];
  attempts: TrajectoryAttemptRow[];
  tools: TrajectoryToolRow[];
}

export interface RunTrajectoryLedgerSource {
  load(runId: string, sessionIds: readonly string[]): Promise<RunTrajectoryLedgerSnapshot>;
}

interface RunTrajectorySessionResolver {
  listIdsByRunId?(runId: string): Promise<string[]>;
}

export interface RunTrajectoryPhaseRow {
  id: string;
  phaseKey: string;
  ordinal: number;
  sessionId?: string | null;
}

interface RunTrajectoryPhaseSource {
  listByRunId(runId: string): Promise<RunTrajectoryPhaseRow[]>;
}

interface RunTrajectoryIntegritySource {
  find(sessionId: string): Promise<{
    acceptedHighWater: number;
    persistedHighWater: number;
    integrityStatus: string;
    integrityDetails: unknown;
  } | null>;
}

type TimelineServicePort = Pick<TimelineService, 'getAllEvents'>;

export interface RunTrajectoryServiceDeps {
  timelineService: TimelineServicePort;
  ledgerSource: RunTrajectoryLedgerSource;
  sessionResolver?: RunTrajectorySessionResolver;
  phaseSource?: RunTrajectoryPhaseSource;
  integritySource?: RunTrajectoryIntegritySource;
  now?: () => Date;
}

export interface TrajectorySourceLink {
  ledger: string;
  id: string;
  detailRef: string;
  artifactRef?: string;
}

export interface TrajectoryRecord {
  schema: typeof TRAJECTORY_RECORD_SCHEMA;
  id: string;
  kind: TrajectoryKind;
  runId: string;
  sessionId: string;
  turn?: number;
  /**
   * The harness's step: one model call and everything it set in motion.
   *
   * A turn is not a flat list of records. It is a sequence of steps — the model
   * is asked, it answers, it calls tools, the results come back and it is asked
   * again — and that is the unit a reader skips over. The harness has always
   * known which step a record belongs to. The projection used to publish it on
   * the request and the context transformation and nowhere else, so every
   * surface downstream had to re-derive step boundaries by asking which records
   * happened to sit next to each other.
   *
   * Adjacency is the wrong answer, and it gets worse as a run gets more
   * interesting. Records are emitted in clock order, so a slow tool call from
   * step 1 that returns after step 2 has already spoken lands *after* it, and
   * anything grouping by adjacency files it under a step that never made it.
   * Concurrency makes that routine rather than rare.
   *
   * So it is carried on every record that belongs to a step: the answer, the
   * calls, the retries, the transformation, and the request itself.
   */
  stepId?: string;
  /**
   * Which model call of its turn this was — 1, 2, 3.
   *
   * `stepId` says which step; this says where it sits. It is the harness's own
   * `callOrdinal`, so "Step 2" means the second time the model was asked in
   * this turn, and not the second group a renderer happened to open.
   */
  stepOrdinal?: number;
  requestId?: string;
  attemptId?: string;
  attemptOrdinal?: number;
  toolCallId?: string;
  toolName?: string;
  hierarchy: {
    phaseId?: string;
    phaseKey?: string;
    workerTaskId?: string;
    parentSessionId?: string;
    agentRole?: string;
  };
  causality: {
    parentIds: string[];
    rootId: string;
    siblingOrder: 'ordered' | 'unordered';
    relation: string;
  };
  order: {
    sessionOrdinal: number;
    sourceOrdinal?: number;
    scope: 'session';
  };
  presentation: {
    timestamp: string | null;
  };
  /**
   * Whether a reader should see this record before asking for it.
   *
   * The projection is complete on purpose — `sourceCounts` reconciliation
   * depends on every source record having a projected one, so nothing may be
   * dropped. But completeness and readability are different jobs, and conflating
   * them produced a page whose first fifteen rows were the same sandbox
   * container id: true, reconciled, and worthless to read.
   *
   * `primary` is what happened. `detail` is how it was carried out.
   */
  significance: TrajectorySignificance;
  status: string;
  durationMs: number | null;
  summary: string;
  /**
   * Tool records only: the call's arguments, each value already truncated.
   *
   * Kept apart from `summary` because a reader scans a tool call by *what it
   * was* — the path, the query, the skill's name — and one argument answers
   * that while the JSON envelope around it buries the row. A summary that
   * inlined the whole args object turned every `file_write` into a screenful of
   * the file it wrote. The reader picks the argument that matters for the
   * family of tool this is; the projection does not decide that for it.
   */
  args?: Record<string, unknown>;
  /**
   * What the provider charged for this step.
   *
   * Lives on the record that *is* the step — the assistant's answer — and not
   * only on the attempt underneath it. A reader asking "what did this turn
   * cost" is looking at the answer, and making them open a provider attempt to
   * find out is the projection describing its own tables again.
   */
  tokens?: TrajectoryTokens;
  /** Response records only: dispatch to first token, in ms. */
  ttftMs?: number;
  /**
   * Response records only: the model's own reasoning, when the provider
   * returned it, truncated for the list.
   *
   * It has been recorded on `agent_messages.metadata.provider_reasoning` since
   * the Anthropic provider landed and no surface has ever shown it. The whole
   * of it is on the record's detail.
   */
  thinking?: string;
  /** Response records only: the calls this turn made, by tool call id. */
  toolCallIds?: string[];
  integrity: TrajectoryIntegrityStatus;
  source: TrajectorySourceLink;
  links?: {
    sourceRequestRecordId?: string;
    replacementMessageSourceId?: string;
    transformationRecordIds?: string[];
  };
}

export interface RunTrajectoryQuery {
  sessionIds?: string[];
  hierarchy?: string[];
  kinds?: TrajectoryKind[];
  /** Omitted means every record. A reader almost always wants `['primary']`. */
  significance?: TrajectorySignificance[];
  statuses?: string[];
  requestId?: string;
  tool?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface RunTrajectoryIssue {
  code: string;
  status: 'degraded' | 'failed';
  recordId?: string;
  detail: string;
}

export interface RunTrajectoryResponse {
  schema: typeof RUN_TRAJECTORY_SCHEMA;
  runId: string;
  generatedAt: string;
  records: TrajectoryRecord[];
  sessionIds: string[];
  groups: Array<{
    sessionId: string;
    phaseId?: string;
    phaseKey?: string;
    parentSessionId?: string;
    agentRole?: string;
    total: number;
  }>;
  total: number;
  cursor: {
    next: string | null;
    hasMore: boolean;
  };
  ordering: {
    scope: 'partial';
    sessionOrder: 'causal_then_source';
    crossSessionOrder: 'none';
    timestampsAreCausal: false;
  };
  integrity: {
    status: TrajectoryIntegrityStatus;
    issues: RunTrajectoryIssue[];
    sessions: TraceIntegrityResult[];
    sourceCounts: Record<string, { source: number; projected: number }>;
  };
  corpus: {
    runUnit: 'run';
    sessionUnit: 'session';
    fileUnit: 'source-record';
    sessions: number;
    sourceRecords: number;
    traceEvents: number;
    projectedRecords: number;
    projectedBytes: number;
    projectionMs: number;
    numericGates: {
      events: 15_000;
      bytes: 26_214_400;
      p95ProjectionMs: 1_000;
      cacheRequired: boolean;
      deeperIndexingRequired: boolean;
    };
  };
}

export interface RunTrajectoryDetailResponse {
  schema: 'run-trajectory-detail/v1';
  runId: string;
  record: TrajectoryRecord;
  detail: unknown;
  hydration: 'strict' | 'ledger';
}

interface DraftRecord extends Omit<TrajectoryRecord, 'causality' | 'order' | 'integrity'> {
  parentIds: string[];
  relation: string;
  sourceOrdinal?: number;
  /**
   * The source's own sequence, used only when two records share a millisecond
   * and a phase — a trace event's accepted ordinal, an attempt's ordinal. Below
   * this there is nothing left but the record id, which is a random UUID.
   */
  tieBreak?: number;
  integrity?: TrajectoryIntegrityStatus;
}

interface ProjectionDetail {
  detail: unknown;
  traceEventId?: string;
}

interface ProjectionSnapshot {
  records: TrajectoryRecord[];
  details: Map<string, ProjectionDetail>;
  sessionIds: string[];
  phases: RunTrajectoryPhaseRow[];
  sessions: TrajectorySessionRow[];
  integrity: RunTrajectoryResponse['integrity'];
  sourceRecords: number;
  traceEvents: number;
}

interface CursorState {
  schema: 'run-trajectory-cursor/v1';
  runId: string;
  fingerprint: string;
  seenRecordIds: Record<string, string[]>;
}

const KIND_RANK: Record<TrajectoryKind, number> = {
  input: 0,
  context: 1,
  request: 2,
  retry: 3,
  response: 4,
  tool: 5,
  worker: 6,
  harness: 7,
  terminal: 8,
};

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const asIso = (value: Date | string | null | undefined): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * A `from`/`to` bound the caller sent, or no bound at all.
 *
 * An unparseable bound falls back to the infinity, which is what the previous
 * `Number.isFinite(from) && …` guards did in effect. It is stated here so the
 * filter can ask one question — "is a bound in play?" — instead of re-deriving
 * it from a NaN at every comparison.
 */
const parseTimeBound = (value: string | undefined, unbounded: number): number => {
  if (!value) return unbounded;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : unbounded;
};

const durationBetween = (
  startedAt: Date | string | null | undefined,
  completedAt: Date | string | null | undefined,
): number | null => {
  const started = asIso(startedAt);
  const completed = asIso(completedAt);
  if (!started || !completed) return null;
  return Math.max(0, Date.parse(completed) - Date.parse(started));
};

const parseTurn = (turnId: string): number | undefined => {
  const match = turnId.match(/\d+/u);
  return match ? Number.parseInt(match[0]!, 10) : undefined;
};

const unique = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));

const requestIdFromMessage = (message: TrajectoryMessageRow): string | undefined =>
  asString(message.metadata.modelRequestId)
  ?? asString(message.metadata.requestId)
  ?? asString(isRecord(message.metadata.model) ? message.metadata.model.requestId : undefined);

const parentSessionIdFromMetadata = (metadata: Record<string, unknown>): string | undefined => {
  const coordination = isRecord(metadata.coordination) ? metadata.coordination : undefined;
  return asString(coordination?.parentSessionId) ?? asString(metadata.parentSessionId);
};

const terminalStatus = (session: TrajectorySessionRow): string | null => {
  if (session.completed) return 'completed';
  if (session.blockedReason) return 'blocked';
  const flags = isRecord(session.metadata.flags) ? session.metadata.flags : undefined;
  const sessionFlags = isRecord(flags?.session) ? flags.session : undefined;
  return sessionFlags?.completed === true ? 'completed' : null;
};

const roleForSession = (run: RunTraceRunRef, session: TrajectorySessionRow): string => {
  if (session.id === run.plannerSessionId) return 'planner';
  if (session.id === run.executorSessionId || session.id === run.sessionId) return 'executor';
  return session.agentType || 'worker';
};

const traceRecordId = (event: TimelineEvent): string => `trace:${event.sessionId}:${event.id}`;
const inputRecordId = (messageId: string): string => `input:${messageId}`;
const responseRecordId = (messageId: string): string => `response:${messageId}`;
const requestRecordId = (requestId: string): string => `request:${requestId}`;
const retryRecordId = (attemptId: string): string => `retry:${attemptId}`;
const contextRecordId = (transactionId: string): string => `context:${transactionId}`;
const toolInvokeRecordId = (toolId: string): string => `tool:${toolId}:invoke`;
const toolResultRecordId = (toolId: string): string => `tool:${toolId}:result`;
const terminalRecordId = (sessionId: string): string => `terminal:${sessionId}`;

const detailRef = (runId: string, recordId: string): string =>
  `/api/admin/runs/${encodeURIComponent(runId)}/trajectory/${encodeURIComponent(recordId)}/detail`;

const aggregateStatus = (statuses: TrajectoryIntegrityStatus[]): TrajectoryIntegrityStatus =>
  statuses.includes('failed') ? 'failed' : statuses.includes('degraded') ? 'degraded' : 'complete';

const parseIntegrityResult = (
  sessionId: string,
  stored: Awaited<ReturnType<RunTrajectoryIntegritySource['find']>>,
): TraceIntegrityResult => {
  const details = isRecord(stored?.integrityDetails) ? stored.integrityDetails : {};
  const candidate = isRecord(details.result) ? details.result : details;
  if (
    candidate.schema === 'trace-integrity/v1'
    && candidate.sessionId === sessionId
    && (candidate.status === 'complete' || candidate.status === 'degraded' || candidate.status === 'failed')
    && Array.isArray(candidate.issues)
    && isRecord(candidate.surfaces)
  ) {
    return candidate as unknown as TraceIntegrityResult;
  }
  const status: TraceIntegrityStatus = stored?.integrityStatus === 'complete'
    || stored?.integrityStatus === 'failed'
    ? stored.integrityStatus
    : 'degraded';
  return {
    schema: 'trace-integrity/v1',
    sessionId,
    status,
    acceptedHighWater: stored?.acceptedHighWater ?? 0,
    persistedHighWater: stored?.persistedHighWater ?? 0,
    issues: status === 'complete' ? [] : [{
      surface: 'trace_events',
      code: 'trace_index_projection',
      detail: stored ? 'Stored E6 detail was unavailable.' : 'No E6 trace index was found.',
    }],
    surfaces: {
      model_requests: 'not_observed',
      provider_attempts: 'not_observed',
      tool_executions: 'not_observed',
      messages: 'not_observed',
      trace_events: status,
      artifacts: 'not_observed',
      terminal_receipt: 'not_observed',
    },
  };
};

const cursorFingerprint = (query: RunTrajectoryQuery): string => {
  const normalized = {
    sessionIds: [...(query.sessionIds ?? [])].sort(),
    hierarchy: [...(query.hierarchy ?? [])].sort(),
    kinds: [...(query.kinds ?? [])].sort(),
    statuses: [...(query.statuses ?? [])].sort(),
    requestId: query.requestId ?? null,
    tool: query.tool ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
};

const encodeCursor = (cursor: CursorState): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (value: string | undefined, runId: string, fingerprint: string): CursorState => {
  if (!value) {
    return { schema: 'run-trajectory-cursor/v1', runId, fingerprint, seenRecordIds: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid trajectory cursor');
  }
  if (
    !isRecord(parsed)
    || parsed.schema !== 'run-trajectory-cursor/v1'
    || parsed.runId !== runId
    || parsed.fingerprint !== fingerprint
    || !isRecord(parsed.seenRecordIds)
  ) {
    throw new Error('Trajectory cursor does not match this run or filter set');
  }
  const seenRecordIds: Record<string, string[]> = {};
  for (const [sessionId, recordIds] of Object.entries(parsed.seenRecordIds)) {
    if (!Array.isArray(recordIds) || recordIds.some((recordId) => typeof recordId !== 'string')) {
      throw new Error('Invalid trajectory cursor record set');
    }
    seenRecordIds[sessionId] = unique(recordIds as string[]);
  }
  return { schema: 'run-trajectory-cursor/v1', runId, fingerprint, seenRecordIds };
};

const eventArtifactRef = (event: TimelineEvent): string | undefined =>
  event.artifactRef
  ?? Object.values(event.links ?? {}).find((value) => typeof value === 'string' && value.trim());

const eventRequestId = (event: TimelineEvent): string | undefined => {
  if (event.requestId) return event.requestId;
  const payload = isRecord(event.payload) ? event.payload : {};
  return asString(payload.modelRequestId) ?? asString(payload.requestId);
};

const eventToolCallId = (event: TimelineEvent): string | undefined => {
  if (event.toolCallId) return event.toolCallId;
  const payload = isRecord(event.payload) ? event.payload : {};
  return asString(payload.toolCallId);
};

/**
 * Collapse any value into one readable line.
 *
 * The projection used to write a *label* where the content belonged — every user
 * message read `User input accepted`, every assistant message read `Assistant
 * response accepted`, and the text was only reachable through a second request
 * per record. A stream of four hundred labels is not a trace of anything; it is
 * a list of the tables it came from.
 */
const previewText = (value: unknown, limit = 260): string => {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : safeJson(value);
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/**
 * A tool call's arguments, flattened to one shallow object of short strings.
 *
 * Two jobs. It bounds the payload — a `file_write` carries the whole file in
 * `content`, and the list response is not where a file belongs. And it keeps the
 * shape a reader can index into, so the page can show the *path* of a write
 * rather than the first 140 characters of the JSON that contained it.
 */
const previewArgs = (value: unknown, limit = 200): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === 'number' || typeof raw === 'boolean'
      ? raw
      : previewText(raw, limit);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * The model's own reasoning, if the provider returned it.
 *
 * Written to `agent_messages.metadata.provider_reasoning` on every assistant
 * message since the Anthropic provider landed, and read by nothing. A trace
 * that shows what an agent did but never what it was thinking is the harder
 * half of the job done and the easier half skipped.
 */
const providerReasoning = (metadata: Record<string, unknown> | null | undefined): string => {
  if (!isRecord(metadata)) return '';
  const value = metadata.provider_reasoning;
  if (!isRecord(value)) return '';
  return typeof value.content === 'string' ? value.content : '';
};

/**
 * The tool calls an assistant message carried, by call id.
 *
 * Persisted on the message's own metadata, so the message-to-call link is
 * exact. The projection used to reach it through `modelRequestId`, which is the
 * step, not the message — right in the common case and wrong the moment a step
 * produces more than one assistant message.
 */
const messageToolCallIds = (metadata: Record<string, unknown> | null | undefined): string[] => {
  if (!isRecord(metadata)) return [];
  const calls = metadata.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => (isRecord(call) ? asString(call.id) : undefined))
    .filter((id): id is string => Boolean(id));
};

/**
 * The prompt-token count a context measurement recorded, if it recorded one.
 *
 * `ContextMeasurement.counts.promptTokens` is the figure that answers what a
 * reduction was for, and it is nested two levels inside an opaque payload the
 * projection otherwise passes straight through.
 */
const measuredPromptTokens = (measurement: unknown): number | undefined => {
  if (!isRecord(measurement)) return undefined;
  const counts = measurement.counts;
  if (!isRecord(counts)) return undefined;
  const value = counts.promptTokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** A token count at the resolution anyone reads one: `18.4k`, `1.2M`. */
const compactTokens = (tokens: number): string => {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
};

/**
 * What a context reduction actually did, on the one line it gets.
 *
 * The row used to lead with the model's own replacement summary, and failing
 * that with `same_turn_tool_result: pressure` — the reducer naming itself. Both
 * are the wrong answer to the question a reader has here, which is *how much
 * history did the model stop seeing*. The summary is the reduction's content
 * and belongs on the record's detail, where it already is; the counts are what
 * the row is for.
 */
const contextSummary = (context: TrajectoryContextRow): string => {
  const before = measuredPromptTokens(context.beforeMeasurement);
  const after = measuredPromptTokens(context.afterMeasurement);
  const shadowed = context.inputMessageIds.length;
  const parts = [
    shadowed > 0 ? `${shadowed} ${shadowed === 1 ? 'message' : 'messages'}` : null,
    before !== undefined && after !== undefined
      ? `${compactTokens(before)} → ${compactTokens(after)} tokens`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0
    ? `Compacted ${parts.join(' · ')}`
    // Nothing was measured. Naming the reducer and its trigger is the most the
    // row can honestly say, and it is still better than an empty line.
    : `${context.reducerProfile}: ${context.reason}`;
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Event-name prefixes whose records describe *how the work was carried out*
 * rather than what happened.
 *
 * Two groups, and the reason differs:
 *
 *  - Infrastructure. `sandbox.*` alone emitted the same container id fifteen
 *    times before the first model call. It is real, it reconciles, and nobody
 *    reading a trace wants it in the way.
 *  - Events the projection *already covers with a better record*. A `tool.start`
 *    beside a tool record, a `model.call.finish` beside a request record and a
 *    `usage.recorded` beside an attempt record are the same fact told twice, and
 *    the trace event is the poorer telling.
 *
 * Prefixes, not a list of the 138 event names this codebase emits — a
 * hand-copied vocabulary drifts from its source and then measures nothing.
 * Anything unmatched stays `primary`: a new event nobody classified should
 * arrive visible and slightly annoying, never silently hidden.
 */
const DETAIL_EVENT_PREFIXES = [
  'sandbox.',
  'server.',
  'workspace_projection.',
  'session.init',
  'session.cleanup',
  'session.close',
  'session.sandbox.',
  'model.call.',
  'model.attempt.',
  'usage.',
  'tool.start',
  'tool.finish',
  'user.message',
  'system.prompt.',
] as const;

/** A failure is always worth a row, whatever it was emitted by. */
const isFailureEvent = (event: TimelineEvent): boolean => {
  const severity = (event.severity ?? '').toLowerCase();
  if (severity === 'error' || severity === 'critical' || severity === 'warning') return true;
  const outcome = (event.outcome ?? '').toLowerCase();
  return outcome === 'error' || outcome === 'failed' || outcome === 'blocked';
};

const traceSignificance = (event: TimelineEvent): TrajectorySignificance => {
  if (isFailureEvent(event)) return 'primary';
  return DETAIL_EVENT_PREFIXES.some((prefix) => event.event.startsWith(prefix))
    ? 'detail'
    : 'primary';
};

const classifyTraceKind = (event: TimelineEvent): 'worker' | 'harness' => {
  if (
    event.workerTaskId
    || event.event.startsWith('worker.')
    || event.event.includes('.worker.')
    || event.event === 'worker'
  ) {
    return 'worker';
  }
  return 'harness';
};

export class RunTrajectoryService {
  private readonly now: () => Date;

  constructor(private readonly deps: RunTrajectoryServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async getTrajectory(
    run: RunTraceRunRef,
    query: RunTrajectoryQuery = {},
  ): Promise<RunTrajectoryResponse> {
    const started = performance.now();
    const snapshot = await this.project(run);
    const filtered = this.filter(snapshot.records, query);
    const fingerprint = cursorFingerprint(query);
    const state = decodeCursor(query.cursor, run.id ?? '', fingerprint);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)));
    const page = this.pageBySession(filtered, snapshot.sessionIds, state, limit);
    const projectionMs = Math.max(0, performance.now() - started);
    const projectedBytes = Buffer.byteLength(JSON.stringify(snapshot.records), 'utf8');
    const groups = snapshot.sessionIds.map((sessionId) => {
      const phase = snapshot.phases.find((candidate) => candidate.sessionId === sessionId);
      const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
      return {
        sessionId,
        ...(phase ? { phaseId: phase.id, phaseKey: phase.phaseKey } : {}),
        ...(session && parentSessionIdFromMetadata(session.metadata)
          ? { parentSessionId: parentSessionIdFromMetadata(session.metadata) }
          : {}),
        ...(session ? { agentRole: roleForSession(run, session) } : {}),
        total: filtered.filter((record) => record.sessionId === sessionId).length,
      };
    });

    return {
      schema: RUN_TRAJECTORY_SCHEMA,
      runId: run.id ?? '',
      generatedAt: this.now().toISOString(),
      records: page.records,
      sessionIds: snapshot.sessionIds,
      groups,
      total: filtered.length,
      cursor: {
        next: page.hasMore ? encodeCursor(page.state) : null,
        hasMore: page.hasMore,
      },
      ordering: {
        scope: 'partial',
        sessionOrder: 'causal_then_source',
        crossSessionOrder: 'none',
        timestampsAreCausal: false,
      },
      integrity: snapshot.integrity,
      corpus: {
        runUnit: 'run',
        sessionUnit: 'session',
        fileUnit: 'source-record',
        sessions: snapshot.sessionIds.length,
        sourceRecords: snapshot.sourceRecords,
        traceEvents: snapshot.traceEvents,
        projectedRecords: snapshot.records.length,
        projectedBytes,
        projectionMs,
        numericGates: {
          events: 15_000,
          bytes: 26_214_400,
          p95ProjectionMs: 1_000,
          cacheRequired: projectionMs >= 1_000,
          deeperIndexingRequired: snapshot.traceEvents >= 15_000 || projectedBytes >= 26_214_400,
        },
      },
    };
  }

  async getRecordDetail(
    run: RunTraceRunRef,
    recordId: string,
  ): Promise<RunTrajectoryDetailResponse | null> {
    const snapshot = await this.project(run);
    const record = snapshot.records.find((candidate) => candidate.id === recordId);
    if (!record) return null;
    const projected = snapshot.details.get(recordId);
    if (projected?.traceEventId || record.source.artifactRef) {
      const events = await this.deps.timelineService.getAllEvents(record.sessionId, 'strict');
      const event = events.find((candidate) => candidate.id === projected?.traceEventId)
        ?? events.find((candidate) => (
          eventToolCallId(candidate) === record.toolCallId
          && Boolean(eventArtifactRef(candidate))
        ));
      if (!event) {
        throw new Error(`Strict trajectory detail source is missing for ${recordId}`);
      }
      return {
        schema: 'run-trajectory-detail/v1',
        runId: run.id ?? '',
        record,
        detail: event,
        hydration: 'strict',
      };
    }
    return {
      schema: 'run-trajectory-detail/v1',
      runId: run.id ?? '',
      record,
      detail: projected?.detail ?? null,
      hydration: 'ledger',
    };
  }

  private async project(run: RunTraceRunRef): Promise<ProjectionSnapshot> {
    const runId = run.id ?? '';
    const [additionalSessionIds, phases] = await Promise.all([
      runId && this.deps.sessionResolver?.listIdsByRunId
        ? this.deps.sessionResolver.listIdsByRunId(runId).catch(() => [])
        : Promise.resolve([]),
      runId && this.deps.phaseSource
        ? this.deps.phaseSource.listByRunId(runId).catch(() => [])
        : Promise.resolve([]),
    ]);
    const sessionIds = unique([
      run.plannerSessionId,
      run.executorSessionId,
      run.sessionId,
      ...additionalSessionIds,
      ...phases.map((phase) => phase.sessionId),
    ]);
    const [ledger, tracePages, sessionIntegrity] = await Promise.all([
      this.deps.ledgerSource.load(runId, sessionIds),
      Promise.all(sessionIds.map(async (sessionId) => ({
        sessionId,
        events: await this.deps.timelineService.getAllEvents(sessionId, 'inline').catch(() => []),
      }))),
      Promise.all(sessionIds.map(async (sessionId) => parseIntegrityResult(
        sessionId,
        this.deps.integritySource
          ? await this.deps.integritySource.find(sessionId).catch(() => null)
          : null,
      ))),
    ]);
    const phaseBySession = new Map(phases
      .filter((phase): phase is RunTrajectoryPhaseRow & { sessionId: string } => Boolean(phase.sessionId))
      .map((phase) => [phase.sessionId, phase]));
    const sessionById = new Map(ledger.sessions.map((session) => [session.id, session]));
    const detailById = new Map<string, ProjectionDetail>();
    const drafts: DraftRecord[] = [];
    const integrityBySession = new Map(sessionIntegrity.map((result) => [result.sessionId, result.status]));
    const hierarchyFor = (sessionId: string, event?: TimelineEvent): TrajectoryRecord['hierarchy'] => {
      const phase = phaseBySession.get(sessionId);
      const session = sessionById.get(sessionId);
      return {
        ...(phase ? { phaseId: phase.id, phaseKey: phase.phaseKey } : {}),
        ...(event?.workerTaskId ? { workerTaskId: event.workerTaskId } : {}),
        ...(session && parentSessionIdFromMetadata(session.metadata)
          ? { parentSessionId: parentSessionIdFromMetadata(session.metadata) }
          : {}),
        ...(session ? { agentRole: roleForSession(run, session) } : event?.agentRole ? { agentRole: event.agentRole } : {}),
      };
    };
    const base = (params: {
      id: string;
      kind: TrajectoryKind;
      sessionId: string;
      parentIds?: string[];
      relation: string;
      timestamp?: Date | string | null;
      status: string;
      durationMs?: number | null;
      summary: string;
      ledger: string;
      sourceId: string;
      sourceOrdinal?: number;
      tieBreak?: number;
      event?: TimelineEvent;
      artifactRef?: string;
      /** Defaults to `primary`: an unclassified record is visible, not hidden. */
      significance?: TrajectorySignificance;
    }): DraftRecord => ({
      schema: TRAJECTORY_RECORD_SCHEMA,
      id: params.id,
      kind: params.kind,
      runId,
      sessionId: params.sessionId,
      hierarchy: hierarchyFor(params.sessionId, params.event),
      parentIds: unique(params.parentIds ?? []),
      relation: params.relation,
      presentation: { timestamp: asIso(params.timestamp) },
      significance: params.significance ?? 'primary',
      status: params.status,
      durationMs: params.durationMs ?? null,
      summary: params.summary,
      source: {
        ledger: params.ledger,
        id: params.sourceId,
        detailRef: detailRef(runId, params.id),
        ...(params.artifactRef ? { artifactRef: params.artifactRef } : {}),
      },
      sourceOrdinal: params.sourceOrdinal,
      tieBreak: params.tieBreak,
      integrity: integrityBySession.get(params.sessionId) ?? 'degraded',
    });

    /**
     * Which turn a message belongs to.
     *
     * `agent_messages` has no turn column — turns live on the model request —
     * so it has to be derived, and every record here says so by being derived
     * the same way twice. An assistant message names its request outright. A
     * user message names nothing, but it is the reason a request was made, so
     * it belongs to the first request at or after it; a message after the last
     * request belongs to that last turn.
     *
     * Without this the transcript had no turns at all: every message fell into
     * one session-wide bucket while the tool calls grouped by turn, which is
     * how a conversation renders as two unrelated lists.
     */
    const requestTurnById = new Map(ledger.requests.map((request) => [request.requestId, request.turn]));
    /**
     * Which step a model request is, so everything that request produced can
     * say so too.
     *
     * The harness numbers its model calls per turn (`callOrdinal`) and names
     * each one (`stepId`). Both stopped at the request record. Every record
     * downstream of a request — the answer, its tool calls, its retries — knows
     * its request id, so carrying the step across is a lookup, not an
     * inference, and it replaces the adjacency guess every reader was making.
     */
    const stepByRequest = new Map(ledger.requests.map((request) => [request.requestId, {
      stepId: request.stepId,
      stepOrdinal: request.callOrdinal,
      turn: request.turn,
    }]));
    /** Stamp a draft with the step its request belongs to. Silent when unknown. */
    const attachStep = (draft: DraftRecord, requestId: string | null | undefined): void => {
      if (!requestId) return;
      const step = stepByRequest.get(requestId);
      if (!step) return;
      if (step.stepId) draft.stepId = step.stepId;
      // `callOrdinal` is 1-based and resets per turn, which is exactly what a
      // reader means by "Step 2".
      if (Number.isFinite(step.stepOrdinal)) draft.stepOrdinal = step.stepOrdinal;
    };
    const requestClock = ledger.requests
      .map((request) => ({
        sessionId: request.sessionId,
        turn: request.turn,
        at: Date.parse(asIso(request.createdAt) ?? ''),
      }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((left, right) => left.at - right.at);
    const turnForMessage = (message: TrajectoryMessageRow, requestId?: string): number | undefined => {
      if (requestId !== undefined) {
        const known = requestTurnById.get(requestId);
        if (known !== undefined) return known;
      }
      const at = Date.parse(asIso(message.createdAt) ?? '');
      if (!Number.isFinite(at)) return undefined;
      const inSession = requestClock.filter((entry) => entry.sessionId === message.sessionId);
      if (inSession.length === 0) return undefined;
      return (inSession.find((entry) => entry.at >= at) ?? inSession[inSession.length - 1]!).turn;
    };

    const eligibleMessages = ledger.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    for (const message of eligibleMessages) {
      const requestId = requestIdFromMessage(message);
      const id = message.role === 'user' ? inputRecordId(message.id) : responseRecordId(message.id);
      const spoken = previewText(message.content);
      const draft = base({
        id,
        kind: message.role === 'user' ? 'input' : 'response',
        sessionId: message.sessionId,
        parentIds: message.role === 'assistant' && requestId ? [requestRecordId(requestId)] : [],
        relation: message.role === 'assistant' ? 'model_response' : 'session_input',
        timestamp: message.createdAt,
        status: 'accepted',
        // The message, not a label for the message.
        summary: spoken
          || (message.role === 'user' ? 'Empty user message' : 'Called tools without speaking'),
        // An assistant turn that produced only tool calls said nothing. It is
        // the envelope the calls arrived in, and a transcript that prints one
        // line per envelope reads as a column of "Empty assistant message" with
        // the actual work filed elsewhere. The calls themselves are the record.
        ...(message.role === 'assistant' && !spoken ? { significance: 'detail' as const } : {}),
        ledger: 'agent_messages',
        sourceId: message.id,
        sourceOrdinal: chronoOrdinal(
          message.createdAt,
          message.role === 'user' ? PHASE.input : PHASE.response,
        ),
      });
      if (requestId) draft.requestId = requestId;
      attachStep(draft, requestId);
      if (message.toolCallId) draft.toolCallId = message.toolCallId;
      if (message.toolName) draft.toolName = message.toolName;
      const turn = turnForMessage(message, requestId);
      if (turn !== undefined) draft.turn = turn;
      const thinking = previewText(providerReasoning(message.metadata), 600);
      if (thinking) draft.thinking = thinking;
      const calls = messageToolCallIds(message.metadata);
      if (calls.length > 0) draft.toolCallIds = calls;
      drafts.push(draft);
      detailById.set(id, { detail: message });
    }

    for (const context of ledger.contexts) {
      const id = contextRecordId(context.transactionId);
      const parentIds = context.triggerRequestId ? [requestRecordId(context.triggerRequestId)] : [];
      const draft = base({
        id,
        kind: 'context',
        sessionId: context.sessionId,
        parentIds,
        relation: 'history_reduction',
        timestamp: context.activatedAt ?? context.createdAt,
        status: context.status,
        summary: contextSummary(context),
        ledger: 'history_transformation_records',
        sourceId: context.transactionId,
        sourceOrdinal: chronoOrdinal(context.activatedAt ?? context.createdAt, PHASE.context),
        tieBreak: context.turn,
      });
      draft.turn = context.turn;
      if (context.stepId) draft.stepId = context.stepId;
      if (context.triggerRequestId) {
        draft.requestId = context.triggerRequestId;
        // The transformation carries its own `stepId`; the ordinal is the
        // triggering request's, because that is the call it was preparing for.
        attachStep(draft, context.triggerRequestId);
        draft.links = {
          sourceRequestRecordId: requestRecordId(context.triggerRequestId),
          ...(context.replacementMessageId
            ? { replacementMessageSourceId: `agent_messages:${context.replacementMessageId}` }
            : {}),
        };
      }
      drafts.push(draft);
      detailById.set(id, { detail: context });
    }

    for (const request of ledger.requests) {
      const id = requestRecordId(request.requestId);
      const transformationIds = request.transformationRefs.map(contextRecordId);
      const draft = base({
        id,
        kind: 'request',
        sessionId: request.sessionId,
        parentIds: transformationIds,
        relation: transformationIds.length ? 'request_after_context' : 'model_request',
        timestamp: request.createdAt,
        status: 'recorded',
        summary: `${request.provider}/${request.model}${request.routeReason ? ` · ${request.routeReason}` : ''}`,
        ledger: 'model_request_records',
        sourceId: request.requestId,
        sourceOrdinal: chronoOrdinal(request.createdAt, PHASE.request),
        tieBreak: request.turn * 1_000 + request.callOrdinal,
      });
      draft.turn = request.turn;
      draft.requestId = request.requestId;
      if (request.stepId) draft.stepId = request.stepId;
      draft.stepOrdinal = request.callOrdinal;
      draft.links = {
        transformationRecordIds: transformationIds,
      };
      drafts.push(draft);
      detailById.set(id, { detail: request });
    }

    const attemptsByRequest = new Map<string, TrajectoryAttemptRow[]>();
    for (const attempt of ledger.attempts) {
      if (!attempt.modelRequestId || !attempt.sessionId) continue;
      const attempts = attemptsByRequest.get(attempt.modelRequestId) ?? [];
      attempts.push(attempt);
      attemptsByRequest.set(attempt.modelRequestId, attempts);
    }
    for (const attempts of attemptsByRequest.values()) {
      attempts.sort((left, right) => left.attemptOrdinal - right.attemptOrdinal || left.id.localeCompare(right.id));
      for (const attempt of attempts) {
        const id = retryRecordId(attempt.id);
        const previous = attempts.find((candidate) => candidate.attemptOrdinal === attempt.attemptOrdinal - 1);
        const draft = base({
          id,
          kind: 'retry',
          sessionId: attempt.sessionId!,
          parentIds: [previous ? retryRecordId(previous.id) : requestRecordId(attempt.modelRequestId!)],
          relation: previous ? 'retry_after_attempt' : 'provider_attempt',
          timestamp: attempt.requestStartedAt,
          status: attempt.status,
          durationMs: durationBetween(attempt.requestStartedAt, attempt.requestCompletedAt),
          summary: attempt.attemptOrdinal > 1 || attempt.status !== 'completed'
            ? `Attempt ${attempt.attemptOrdinal} ${attempt.status}${attempt.errorClass ? ` · ${attempt.errorClass}` : ''}${attempt.retryDecision ? ` · ${attempt.retryDecision}` : ''}`
            : `${attempt.provider}/${attempt.reportedModel} · ${attempt.totalTokens} tok`,
          // A first attempt that succeeded is not a retry — it is the call, and
          // the request record already says that. Fifteen rows reading
          // "Attempt 1: completed" is the projection describing its own table.
          significance: attempt.attemptOrdinal > 1 || attempt.status !== 'completed' ? 'primary' : 'detail',
          ledger: 'usage_records',
          sourceId: attempt.id,
          sourceOrdinal: chronoOrdinal(attempt.requestStartedAt, PHASE.attempt),
          tieBreak: attempt.callOrdinal * 100 + attempt.attemptOrdinal,
        });
        draft.turn = attempt.turn ?? undefined;
        draft.requestId = attempt.modelRequestId!;
        attachStep(draft, attempt.modelRequestId);
        draft.attemptId = attempt.id;
        draft.attemptOrdinal = attempt.attemptOrdinal;
        drafts.push(draft);
        detailById.set(id, { detail: attempt });
      }
    }

    const responseByRequest = new Map<string, DraftRecord>();
    for (const response of drafts.filter((draft) => draft.kind === 'response' && draft.requestId)) {
      if (!responseByRequest.has(response.requestId!)) responseByRequest.set(response.requestId!, response);
      const attempts = attemptsByRequest.get(response.requestId!) ?? [];
      const lastAttempt = attempts.at(-1);
      response.parentIds = [lastAttempt ? retryRecordId(lastAttempt.id) : requestRecordId(response.requestId!)];
    }

    const traceEvents = tracePages.flatMap((page) => page.events);
    const artifactEventByToolCall = new Map<string, TimelineEvent>();
    for (const event of traceEvents) {
      const toolCallId = eventToolCallId(event);
      if (toolCallId && eventArtifactRef(event)) artifactEventByToolCall.set(toolCallId, event);
    }
    for (const tool of ledger.tools) {
      const invokeId = toolInvokeRecordId(tool.id);
      const resultId = toolResultRecordId(tool.id);
      const attempts = tool.modelRequestId ? attemptsByRequest.get(tool.modelRequestId) ?? [] : [];
      const response = tool.modelRequestId ? responseByRequest.get(tool.modelRequestId) : undefined;
      const requestParent = response?.id
        ?? (attempts.at(-1) ? retryRecordId(attempts.at(-1)!.id) : undefined)
        ?? (tool.modelRequestId ? requestRecordId(tool.modelRequestId) : undefined);
      const artifactEvent = artifactEventByToolCall.get(tool.toolCallId);
      const artifactRef = artifactEvent ? eventArtifactRef(artifactEvent) : undefined;
      const invocation = base({
        id: invokeId,
        kind: 'tool',
        sessionId: tool.sessionId,
        parentIds: requestParent ? [requestParent] : [],
        relation: 'tool_invocation',
        timestamp: tool.claimedAt,
        status: tool.startedAt ? 'started' : 'claimed',
        summary: previewText(tool.args ?? {}, 160),
        // The invocation and its result are the same call. Reading it wants one
        // row — name, arguments, arrow, result — so the result carries the whole
        // of it and the invocation stays behind for the causal edge it anchors.
        significance: 'detail',
        ledger: 'tool_execution_records',
        sourceId: tool.id,
        sourceOrdinal: chronoOrdinal(tool.claimedAt, PHASE.toolInvoke),
      });
      // The request's turn outranks the one parsed out of `turnId`: one is the
      // number the harness assigned the turn, the other is digits scraped from
      // an identifier, and they only agree by convention.
      invocation.turn = stepByRequest.get(tool.modelRequestId ?? '')?.turn ?? parseTurn(tool.turnId);
      invocation.requestId = tool.modelRequestId ?? undefined;
      attachStep(invocation, tool.modelRequestId);
      invocation.toolCallId = tool.toolCallId;
      invocation.toolName = tool.toolName;
      invocation.args = previewArgs(tool.args);
      drafts.push(invocation);
      detailById.set(invokeId, { detail: { ...tool, result: undefined } });

      const result = base({
        id: resultId,
        kind: 'tool',
        sessionId: tool.sessionId,
        parentIds: [invokeId],
        relation: 'tool_result',
        timestamp: tool.completedAt ?? tool.startedAt ?? tool.claimedAt,
        status: tool.status,
        durationMs: tool.durationMs ?? durationBetween(tool.startedAt, tool.completedAt),
        // What came back, and only that. The call itself rides `args`, where a
        // reader can pick the one argument that names the act; splicing the
        // whole args object in front of the arrow is what turned every
        // `file_write` row into the first paragraph of the file it wrote.
        summary: tool.error
          ? previewText(tool.error, 200)
          : previewText(tool.result, 200) || tool.status,
        ledger: 'tool_execution_records',
        sourceId: tool.id,
        sourceOrdinal: chronoOrdinal(
          tool.completedAt ?? tool.startedAt ?? tool.claimedAt,
          PHASE.toolResult,
        ),
        artifactRef,
      });
      result.turn = invocation.turn;
      result.requestId = tool.modelRequestId ?? undefined;
      attachStep(result, tool.modelRequestId);
      result.toolCallId = tool.toolCallId;
      result.toolName = tool.toolName;
      result.args = previewArgs(tool.args);
      drafts.push(result);
      detailById.set(resultId, {
        detail: tool,
        ...(artifactEvent ? { traceEventId: artifactEvent.id } : {}),
      });
    }

    // What the step cost, and how long it took to say the first word.
    //
    // Both facts already exist — the tokens on the provider attempt, the
    // time-to-first-token in the `model.call.finish` payload — and both were
    // reachable only by opening a record the page hides by default. They belong
    // on the answer, which is the row a reader is looking at when they ask.
    const tokensByRequest = new Map<string, TrajectoryTokens>();
    for (const [requestId, attempts] of attemptsByRequest) {
      const settled = [...attempts].reverse().find((attempt) => attempt.status === 'completed')
        ?? attempts.at(-1);
      if (!settled) continue;
      const tokens: TrajectoryTokens = {
        ...(settled.promptTokens === undefined ? {} : { input: settled.promptTokens }),
        ...(settled.cachedPromptTokens === undefined ? {} : { cacheRead: settled.cachedPromptTokens }),
        ...(settled.cacheWriteTokens === undefined ? {} : { cacheWrite: settled.cacheWriteTokens }),
        ...(settled.completionTokens === undefined ? {} : { output: settled.completionTokens }),
        ...(settled.reasoningTokens === undefined ? {} : { reasoning: settled.reasoningTokens }),
        total: settled.totalTokens,
      };
      tokensByRequest.set(requestId, tokens);
    }
    const ttftByRequest = new Map<string, number>();
    for (const event of traceEvents) {
      if (!event.event.startsWith('model.call.finish')) continue;
      const requestId = eventRequestId(event);
      const payload = isRecord(event.payload) ? event.payload : {};
      const ttft = typeof payload.ttftMs === 'number' ? payload.ttftMs : undefined;
      if (requestId && ttft !== undefined && Number.isFinite(ttft) && !ttftByRequest.has(requestId)) {
        ttftByRequest.set(requestId, ttft);
      }
    }
    for (const draft of drafts) {
      if (draft.kind !== 'response' || !draft.requestId) continue;
      const tokens = tokensByRequest.get(draft.requestId);
      if (tokens) draft.tokens = tokens;
      const ttft = ttftByRequest.get(draft.requestId);
      if (ttft !== undefined) draft.ttftMs = ttft;
    }

    // Name the calls a wordless assistant turn carried.
    //
    // The message row has to say *something*, and "Called tools without
    // speaking" says only that the projection found nothing to print. The tools
    // sharing the turn's model request are the answer, and they are already
    // projected by the time we get here.
    const toolNameByCallId = new Map(ledger.tools.map((tool) => [tool.toolCallId, tool.toolName]));
    const toolNamesByRequest = new Map<string, string[]>();
    for (const tool of ledger.tools) {
      if (!tool.modelRequestId) continue;
      const names = toolNamesByRequest.get(tool.modelRequestId) ?? [];
      if (!names.includes(tool.toolName)) names.push(tool.toolName);
      toolNamesByRequest.set(tool.modelRequestId, names);
    }
    for (const draft of drafts) {
      if (draft.kind !== 'response' || draft.significance !== 'detail') continue;
      // The message's own call ids first: that link is exact. The request is the
      // step, not the message, so it over-reports the moment one step produces
      // more than one assistant message.
      const named = (draft.toolCallIds ?? [])
        .map((callId) => toolNameByCallId.get(callId))
        .filter((name): name is string => Boolean(name));
      const names = named.length > 0
        ? [...new Set(named)]
        : draft.requestId ? toolNamesByRequest.get(draft.requestId) ?? [] : [];
      if (names.length > 0) draft.summary = `Called ${names.join(', ')}`;
    }

    /**
     * Where each trace event sits on the shared clock.
     *
     * Trace events are the one ledger whose own sequence outranks its own
     * timestamps: `acceptedOrdinal` is the order the session accepted them, and
     * two sibling worker events routinely carry clocks that disagree with it.
     * That is the whole of `timestampsAreCausal: false`.
     *
     * So the clock is repaired rather than trusted or discarded — walk a
     * session in accepted order and never let time run backwards. A later event
     * with an earlier stamp inherits the one before it and settles behind it on
     * the accepted ordinal, which keeps the sequence intact while still placing
     * the whole stream against the other ledgers. An event whose `ts` does not
     * parse takes the running floor: it is unplaced in time, not unplaced in
     * the session. `presentation.timestamp` is untouched — it keeps reporting
     * what was actually recorded, including nothing.
     */
    const traceOrdinalById = new Map<string, number>();
    const traceBySession = new Map<string, TimelineEvent[]>();
    for (const event of traceEvents) {
      const bucket = traceBySession.get(event.sessionId) ?? [];
      bucket.push(event);
      traceBySession.set(event.sessionId, bucket);
    }
    for (const bucket of traceBySession.values()) {
      const accepted = [...bucket].sort((left, right) => (
        (left.acceptedOrdinal ?? 0) - (right.acceptedOrdinal ?? 0)
        || left.id.localeCompare(right.id)
      ));
      let floor = Number.NEGATIVE_INFINITY;
      for (const event of accepted) {
        const parsed = Date.parse(String(event.ts));
        const at = Number.isFinite(parsed) ? Math.max(parsed, floor) : floor;
        if (!Number.isFinite(at)) continue;
        floor = at;
        traceOrdinalById.set(event.id, at * 10 + PHASE.trace);
      }
    }

    for (const event of traceEvents) {
      const id = traceRecordId(event);
      const artifactRef = eventArtifactRef(event);
      const requestId = eventRequestId(event);
      const toolCallId = eventToolCallId(event);
      const parentIds = event.parentEventId
        ? [`trace:${event.sessionId}:${event.parentEventId}`]
        : [];
      const draft = base({
        id,
        kind: classifyTraceKind(event),
        sessionId: event.sessionId,
        parentIds,
        relation: event.parentEventId ? 'trace_child' : 'trace_observation',
        timestamp: event.ts,
        status: event.status ?? event.outcome ?? event.severity,
        summary: event.note ? `${event.event} · ${previewText(event.note)}` : event.event,
        significance: traceSignificance(event),
        ledger: 'trace_events',
        sourceId: event.id,
        sourceOrdinal: traceOrdinalById.get(event.id),
        tieBreak: event.acceptedOrdinal,
        event,
        artifactRef,
      });
      draft.turn = event.turn;
      draft.requestId = requestId;
      draft.attemptId = event.attemptId;
      draft.attemptOrdinal = event.attemptOrdinal;
      draft.toolCallId = toolCallId;
      draft.toolName = event.name;
      drafts.push(draft);
      detailById.set(id, { detail: event, traceEventId: event.id });
    }

    const terminalEligible = ledger.sessions.filter((session) => terminalStatus(session));
    for (const [ordinal, session] of terminalEligible.entries()) {
      const status = terminalStatus(session)!;
      const id = terminalRecordId(session.id);
      const sessionDrafts = drafts.filter((draft) => draft.sessionId === session.id);
      const leaves = sessionDrafts
        .filter((candidate) => !sessionDrafts.some((other) => other.parentIds.includes(candidate.id)))
        .map((candidate) => candidate.id);
      const draft = base({
        id,
        kind: 'terminal',
        sessionId: session.id,
        parentIds: leaves,
        relation: 'session_terminal',
        timestamp: session.updatedAt,
        status,
        summary: status === 'blocked' ? `Session blocked: ${session.blockedReason}` : 'Session completed',
        ledger: 'agent_sessions',
        sourceId: session.id,
        sourceOrdinal: Number.MAX_SAFE_INTEGER - terminalEligible.length + ordinal,
      });
      drafts.push(draft);
      detailById.set(id, { detail: session });
    }

    const sourceCounts: Record<string, { source: number; projected: number }> = {
      agent_messages: { source: eligibleMessages.length, projected: drafts.filter((record) => record.source.ledger === 'agent_messages').length },
      model_request_records: { source: ledger.requests.length, projected: drafts.filter((record) => record.source.ledger === 'model_request_records').length },
      history_transformation_records: { source: ledger.contexts.length, projected: drafts.filter((record) => record.source.ledger === 'history_transformation_records').length },
      usage_records: {
        source: ledger.attempts.filter((attempt) => Boolean(attempt.modelRequestId && attempt.sessionId)).length,
        projected: drafts.filter((record) => record.source.ledger === 'usage_records').length,
      },
      tool_execution_records: { source: ledger.tools.length * 2, projected: drafts.filter((record) => record.source.ledger === 'tool_execution_records').length },
      trace_events: { source: traceEvents.length, projected: drafts.filter((record) => record.source.ledger === 'trace_events').length },
      agent_sessions_terminal: { source: terminalEligible.length, projected: drafts.filter((record) => record.source.ledger === 'agent_sessions').length },
    };
    const reconciled = this.reconcileAndOrder(drafts, sessionIds, sourceCounts, sessionIntegrity);
    return {
      records: reconciled.records,
      details: detailById,
      sessionIds,
      phases,
      sessions: ledger.sessions,
      integrity: reconciled.integrity,
      sourceRecords: eligibleMessages.length
        + ledger.requests.length
        + ledger.contexts.length
        + ledger.attempts.length
        + ledger.tools.length
        + traceEvents.length
        + terminalEligible.length,
      traceEvents: traceEvents.length,
    };
  }

  private reconcileAndOrder(
    drafts: DraftRecord[],
    sessionIds: string[],
    sourceCounts: Record<string, { source: number; projected: number }>,
    sessionIntegrity: TraceIntegrityResult[],
  ): Pick<ProjectionSnapshot, 'records' | 'integrity'> {
    const issues: RunTrajectoryIssue[] = [];
    const idCounts = new Map<string, number>();
    for (const draft of drafts) idCounts.set(draft.id, (idCounts.get(draft.id) ?? 0) + 1);
    for (const [id, count] of idCounts) {
      if (count > 1) issues.push({
        code: 'duplicate_record_id',
        status: 'failed',
        recordId: id,
        detail: `Record ID was projected ${count} times.`,
      });
    }
    const ids = new Set(drafts.map((draft) => draft.id));
    for (const draft of drafts) {
      for (const parentId of draft.parentIds) {
        if (!ids.has(parentId)) issues.push({
          code: 'missing_causal_parent',
          status: 'failed',
          recordId: draft.id,
          detail: `Explicit parent ${parentId} is absent. Timestamp order was not used as a replacement.`,
        });
      }
    }
    for (const [ledger, count] of Object.entries(sourceCounts)) {
      if (count.source !== count.projected) issues.push({
        code: 'source_count_mismatch',
        status: 'failed',
        detail: `${ledger} projected ${count.projected} of ${count.source} expected records.`,
      });
    }

    const ordered: TrajectoryRecord[] = [];
    /**
     * One chronological sequence, repaired where causality disagrees.
     *
     * This used to emit in rounds: every record with no unmet parent, then
     * every record freed by that, and so on. The sort only ever ordered records
     * *within* a round, and rounds fall out by kind — every user message is a
     * root, no answer is — so the output was strata. Every question in the
     * session came out before any answer, whatever the sort key said. That is
     * why the transcript read as a wall of chat and then a wall of tool calls,
     * and why fixing the sort key alone changed nothing.
     *
     * So the drafts are sorted once, chronologically, and emitted in that order;
     * a record whose parent has not been emitted yet waits for the next pass.
     * In a healthy session the clock and the causal edges agree and one pass
     * takes everything, so this is linear in practice. A record whose parent is
     * genuinely *later* on the clock is the case the passes exist for — it
     * settles behind its parent instead of ahead of it, which is the whole
     * point of `timestampsAreCausal: false`.
     */
    const chronological = (left: DraftRecord, right: DraftRecord): number => (
      (left.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrdinal ?? Number.MAX_SAFE_INTEGER)
      || (left.tieBreak ?? 0) - (right.tieBreak ?? 0)
      || KIND_RANK[left.kind] - KIND_RANK[right.kind]
      || left.id.localeCompare(right.id)
    );
    for (const sessionId of sessionIds) {
      const sessionDrafts = drafts.filter((draft) => draft.sessionId === sessionId).sort(chronological);
      const remaining = new Map(sessionDrafts.map((draft) => [draft.id, draft]));
      let ordinal = 1;
      while (remaining.size > 0) {
        // Walk the whole session in chronological order and take everything
        // whose parents have already gone. A parent freed earlier in THIS walk
        // counts as gone, which is what lets one pass drain a whole chain —
        // the previous version recomputed the ready set before each pass, so a
        // chain of five cost five passes and each pass emitted one stratum.
        let progressed = false;
        for (const draft of sessionDrafts) {
          if (!remaining.has(draft.id)) continue;
          if (draft.parentIds.some((parentId) => remaining.has(parentId))) continue;
          remaining.delete(draft.id);
          progressed = true;
          const rootId = this.resolveRootId(draft, drafts, new Set());
          ordered.push({
            schema: draft.schema,
            id: draft.id,
            kind: draft.kind,
            runId: draft.runId,
            sessionId: draft.sessionId,
            ...(draft.turn !== undefined ? { turn: draft.turn } : {}),
            ...(draft.stepId ? { stepId: draft.stepId } : {}),
            ...(draft.stepOrdinal !== undefined ? { stepOrdinal: draft.stepOrdinal } : {}),
            ...(draft.requestId ? { requestId: draft.requestId } : {}),
            ...(draft.attemptId ? { attemptId: draft.attemptId } : {}),
            ...(draft.attemptOrdinal !== undefined ? { attemptOrdinal: draft.attemptOrdinal } : {}),
            ...(draft.toolCallId ? { toolCallId: draft.toolCallId } : {}),
            ...(draft.toolName ? { toolName: draft.toolName } : {}),
            hierarchy: draft.hierarchy,
            causality: {
              parentIds: draft.parentIds,
              rootId,
              siblingOrder: this.hasUnorderedSibling(draft, drafts) ? 'unordered' : 'ordered',
              relation: draft.relation,
            },
            order: {
              sessionOrdinal: ordinal++,
              ...(draft.sourceOrdinal !== undefined ? { sourceOrdinal: draft.sourceOrdinal } : {}),
              scope: 'session',
            },
            presentation: draft.presentation,
            significance: draft.significance,
            status: draft.status,
            durationMs: draft.durationMs,
            summary: draft.summary,
            ...(draft.args ? { args: draft.args } : {}),
            ...(draft.tokens ? { tokens: draft.tokens } : {}),
            ...(draft.ttftMs !== undefined ? { ttftMs: draft.ttftMs } : {}),
            ...(draft.thinking ? { thinking: draft.thinking } : {}),
            ...(draft.toolCallIds?.length ? { toolCallIds: draft.toolCallIds } : {}),
            integrity: draft.integrity ?? 'degraded',
            source: draft.source,
            ...(draft.links ? { links: draft.links } : {}),
          });
        }
        if (!progressed) {
          // Nothing was free: the remainder points at itself. Report it and
          // force the lowest id through so the loop terminates and the reader
          // still sees every record.
          const cycleIds = [...remaining.keys()].sort();
          issues.push({
            code: 'causal_cycle',
            status: 'failed',
            detail: `Causal cycle in session ${sessionId}: ${cycleIds.join(', ')}`,
          });
          const forced = remaining.get(cycleIds[0]!);
          if (forced) forced.parentIds = [];
        }
      }
    }
    const orphanSessions = unique(drafts
      .filter((draft) => !sessionIds.includes(draft.sessionId))
      .map((draft) => draft.sessionId));
    if (orphanSessions.length) issues.push({
      code: 'orphan_session_projection',
      status: 'failed',
      detail: `Records referenced undiscovered sessions: ${orphanSessions.join(', ')}`,
    });
    const issueStatus: TrajectoryIntegrityStatus = issues.some((issue) => issue.status === 'failed')
      ? 'failed'
      : issues.length ? 'degraded' : 'complete';
    return {
      records: ordered,
      integrity: {
        status: aggregateStatus([issueStatus, ...sessionIntegrity.map((result) => result.status)]),
        issues,
        sessions: sessionIntegrity,
        sourceCounts,
      },
    };
  }

  private resolveRootId(draft: DraftRecord, all: DraftRecord[], seen: Set<string>): string {
    if (draft.parentIds.length === 0 || seen.has(draft.id)) return draft.id;
    seen.add(draft.id);
    const parent = all.find((candidate) => candidate.id === draft.parentIds[0]);
    return parent ? this.resolveRootId(parent, all, seen) : draft.id;
  }

  private hasUnorderedSibling(draft: DraftRecord, all: DraftRecord[]): boolean {
    if (draft.parentIds.length === 0) return false;
    return all.some((candidate) => (
      candidate.id !== draft.id
      && candidate.sessionId === draft.sessionId
      && candidate.parentIds.length === draft.parentIds.length
      && candidate.parentIds.every((parentId, index) => parentId === draft.parentIds[index])
      && candidate.relation === draft.relation
    ));
  }

  private filter(records: TrajectoryRecord[], query: RunTrajectoryQuery): TrajectoryRecord[] {
    const sessions = query.sessionIds?.length ? new Set(query.sessionIds) : undefined;
    const hierarchy = query.hierarchy?.length ? new Set(query.hierarchy) : undefined;
    const kinds = query.kinds?.length ? new Set(query.kinds) : undefined;
    const significance = query.significance?.length ? new Set(query.significance) : undefined;
    const statuses = query.statuses?.length ? new Set(query.statuses) : undefined;
    const from = parseTimeBound(query.from, Number.NEGATIVE_INFINITY);
    const to = parseTimeBound(query.to, Number.POSITIVE_INFINITY);
    const bounded = Number.isFinite(from) || Number.isFinite(to);
    return records.filter((record) => {
      if (sessions && !sessions.has(record.sessionId)) return false;
      if (kinds && !kinds.has(record.kind)) return false;
      if (significance && !significance.has(record.significance)) return false;
      if (statuses && !statuses.has(record.status)) return false;
      if (query.requestId && record.requestId !== query.requestId) return false;
      if (query.tool && record.toolName !== query.tool && record.toolCallId !== query.tool) return false;
      if (hierarchy) {
        const values = [
          record.hierarchy.phaseId,
          record.hierarchy.phaseKey,
          record.hierarchy.workerTaskId,
          record.hierarchy.parentSessionId,
          record.hierarchy.agentRole,
        ];
        if (!values.some((value) => value && hierarchy.has(value))) return false;
      }
      if (bounded) {
        // A time bound is a claim about when something happened, so a record that
        // cannot say when it happened is outside every interval. This used to wrap
        // the whole check in `if (record.presentation.timestamp)` and then fall
        // through to `return true`, which meant a five-minute window returned every
        // untimed record in the run — the narrower the brush, the larger the share
        // of the answer the brush could not have selected. `sessionOrdinal` is the
        // projection where an untimed record is visible; a clock axis is not.
        const startedAt = record.presentation.timestamp
          ? Date.parse(record.presentation.timestamp)
          : Number.NaN;
        if (!Number.isFinite(startedAt)) return false;
        // Overlap, not containment: a call that starts before the window and ends
        // inside it is part of what happened in that window. That is what a network
        // waterfall does, and operators already read this shape that way.
        const durationMs = record.durationMs ?? 0;
        const endedAt = startedAt + (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0);
        if (endedAt < from || startedAt > to) return false;
      }
      return true;
    });
  }

  private pageBySession(
    records: TrajectoryRecord[],
    sessionIds: string[],
    state: CursorState,
    limit: number,
  ): { records: TrajectoryRecord[]; state: CursorState; hasMore: boolean } {
    const groups = new Map(sessionIds.map((sessionId) => [
      sessionId,
      records
        .filter((record) => record.sessionId === sessionId)
        .sort((left, right) => left.order.sessionOrdinal - right.order.sessionOrdinal),
    ]));
    const seenRecordIds = Object.fromEntries(sessionIds.map((sessionId) => [
      sessionId,
      [...(state.seenRecordIds[sessionId] ?? [])],
    ]));
    const seen = new Map(Object.entries(seenRecordIds).map(([sessionId, recordIds]) => [
      sessionId,
      new Set(recordIds),
    ]));
    const page: TrajectoryRecord[] = [];
    while (page.length < limit) {
      let advanced = false;
      for (const sessionId of sessionIds) {
        if (page.length >= limit) break;
        const group = groups.get(sessionId) ?? [];
        const sessionSeen = seen.get(sessionId) ?? new Set<string>();
        const record = group.find((candidate) => !sessionSeen.has(candidate.id));
        if (!record) continue;
        page.push(record);
        sessionSeen.add(record.id);
        seen.set(sessionId, sessionSeen);
        seenRecordIds[sessionId] = [...sessionSeen];
        advanced = true;
      }
      if (!advanced) break;
    }
    const hasMore = sessionIds.some((sessionId) => (
      (seen.get(sessionId)?.size ?? 0) < (groups.get(sessionId)?.length ?? 0)
    ));
    return {
      records: page,
      state: { ...state, seenRecordIds },
      hasMore,
    };
  }
}
