/**
 * Durable tool-execution lifecycle shared by every runtime host.
 *
 * `pending` and `completed` remain readable for one rollback window. Adapters normalize
 * those legacy values conservatively before runtime code makes a recovery decision.
 */

export const TOOL_EXECUTION_LIFECYCLE_SCHEMA_VERSION = 2 as const;

export type CanonicalToolExecutionStatus =
  | 'claimed'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'outcome_unknown';

export type ToolExecutionStatus =
  | CanonicalToolExecutionStatus
  | 'pending'
  | 'completed';

export interface ToolExecutionRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  modelRequestId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status: ToolExecutionStatus;
  claimedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: string;
}

export interface CreateToolExecutionInput {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  modelRequestId?: string;
  args?: Record<string, unknown>;
}

export interface ToolExecutionIdentity {
  sessionId: string;
  toolCallId: string;
}

export interface CompleteToolExecutionInput extends ToolExecutionIdentity {
  result: unknown;
  durationMs?: number;
}

export interface FailToolExecutionInput extends ToolExecutionIdentity {
  error: string;
  durationMs?: number;
}

export interface BlockToolExecutionInput extends ToolExecutionIdentity {
  reason: string;
  durationMs?: number;
}

export interface OutcomeUnknownToolExecutionInput extends ToolExecutionIdentity {
  reason: string;
}

/**
 * Maps the rollback row shape without guessing that an old `pending` row never started.
 * Before schema v2, `startedAt` was populated at claim time, so every legacy pending row
 * is ambiguous and must become `outcome_unknown`.
 */
export const normalizeToolExecutionStatus = (
  record: Pick<ToolExecutionRecord, 'status' | 'claimedAt' | 'startedAt'>,
): CanonicalToolExecutionStatus => {
  if (record.status === 'completed') return 'succeeded';
  if (record.status === 'pending') return 'outcome_unknown';
  return record.status;
};

export const isToolExecutionTerminal = (status: ToolExecutionStatus): boolean =>
  ['succeeded', 'failed', 'blocked', 'outcome_unknown', 'completed'].includes(status);

export const supportsDurableToolExecutionLifecycle = (
  port: ToolExecutionPort | undefined,
): port is ToolExecutionPort & Required<Pick<
  ToolExecutionPort,
  'claim' | 'markStarted' | 'block' | 'markOutcomeUnknown'
>> => Boolean(
  port
  && typeof port.claim === 'function'
  && typeof port.markStarted === 'function'
  && typeof port.block === 'function'
  && typeof port.markOutcomeUnknown === 'function',
);

export interface ToolExecutionPort {
  findByToolCallId(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined>;

  /** Compatibility alias for callers that have not moved to `claim` yet. */
  create(input: CreateToolExecutionInput): Promise<ToolExecutionRecord>;

  /** Atomically owns a tool call before any potentially effecting hook or tool runs. */
  claim?(input: CreateToolExecutionInput): Promise<{
    record: ToolExecutionRecord;
    claimed: boolean;
  }>;

  /** Durable dispatch boundary. Only a freshly claimed execution may start. */
  markStarted?(input: ToolExecutionIdentity): Promise<void>;

  /** Freeze a successful terminal result. Repeated settlement returns the same fact. */
  complete(input: CompleteToolExecutionInput): Promise<void>;

  /** Freeze a known failed terminal result. */
  fail(input: FailToolExecutionInput): Promise<void>;

  /** Freeze a policy/hook block as a distinct terminal result. */
  block?(input: BlockToolExecutionInput): Promise<void>;

  /** Freeze a dispatched execution whose external outcome cannot be proven. */
  markOutcomeUnknown?(input: OutcomeUnknownToolExecutionInput): Promise<void>;

  findBySession(sessionId: string): Promise<ToolExecutionRecord[]>;
  findByTurn(sessionId: string, turnId: string): Promise<ToolExecutionRecord[]>;
}
