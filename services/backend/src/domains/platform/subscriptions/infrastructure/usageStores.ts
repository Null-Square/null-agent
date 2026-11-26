import { randomUUID } from 'crypto';
import type {
  BeginUsageAttemptInput,
  CompleteUsageAttemptInput,
  FailUsageAttemptInput,
  FinalizedUsageAttempt,
  ModelAttemptRecord,
  TurnUsageRecord,
  UsageAttemptHandle,
  UsageStorePort as UsageStore,
  UsageSummary,
} from '@/domains/agent-brain/ports';

/** Explicitly non-billable research-lab aggregation. Never use for customer calls. */
export class InMemoryUsageStore implements UsageStore {
  readonly billingMode = 'non_billable' as const;
  private readonly records = new Map<string, TurnUsageRecord[]>();
  private readonly attempts = new Map<string, BeginUsageAttemptInput>();
  private readonly attemptRecords = new Map<string, ModelAttemptRecord>();
  private readonly maxEntriesPerSession: number;

  constructor(maxEntriesPerSession = 500) {
    this.maxEntriesPerSession = maxEntriesPerSession;
  }

  async beginAttempt(record: BeginUsageAttemptInput): Promise<UsageAttemptHandle> {
    const id = randomUUID();
    this.attempts.set(id, record);
    this.attemptRecords.set(id, {
      schemaVersion: record.schemaVersion ?? (record.modelRequestId ? 2 : 1),
      requestId: record.modelRequestId ?? null,
      attemptId: id,
      attemptOrdinal: record.attemptOrdinal,
      sessionId: record.sessionId,
      provider: record.provider,
      model: record.modelName,
      state: 'started',
      circuitState: record.circuitState,
      circuitDecision: record.circuitDecision,
      usage: {
        uncachedInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        reasoningSource: 'unavailable',
      },
      startedAt: record.requestStartedAt,
      provenance: record.schemaVersion === 1 || !record.modelRequestId
        ? 'legacy_reconstructed'
        : 'recorded',
    });
    return {
      id,
      logicalCallKey: record.logicalCallKey,
      modelRequestId: record.modelRequestId ?? null,
      attemptOrdinal: record.attemptOrdinal,
      modelId: 'research-lab',
      modelName: record.modelName,
      provider: record.provider,
      requestStartedAt: record.requestStartedAt,
      executionBackend: record.executionBackend ?? 'api',
      rateCardId: 'research-lab',
      rateWindowId: null,
      currency: 'usd',
      cacheHitRatePer1m: 0,
      cacheMissRatePer1m: 0,
      outputRatePer1m: 0,
    };
  }

  async completeAttempt(record: CompleteUsageAttemptInput): Promise<FinalizedUsageAttempt> {
    const attempt = this.attempts.get(record.attemptId);
    if (!attempt) throw new Error(`Usage attempt ${record.attemptId} was not found`);
    const current = this.attemptRecords.get(record.attemptId);
    if (!current) throw new Error(`Usage attempt ${record.attemptId} was not found`);
    if (current.state === 'succeeded') {
      return {
        id: record.attemptId,
        status: 'completed',
        debitStatus: 'not_applicable',
        promptTokens: current.usage.uncachedInput,
        cachedPromptTokens: current.usage.cacheRead,
        cacheWriteTokens: current.usage.cacheWrite,
        completionTokens: current.usage.output,
        totalTokens:
          current.usage.uncachedInput + current.usage.cacheRead
          + current.usage.cacheWrite + current.usage.output,
        reasoningTokens: current.usage.reasoning,
        reasoningSource: current.usage.reasoningSource,
        nativeCost: 0,
        overhead: 0,
        platformCost: 0,
        platformPrice: 0,
        credits: 0,
        debitedCredits: 0,
        currency: 'usd',
        model: attempt.modelName,
        billing: { platformMargin: 0, creditRatePerUsd: 0, overheadMultiplier: 0 },
        creditExempt: true,
        replayed: true,
      };
    }
    if (current.state !== 'started' && !current.settlementUncertain) {
      throw new Error(`Usage attempt ${record.attemptId} cannot complete from ${current.state}`);
    }
    const cacheWriteTokens = record.cacheWriteTokens ?? 0;
    const reasoningTokens = record.reasoningTokens ?? 0;
    const reasoningSource = record.reasoningSource ?? 'unavailable';
    this.attemptRecords.set(record.attemptId, {
      ...current,
      state: 'succeeded',
      settlementUncertain: false,
      providerRequestId: record.providerRequestId,
      retryDecision: record.retryDecision ?? 'stop',
      usage: {
        uncachedInput: record.promptTokens,
        cacheRead: record.cachedPromptTokens,
        cacheWrite: cacheWriteTokens,
        output: record.completionTokens,
        reasoning: reasoningTokens,
        reasoningSource,
      },
      completedAt: record.requestCompletedAt,
    });
    const finalized: FinalizedUsageAttempt = {
      id: record.attemptId,
      status: 'completed',
      debitStatus: 'not_applicable',
      promptTokens: record.promptTokens,
      cachedPromptTokens: record.cachedPromptTokens,
      cacheWriteTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      nativeCost: 0,
      overhead: 0,
      platformCost: 0,
      platformPrice: 0,
      credits: 0,
      debitedCredits: 0,
      currency: 'usd',
      model: attempt.modelName,
      reasoningTokens,
      reasoningSource,
      billing: { platformMargin: 0, creditRatePerUsd: 0, overheadMultiplier: 0 },
      creditExempt: true,
    };
    await this.recordTurnUsage({
      sessionId: attempt.sessionId,
      userId: attempt.userId,
      organizationId: attempt.organizationId,
      turn: attempt.turn,
      promptTokens: record.promptTokens,
      cachedPromptTokens: record.cachedPromptTokens,
      cacheWriteTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      nativeCost: 0,
      overhead: 0,
      platformCost: 0,
      platformPrice: 0,
      credits: 0,
      currency: 'usd',
      model: attempt.modelName,
      recordedAt: record.requestCompletedAt.getTime(),
    });
    return finalized;
  }

  async failAttempt(record: FailUsageAttemptInput): Promise<void> {
    const current = this.attemptRecords.get(record.attemptId);
    if (!current) throw new Error(`Usage attempt ${record.attemptId} was not found`);
    if (current.state === 'succeeded' || current.state === 'cancelled') return;
    this.attemptRecords.set(record.attemptId, {
      ...current,
      state: record.status === 'cancelled' ? 'cancelled' : 'failed',
      settlementUncertain: record.status === 'uncertain',
      providerRequestId: record.providerRequestId,
      errorClass: record.errorClass,
      retryDecision: record.retryDecision,
      backoffMs: record.backoffMs,
      usage: {
        ...current.usage,
        reasoning: record.reasoningTokens ?? current.usage.reasoning,
        reasoningSource: record.reasoningSource ?? current.usage.reasoningSource,
      },
      completedAt: record.requestCompletedAt,
    });
  }

  async recordTurnUsage(record: TurnUsageRecord): Promise<void> {
    const list = this.records.get(record.sessionId) ?? [];
    list.push(record);
    if (list.length > this.maxEntriesPerSession) {
      list.splice(0, list.length - this.maxEntriesPerSession);
    }
    this.records.set(record.sessionId, list);
  }

  async getSessionSummary(sessionId: string): Promise<UsageSummary | undefined> {
    const list = this.records.get(sessionId);
    if (!list || list.length === 0) {
      return undefined;
    }
    return list.reduce<UsageSummary>(
      (acc, item) => ({
        promptTokens: acc.promptTokens + item.promptTokens,
        cachedPromptTokens: (acc.cachedPromptTokens ?? 0) + (item.cachedPromptTokens ?? 0),
        cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (item.cacheWriteTokens ?? 0),
        completionTokens: acc.completionTokens + item.completionTokens,
        totalTokens: acc.totalTokens + item.totalTokens,
        nativeCost: acc.nativeCost + item.nativeCost,
        overhead: (acc.overhead ?? 0) + (item.overhead ?? 0),
        platformCost: acc.platformCost + item.platformCost,
        platformPrice: acc.platformPrice + item.platformPrice,
        credits: acc.credits + item.credits,
        entries: acc.entries + 1,
      }),
      {
        promptTokens: 0,
        cachedPromptTokens: 0,
        cacheWriteTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        nativeCost: 0,
        overhead: 0,
        platformCost: 0,
        platformPrice: 0,
        credits: 0,
        entries: 0,
      },
    );
  }

  async listAttemptsByRequest(requestId: string): Promise<ModelAttemptRecord[]> {
    return [...this.attemptRecords.values()]
      .filter((record) => record.requestId === requestId)
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal)
      .map((record) => structuredClone(record));
  }

  async listAttemptsBySession(sessionId: string): Promise<ModelAttemptRecord[]> {
    return [...this.attemptRecords.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
      .map((record) => structuredClone(record));
  }
}

export class DbUsageStore implements UsageStore {
  readonly billingMode = 'billable' as const;
  constructor(
    private readonly repo: {
      beginAttempt: (record: BeginUsageAttemptInput) => Promise<UsageAttemptHandle>;
      completeAttempt: (record: CompleteUsageAttemptInput) => Promise<FinalizedUsageAttempt>;
      failAttempt: (record: FailUsageAttemptInput) => Promise<void>;
      summarizeSession: (sessionId: string) => Promise<UsageSummary | undefined>;
      listAttemptsByRequest?: (requestId: string) => Promise<ModelAttemptRecord[]>;
      listAttemptsBySession?: (sessionId: string) => Promise<ModelAttemptRecord[]>;
    },
  ) {}

  beginAttempt(record: BeginUsageAttemptInput): Promise<UsageAttemptHandle> {
    return this.repo.beginAttempt(record);
  }

  completeAttempt(record: CompleteUsageAttemptInput): Promise<FinalizedUsageAttempt> {
    return this.repo.completeAttempt(record);
  }

  failAttempt(record: FailUsageAttemptInput): Promise<void> {
    return this.repo.failAttempt(record);
  }

  async recordTurnUsage(record: TurnUsageRecord): Promise<void> {
    void record;
    throw new Error('Billable usage requires beginAttempt and completeAttempt');
  }

  async getSessionSummary(sessionId: string): Promise<UsageSummary | undefined> {
    return this.repo.summarizeSession(sessionId);
  }

  async listAttemptsByRequest(requestId: string): Promise<ModelAttemptRecord[]> {
    return this.repo.listAttemptsByRequest?.(requestId) ?? [];
  }

  async listAttemptsBySession(sessionId: string): Promise<ModelAttemptRecord[]> {
    return this.repo.listAttemptsBySession?.(sessionId) ?? [];
  }
}
