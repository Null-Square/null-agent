export interface RecordChatUsageInput {
  userId: string;
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface UsageTrackerPort {
  recordChatUsage(input: RecordChatUsageInput): Promise<void>;
}

export interface TurnUsageRecord {
  sessionId: string;
  userId?: string | null;
  organizationId?: string | null;
  turn?: number | null;
  promptTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  currency?: string;
  model?: string;
  recordedAt: number;
}

export const PROVIDER_ATTEMPT_SCHEMA_VERSION = 2 as const;

export type UsageAttemptStatus = 'started' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
export type UsageDebitStatus = 'pending' | 'applied' | 'exempt' | 'not_applicable' | 'failed';
export type ModelAttemptState = 'started' | 'succeeded' | 'failed' | 'cancelled';
export type ModelAttemptRetryDecision = 'retry' | 'stop' | 'overflow_recovery';
export type ModelAttemptReasoningSource = 'reported' | 'estimated' | 'unavailable';
export type ModelAttemptCircuitState = 'closed' | 'open' | 'half_open';
export type ModelAttemptCircuitDecision = 'allow' | 'reject';

export interface ModelAttemptUsage {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  reasoningSource: ModelAttemptReasoningSource;
}

/** Durable provider-attempt projection. Schema-v1 rows may have a null requestId. */
export interface ModelAttemptRecord {
  schemaVersion: number;
  requestId: string | null;
  attemptId: string;
  attemptOrdinal: number;
  sessionId: string | null;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  state: ModelAttemptState;
  settlementUncertain?: boolean;
  errorClass?: string | null;
  retryDecision?: ModelAttemptRetryDecision | null;
  backoffMs?: number | null;
  circuitState?: ModelAttemptCircuitState | null;
  circuitDecision?: ModelAttemptCircuitDecision | null;
  usage: ModelAttemptUsage;
  startedAt: Date;
  completedAt?: Date | null;
  provenance: 'recorded' | 'legacy_reconstructed';
}

export interface BeginUsageAttemptInput {
  sessionId: string;
  userId?: string | null;
  organizationId?: string | null;
  /** Exact deployment pinned when the session was created. Prices the call when it has a rate card. */
  modelId?: string | null;
  turn?: number | null;
  logicalCallKey: string;
  /** Durable logical model request parent. Null only for legacy schema-v1 calls. */
  modelRequestId?: string | null;
  /** v2 requires modelRequestId and persists retry/circuit/accounting semantics. */
  schemaVersion?: number;
  attemptOrdinal: number;
  callOrdinal: number;
  provider: string;
  modelName: string;
  requestedCategory?: string | null;
  routeReason: string;
  fallbackOrdinal: number;
  requestStartedAt: Date;
  circuitState?: ModelAttemptCircuitState;
  circuitDecision?: ModelAttemptCircuitDecision;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  /**
   * Which backend carried the wire — `'api'` unless a dev process registered another runtime.
   * It is a label on one usage record, not a second record.
   */
  executionBackend?: string;
  /**
   * The model that actually answered, when the backend substituted one for the pinned deployment.
   *
   * Absent on the API path, which never substitutes. When present, the attempt is priced against
   * *this* model's rate card — the tokens belong to it, so the cost does too.
   */
  effectiveModelName?: string;
}

export interface UsageAttemptHandle {
  id: string;
  logicalCallKey: string;
  modelRequestId?: string | null;
  attemptOrdinal: number;
  /** The deployment that was priced — the substituted model when the backend substituted one. */
  modelId: string | null;
  modelName: string;
  provider: string;
  requestStartedAt: Date;
  /** Which backend carried the wire. Descriptive only; it selects no behaviour. */
  executionBackend: string;
  /** Null when the model has no rate card; the call is then recorded at zero rates. */
  rateCardId: string | null;
  rateWindowId: string | null;
  currency: string;
  cacheHitRatePer1m: number;
  cacheMissRatePer1m: number;
  outputRatePer1m: number;
}

export interface CompleteUsageAttemptInput {
  attemptId: string;
  requestCompletedAt: Date;
  providerRequestId?: string | null;
  reportedModel?: string | null;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  reasoningSource?: ModelAttemptReasoningSource;
  retryDecision?: ModelAttemptRetryDecision;
}

export interface FinalizedUsageAttempt {
  id: string;
  status: UsageAttemptStatus;
  debitStatus: UsageDebitStatus;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  debitedCredits: number;
  currency: string;
  model: string;
  reasoningTokens: number;
  reasoningSource: ModelAttemptReasoningSource;
  billing: {
    platformMargin: number;
    creditRatePerUsd: number;
    overheadMultiplier: number;
  };
  creditExempt: boolean;
  replayed?: boolean;
}

export interface FailUsageAttemptInput {
  attemptId: string;
  status: 'failed' | 'uncertain' | 'cancelled';
  requestCompletedAt: Date;
  providerRequestId?: string | null;
  reportedModel?: string | null;
  errorClass?: string | null;
  retryDecision?: ModelAttemptRetryDecision | null;
  backoffMs?: number | null;
  reasoningTokens?: number;
  reasoningSource?: ModelAttemptReasoningSource;
}

export interface UsageSummary {
  promptTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead?: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  entries: number;
}

export interface UsageStorePort {
  readonly billingMode: 'billable' | 'non_billable';
  beginAttempt(record: BeginUsageAttemptInput): Promise<UsageAttemptHandle>;
  completeAttempt(record: CompleteUsageAttemptInput): Promise<FinalizedUsageAttempt>;
  failAttempt(record: FailUsageAttemptInput): Promise<void>;
  /** Retained only for explicitly non-billable research-lab aggregation. */
  recordTurnUsage(record: TurnUsageRecord): Promise<void>;
  getSessionSummary?(sessionId: string): Promise<UsageSummary | undefined>;
  listAttemptsByRequest?(requestId: string): Promise<ModelAttemptRecord[]>;
  listAttemptsBySession?(sessionId: string): Promise<ModelAttemptRecord[]>;
}

export const supportsDurableProviderAttemptLifecycle = (
  value: unknown,
): value is UsageStorePort & Required<Pick<UsageStorePort, 'listAttemptsByRequest' | 'listAttemptsBySession'>> => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UsageStorePort>;
  return typeof candidate.beginAttempt === 'function'
    && typeof candidate.completeAttempt === 'function'
    && typeof candidate.failAttempt === 'function'
    && typeof candidate.listAttemptsByRequest === 'function'
    && typeof candidate.listAttemptsBySession === 'function';
};
