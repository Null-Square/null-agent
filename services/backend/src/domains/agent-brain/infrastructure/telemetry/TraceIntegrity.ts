import type { TraceWriteRejectionReason } from './types';

export const TRACE_INTEGRITY_SCHEMA = 'trace-integrity/v1' as const;

export type TraceIntegrityStatus = 'complete' | 'degraded' | 'failed';

export type TraceIntegritySurface =
  | 'model_requests'
  | 'provider_attempts'
  | 'tool_executions'
  | 'messages'
  | 'trace_events'
  | 'artifacts'
  | 'terminal_receipt';

export interface TraceIntegrityExpectation {
  surface: TraceIntegritySurface;
  id: string;
  present: boolean;
  valid?: boolean;
  required?: boolean;
  detail?: string;
}

export interface TraceIntegrityInput {
  sessionId: string;
  acceptedHighWater: number;
  persistedHighWater: number;
  terminalReceipt: boolean;
  expectations?: TraceIntegrityExpectation[];
  rejectedWrites?: Array<{
    reason: TraceWriteRejectionReason;
    event?: string;
    required?: boolean;
  }>;
  writerFailed?: boolean;
}

export interface TraceIntegrityIssue {
  surface: TraceIntegritySurface;
  code: string;
  id?: string;
  detail: string;
}

export interface TraceIntegrityResult {
  schema: typeof TRACE_INTEGRITY_SCHEMA;
  sessionId: string;
  status: TraceIntegrityStatus;
  acceptedHighWater: number;
  persistedHighWater: number;
  issues: TraceIntegrityIssue[];
  surfaces: Record<TraceIntegritySurface, 'complete' | 'degraded' | 'failed' | 'not_observed'>;
}

export interface TracePairingEvent {
  event: string;
  toolCallId?: string;
}

export interface ProviderAttemptIntegrityRecord {
  requestId: string | null;
  attemptId: string;
  attemptOrdinal: number;
  state: 'started' | 'succeeded' | 'failed' | 'cancelled';
  retryDecision?: 'retry' | 'stop' | 'overflow_recovery' | null;
  usage: {
    uncachedInput: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    reasoningSource: 'reported' | 'estimated' | 'unavailable';
  };
}

const SURFACES: TraceIntegritySurface[] = [
  'model_requests',
  'provider_attempts',
  'tool_executions',
  'messages',
  'trace_events',
  'artifacts',
  'terminal_receipt',
];

const isNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/** Reconciles ordered provider attempts against their immutable E4 request parents. */
export const buildProviderAttemptIntegrityExpectations = (
  requestIds: readonly string[],
  attempts: readonly ProviderAttemptIntegrityRecord[],
): TraceIntegrityExpectation[] => requestIds.map((requestId) => {
  const matching = attempts
    .filter((attempt) => attempt.requestId === requestId)
    .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
  const ordinalsValid = matching.every(
    (attempt, index) => attempt.attemptOrdinal === index + 1,
  );
  const uniqueIds = new Set(matching.map((attempt) => attempt.attemptId)).size === matching.length;
  const terminal = matching.every((attempt) => attempt.state !== 'started');
  const retryChainValid = matching.every((attempt, index) =>
    attempt.retryDecision !== 'retry' || index < matching.length - 1);
  const usageValid = matching.every((attempt) => {
    const usage = attempt.usage;
    return [
      usage.uncachedInput,
      usage.cacheRead,
      usage.cacheWrite,
      usage.output,
      usage.reasoning,
    ].every(isNonNegativeInteger)
      && usage.reasoning <= usage.output
      && (
        usage.reasoningSource === 'reported'
        || usage.reasoningSource === 'estimated'
        || usage.reasoningSource === 'unavailable'
      );
  });
  const present = matching.length > 0;
  const valid = present && ordinalsValid && uniqueIds && terminal && retryChainValid && usageValid;
  return {
    surface: 'provider_attempts',
    id: `request-attempts:${requestId}`,
    present,
    valid,
    detail:
      `Request ${requestId} has ${matching.length} attempt(s); `
      + `ordinals=${ordinalsValid ? 'valid' : 'invalid'} ids=${uniqueIds ? 'unique' : 'duplicate'} `
      + `terminal=${terminal} retryChain=${retryChainValid} usage=${usageValid}.`,
  };
});

const statusRank = (status: TraceIntegrityStatus): number => {
  if (status === 'failed') return 2;
  if (status === 'degraded') return 1;
  return 0;
};

/** Builds exact start/finish expectations without relying on array adjacency. */
export const buildToolTracePairingExpectations = (
  events: readonly TracePairingEvent[],
): TraceIntegrityExpectation[] => {
  const counts = new Map<string, { starts: number; finishes: number }>();
  for (const event of events) {
    if (!event.toolCallId || (event.event !== 'tool.start' && event.event !== 'tool.finish')) continue;
    const count = counts.get(event.toolCallId) ?? { starts: 0, finishes: 0 };
    if (event.event === 'tool.start') count.starts += 1;
    else count.finishes += 1;
    counts.set(event.toolCallId, count);
  }
  return [...counts.entries()].map(([toolCallId, count]) => ({
    surface: 'trace_events',
    id: `tool-pair:${toolCallId}`,
    present: count.starts === 1 && count.finishes === 1,
    valid: count.starts === 1 && count.finishes === 1,
    detail: `Tool ${toolCallId} has ${count.starts} start event(s) and ${count.finishes} finish event(s).`,
  }));
};

/**
 * Reconciles evidence receipts without inventing absent observations. Callers supply E4
 * requests, E3 tools, messages, trace events, and artifact expectations through one generic
 * shape; later trajectory projections can consume the result without host-specific logic.
 */
export const reconcileTraceIntegrity = (input: TraceIntegrityInput): TraceIntegrityResult => {
  const issues: TraceIntegrityIssue[] = [];
  const surfaces = Object.fromEntries(
    SURFACES.map((surface) => [surface, 'not_observed']),
  ) as TraceIntegrityResult['surfaces'];

  const mark = (surface: TraceIntegritySurface, status: 'complete' | 'degraded' | 'failed'): void => {
    const current = surfaces[surface];
    const currentStatus: TraceIntegrityStatus = current === 'not_observed' ? 'complete' : current;
    if (current === 'not_observed' || statusRank(status) > statusRank(currentStatus)) {
      surfaces[surface] = status;
    }
  };

  if (input.writerFailed) {
    mark('trace_events', 'failed');
    issues.push({
      surface: 'trace_events',
      code: 'writer_failed',
      detail: 'The trace writer failed after accepting session work.',
    });
  }

  if (input.acceptedHighWater !== input.persistedHighWater) {
    mark('trace_events', 'degraded');
    issues.push({
      surface: 'trace_events',
      code: 'high_water_mismatch',
      detail: `Accepted ordinal ${input.acceptedHighWater} does not match persisted ordinal ${input.persistedHighWater}.`,
    });
  } else {
    mark('trace_events', input.writerFailed ? 'failed' : 'complete');
  }

  if (!input.terminalReceipt) {
    mark('terminal_receipt', 'degraded');
    issues.push({
      surface: 'terminal_receipt',
      code: 'terminal_receipt_missing',
      detail: 'The terminal close barrier did not persist a receipt.',
    });
  } else {
    mark('terminal_receipt', 'complete');
  }

  for (const rejection of input.rejectedWrites ?? []) {
    if (rejection.required === false) continue;
    const failed = rejection.reason === 'writer_failed';
    mark('trace_events', failed ? 'failed' : 'degraded');
    issues.push({
      surface: 'trace_events',
      code: `write_rejected_${rejection.reason}`,
      id: rejection.event,
      detail: `Required trace write${rejection.event ? ` ${rejection.event}` : ''} was rejected: ${rejection.reason}.`,
    });
  }

  for (const expectation of input.expectations ?? []) {
    const required = expectation.required !== false;
    if (expectation.present && expectation.valid !== false) {
      mark(expectation.surface, 'complete');
      continue;
    }
    if (!required) continue;
    const invalid = expectation.present && expectation.valid === false;
    mark(expectation.surface, invalid ? 'failed' : 'degraded');
    issues.push({
      surface: expectation.surface,
      code: invalid ? 'evidence_invalid' : 'evidence_missing',
      id: expectation.id,
      detail: expectation.detail
        ?? `${expectation.surface} evidence ${expectation.id} is ${invalid ? 'invalid' : 'missing'}.`,
    });
  }

  const observedStatuses = Object.values(surfaces).filter(
    (status): status is 'complete' | 'degraded' | 'failed' => status !== 'not_observed',
  );
  const status: TraceIntegrityStatus = observedStatuses.includes('failed')
    ? 'failed'
    : observedStatuses.includes('degraded')
      ? 'degraded'
      : 'complete';

  return {
    schema: TRACE_INTEGRITY_SCHEMA,
    sessionId: input.sessionId,
    status,
    acceptedHighWater: input.acceptedHighWater,
    persistedHighWater: input.persistedHighWater,
    issues,
    surfaces,
  };
};
