export type TraceSeverity = 'debug' | 'info' | 'warn' | 'error';

export type TraceEventPayload =
  | Record<string, unknown>
  | object
  | string
  | number
  | boolean
  | null
  | Array<unknown>;

export interface TraceEvent {
  event: string;
  severity?: TraceSeverity;
  payload?: TraceEventPayload;
  links?: Record<string, string>;
  note?: string;
  /** Parent event ID for hierarchical trace trees */
  parentEventId?: string;
  /** Nesting depth (0 = root) */
  depth?: number;
}

/**
 * Correlation fields that remain inline even when the event detail spills to an artifact.
 * These names intentionally match the canonical model-request and tool-lifecycle joins.
 */
export interface TraceCorrelationHeader {
  eventId: string;
  event: string;
  sessionId: string;
  turn?: number;
  requestId?: string;
  attemptId?: string;
  attemptOrdinal?: number;
  toolCallId?: string;
  name?: string;
  status?: string;
  outcome?: string;
  artifactRef?: string;
  artifactSha256?: string;
}

export type TraceWriteRejectionReason = 'closed' | 'missing_context' | 'writer_failed';

export type TraceWriteResult =
  | { accepted: true; eventId: string; acceptedOrdinal: number }
  | { accepted: false; reason: TraceWriteRejectionReason };

export interface TraceArtifactReceipt {
  path: string;
  bytes: number;
  sha256: string;
}

export type TraceHydrationMode = 'inline' | 'hydrated' | 'strict';

/**
 * Business context for high-cardinality tracing.
 * These fields are included in every trace event for easy querying.
 */
export interface BusinessContext {
  /** User ID for attribution */
  userId?: string;
  /** Subscription tier (free/pro/enterprise) */
  tier?: string;
  /** LLM model identifier */
  model?: string;
  /** Sandbox Docker image ID */
  imageId?: string;
}

export interface TraceSessionContext {
  runId?: string;
  agentRole?: string;
  phaseId?: string;
  workerTaskId?: string;
}

export interface SessionTraceSeed {
  workspace: string;
  tools: string[];
  profileKey?: string;
  promptProfile?: string;
  agentType?: string;
  agentRole?: string;
  runId?: string;
  phaseId?: string;
  workerTaskId?: string;
  extraContext?: boolean;
  sandboxProfile?: string | null;
  container?: {
    image?: string;
    id?: string;
  };
  model?: string;
  /** Business context for analytics and observability */
  context?: BusinessContext;
}

export interface SessionTraceCloseMeta {
  terminal: 'session.done' | 'session.cleanup' | 'error';
  status?: string;
  turns?: number;
  bytesWritten?: number;
  lastEventAt?: string;
  toolErrors?: number;
}

export interface SessionTraceRecorderOptions {
  rootDir: string;
  inlineLimit: number;
  stdoutChunkSize: number;
  compressOverBytes: number;
  retentionDays: number;
  keepLocalCopy?: boolean;
  /** S3-only mode: debounce full trace uploads by this many milliseconds. */
  s3FlushIntervalMs?: number;
  /** S3-only mode: force a background trace upload after this many trace writes. */
  s3FlushMaxEvents?: number;
  /** Sampling configuration */
  sampling?: {
    /** Base sample rate (0-1, default 0.1 = 10%) */
    rate: number;
    /** Always trace sessions longer than this (ms) */
    alwaysTraceIfSlowMs: number;
    /** Always trace on error */
    alwaysTraceOnError: boolean;
  };
}

// ============================================================================
// High-Signal Event Types (Trace Observability v2)
// These events provide human-readable summaries for quick session understanding
// ============================================================================

/**
 * Outcome of a tool execution
 */
export type ActionOutcome = 'success' | 'failure' | 'blocked' | 'timeout' | 'error' | 'skipped';

/**
 * D2 — whether the tool ran, which is a separate question from what the target said.
 *
 * The emitter used to collapse the two: any HTTP response of 400 or worse became
 * `outcome: 'failure'`. In production run r1 that made 46 of 63 recorded failures ordinary
 * security evidence — 26 x 404, 12 x 401 — and inflated failure totals, progress detection,
 * diminishing-return heuristics, trajectory summaries and the operator's reading of the run.
 */
export type ActionExecution =
  | 'succeeded'
  | 'transport_failed'
  | 'timeout'
  | 'policy_blocked'
  | 'skipped';

/**
 * What the target said, for tools that talk to one. For a security probe a 401 is often the
 * evidence the probe wanted, a 404 falsifies an exposure hypothesis, a 403 confirms
 * authorization enforcement and a 429 confirms rate limiting. None of them is a tool failure.
 */
export type ActionObservation =
  | '2xx_positive'
  | '3xx_redirect'
  | '401_auth_enforced'
  | '403_forbidden'
  | '404_absent'
  | '429_rate_limited'
  | '4xx_client_error'
  | '5xx_server_error'
  | 'no_response'
  | 'not_applicable';

/**
 * Human-readable summary of a tool execution.
 * Emitted after each tool call to provide at-a-glance understanding.
 */
export interface ActionSummaryPayload {
  /** Tool name (e.g., 'http_payload', 'shell_run') */
  tool: string;
  /** Reference to the tool.finish event */
  toolCallId: string;
  /** Human-readable action description (e.g., 'GET http://target/api/users') */
  action: string;
  /**
   * Execution outcome. Derived from the execution axis: whether the tool ran, not what the
   * target answered. A 404 is `success` here, and `observation: '404_absent'` below.
   */
  outcome: ActionOutcome;
  /** Reason for outcome if not success (e.g., '404 Not Found', 'Connection refused') */
  outcomeReason?: string;
  /** Did the tool run? Only this axis may feed a failure counter. */
  execution: ActionExecution;
  /** What did the target say? `not_applicable` for tools that do not talk to one. */
  observation: ActionObservation;
  /** HTTP status code if applicable */
  statusCode?: number;
  /** Response content-type (e.g. 'text/html', 'application/json') */
  contentType?: string;
  /** One-line finding if notable */
  finding?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Discovery category for notable findings
 */
export type DiscoveryCategory =
  | 'endpoint'
  | 'credential'
  | 'vulnerability'
  | 'data'
  | 'configuration'
  | 'flag';

/**
 * Source of a discovery
 */
export type DiscoverySource =
  | 'tool_output'
  | 'html_comment'
  | 'response_header'
  | 'llm_inference'
  | 'memory';

/**
 * Event emitted when agent identifies something significant.
 * Surfaces key findings that would otherwise be buried in verbose tool output.
 */
export interface DiscoveryPayload {
  /** Classification of the finding */
  category: DiscoveryCategory;
  /** Unique identifier for deduplication */
  key: string;
  /** The actual finding */
  value: unknown;
  /** Confidence score 0.0-1.0 */
  confidence: number;
  /** How the discovery was made */
  source: DiscoverySource;
  /** Which tool call found this (if applicable) */
  sourceToolCallId?: string;
  /** Human-readable summary (e.g., 'Found credentials test:test in HTML comment') */
  summary: string;
}

/**
 * Session execution phases
 */
export type MilestonePhase =
  | 'execution'
  | 'recon'
  | 'reconnaissance'
  | 'enumeration'
  | 'validation'
  | 'evidence'
  | 'exploitation'
  | 'post_exploitation'
  | 'reporting';

/**
 * Status of a milestone phase
 */
export type MilestoneStatus = 'started' | 'completed' | 'blocked' | 'skipped';

/**
 * Statistics for a milestone phase
 */
export interface MilestoneStats {
  actionsCount: number;
  successCount: number;
  failureCount: number;
  discoveriesCount: number;
}

/**
 * Event emitted at significant session phases.
 * Provides phase-level progress tracking.
 */
export interface MilestonePayload {
  /** Phase identification */
  phase: MilestonePhase;
  /** Phase status */
  status: MilestoneStatus;
  /** Human-readable summary (e.g., 'Completed reconnaissance: 5 endpoints found') */
  summary: string;
  /** Statistics for this phase (when completing) */
  stats?: MilestoneStats;
}

/**
 * Memory update operation type
 */
export type MemoryOperation =
  | 'fact_added'
  | 'fact_updated'
  | 'attempt_recorded'
  | 'failure_recorded';

/**
 * Memory change details
 */
export interface MemoryChange {
  /** Type of memory entry */
  type: 'fact' | 'attempt' | 'failure';
  /** Key identifying the entry */
  key: string;
  /** New value */
  value: unknown;
  /** Previous value (for updates) */
  previousValue?: unknown;
}

/**
 * Memory statistics snapshot
 */
export interface MemoryStats {
  factsCount: number;
  attemptsCount: number;
  failuresCount: number;
  endpointsCount: number;
}

/**
 * Event emitted when AgentMemory state changes.
 * Tracks memory evolution for debugging and analysis.
 */
export interface MemoryUpdatePayload {
  /** What operation occurred */
  operation: MemoryOperation;
  /** Details of the change */
  change: MemoryChange;
  /** Current memory statistics */
  memoryStats: MemoryStats;
}

// ============================================================================
// Typed Event Helpers
// ============================================================================

/**
 * Create an action.summary trace event
 */
export function createActionSummaryEvent(payload: ActionSummaryPayload): TraceEvent {
  return {
    event: 'action.summary',
    severity: 'info',
    payload,
    note: `${payload.tool}: ${payload.action} → ${payload.outcome}`,
  };
}

/**
 * Create a discovery trace event
 */
export function createDiscoveryEvent(payload: DiscoveryPayload): TraceEvent {
  return {
    event: 'discovery',
    severity: 'info',
    payload,
    note: payload.summary,
  };
}

/**
 * Create a milestone trace event
 */
export function createMilestoneEvent(payload: MilestonePayload): TraceEvent {
  return {
    event: 'milestone',
    severity: 'info',
    payload,
    note: payload.summary,
  };
}

/**
 * Create a memory.update trace event
 */
export function createMemoryUpdateEvent(payload: MemoryUpdatePayload): TraceEvent {
  return {
    event: 'memory.update',
    severity: 'debug',
    payload,
    note: `${payload.operation}: ${payload.change.type}:${payload.change.key}`,
  };
}
