export const INTERRUPTED_TOOL_RESULT_SCHEMA = 'interrupted-tool-result/v1' as const;
export const INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA =
  'interrupted-tool-recovery-event/v1' as const;

export type InterruptedToolOutcome =
  | { kind: 'not_started'; guidance: 'may_retry'; evidenceRef: string }
  | { kind: 'outcome_unknown'; guidance: 'verify_before_retry'; evidenceRef?: string };

/**
 * Evidence is supplied by an execution authority. A missing record is deliberately not a
 * `not_started` fact: E3 owns the ledger that can make that stronger assertion.
 */
export type InterruptedToolExecutionEvidence =
  | { dispatchState: 'not_started'; evidenceRef: string }
  | { dispatchState: 'started'; evidenceRef: string }
  | { dispatchState: 'unknown'; evidenceRef?: string };

export type InterruptedToolRecoverySource =
  | 'turn_stream_sanitizer'
  | 'message_validator'
  | 'anthropic_request_translator'
  | 'tool_execution_lifecycle'
  | 'behavior_lab_live_repair'
  | 'behavior_lab_cold_recovery';

export type InterruptedToolResultV1 = {
  schema: typeof INTERRUPTED_TOOL_RESULT_SCHEMA;
  recovered: true;
  success: false;
  error: string;
  outcome: InterruptedToolOutcome;
};

export type InterruptedToolRecoveryEventV1 = {
  schema: typeof INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA;
  toolCallId: string;
  source: InterruptedToolRecoverySource;
  decision: InterruptedToolOutcome['kind'];
  compatibilityVersion: typeof INTERRUPTED_TOOL_RESULT_SCHEMA;
  evidenceRef?: string;
};

export type InterruptedToolRecoveryProjection = {
  content: string;
  result: InterruptedToolResultV1;
  event: InterruptedToolRecoveryEventV1;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseContent = (content: unknown): Record<string, unknown> | undefined => {
  if (isRecord(content)) return content;
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const readV1Outcome = (payload: Record<string, unknown>): InterruptedToolOutcome | undefined => {
  if (payload.schema !== INTERRUPTED_TOOL_RESULT_SCHEMA || !isRecord(payload.outcome)) {
    return undefined;
  }

  const outcome = payload.outcome;
  if (
    outcome.kind === 'not_started'
    && outcome.guidance === 'may_retry'
    && nonEmptyString(outcome.evidenceRef)
  ) {
    return {
      kind: 'not_started',
      guidance: 'may_retry',
      evidenceRef: outcome.evidenceRef,
    };
  }
  if (outcome.kind === 'outcome_unknown' && outcome.guidance === 'verify_before_retry') {
    return {
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
      ...(nonEmptyString(outcome.evidenceRef) ? { evidenceRef: outcome.evidenceRef } : {}),
    };
  }
  return undefined;
};

const isLegacyInterruptedPayload = (payload: Record<string, unknown>): boolean => {
  if (payload.schema === INTERRUPTED_TOOL_RESULT_SCHEMA) return false;
  const error = typeof payload.error === 'string' ? payload.error : '';
  const knownLegacyText = error.startsWith('Tool execution was interrupted')
    || error.startsWith('Tool result unavailable (session recovered after interruption)');
  return knownLegacyText && (payload.recovered === true || payload.success === false);
};

export const resolveInterruptedToolOutcome = (
  evidence?: InterruptedToolExecutionEvidence,
): InterruptedToolOutcome => {
  if (
    evidence?.dispatchState === 'not_started'
    && nonEmptyString(evidence.evidenceRef)
  ) {
    return {
      kind: 'not_started',
      guidance: 'may_retry',
      evidenceRef: evidence.evidenceRef,
    };
  }

  return {
    kind: 'outcome_unknown',
    guidance: 'verify_before_retry',
    ...(nonEmptyString(evidence?.evidenceRef) ? { evidenceRef: evidence.evidenceRef } : {}),
  };
};

export const buildInterruptedToolRecoveryProjection = (input: {
  toolCallId: string;
  source: InterruptedToolRecoverySource;
  evidence?: InterruptedToolExecutionEvidence;
}): InterruptedToolRecoveryProjection => {
  const outcome = resolveInterruptedToolOutcome(input.evidence);
  const error = outcome.kind === 'not_started'
    ? 'Durable execution evidence proves the interrupted tool call did not start. The call may be retried.'
    : 'The interrupted tool call outcome is unknown. Verify external state before issuing another tool call.';
  const result: InterruptedToolResultV1 = {
    schema: INTERRUPTED_TOOL_RESULT_SCHEMA,
    recovered: true,
    success: false,
    error,
    outcome,
  };

  return {
    content: JSON.stringify(result),
    result,
    event: {
      schema: INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA,
      toolCallId: input.toolCallId,
      source: input.source,
      decision: outcome.kind,
      compatibilityVersion: INTERRUPTED_TOOL_RESULT_SCHEMA,
      ...('evidenceRef' in outcome ? { evidenceRef: outcome.evidenceRef } : {}),
    },
  };
};

/**
 * Reads both the current result and recognized pre-E1 placeholders. Legacy placeholders are
 * always interpreted conservatively, regardless of their former free-text retry advice.
 */
export const readInterruptedToolOutcome = (content: unknown): InterruptedToolOutcome | undefined => {
  const payload = parseContent(content);
  if (!payload) return undefined;
  const current = readV1Outcome(payload);
  if (current) return current;
  if (payload.schema === INTERRUPTED_TOOL_RESULT_SCHEMA) {
    return { kind: 'outcome_unknown', guidance: 'verify_before_retry' };
  }
  return isLegacyInterruptedPayload(payload)
    ? { kind: 'outcome_unknown', guidance: 'verify_before_retry' }
    : undefined;
};

/**
 * Rewrites recognized legacy placeholders and malformed current payloads. A well-formed v1
 * result is already safe and is left byte-for-byte intact.
 */
export const repairUnsafeInterruptedToolResult = (input: {
  toolCallId: string;
  content: unknown;
  source: InterruptedToolRecoverySource;
}): InterruptedToolRecoveryProjection | undefined => {
  const payload = parseContent(input.content);
  if (!payload) return undefined;
  const needsConservativeRepair = isLegacyInterruptedPayload(payload)
    || (payload.schema === INTERRUPTED_TOOL_RESULT_SCHEMA && !readV1Outcome(payload));
  if (!needsConservativeRepair) return undefined;
  return buildInterruptedToolRecoveryProjection({
    toolCallId: input.toolCallId,
    source: input.source,
  });
};

export const upgradeLegacyInterruptedToolResult = repairUnsafeInterruptedToolResult;
