import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type DatabaseClient } from '@/db/client';
import {
  usageRecords,
  type NewUsageRecordRow,
  type UsageRecordRow,
} from '@/db/schema';
import type {
  BeginUsageAttemptInput,
  CompleteUsageAttemptInput,
  FailUsageAttemptInput,
  FinalizedUsageAttempt,
  ModelAttemptRecord,
  UsageAttemptHandle,
} from '@/domains/agent-brain/ports';
import { ModelRateRepository } from '@/domains/platform/models/ModelRateRepository';

export type UsageSummaryRow = {
  promptTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  creditEquivalent: number;
  credits: number;
  entries: number;
};

export type UsageDaySummaryRow = {
  date: string;
  totalTokens: number;
  credits: number;
  platformCost: number;
  platformPrice: number;
};

export type UsageModelSummaryRow = {
  model: string;
  totalTokens: number;
  credits: number;
  platformCost: number;
  platformPrice: number;
};

export class UsageRecordRepository {
  constructor(private readonly database: DatabaseClient = db) {}

  async beginAttempt(input: BeginUsageAttemptInput): Promise<UsageAttemptHandle> {
    // Usage is recorded for cost visibility only: nothing is charged, so nothing here may refuse a
    // model call. A model without a rate card is recorded at zero rates with no rate card.
    //
    // An execution backend may answer with a model other than the pinned deployment, so the quote
    // is resolved by the name of the model that actually ran when it differs.
    const rates = new ModelRateRepository(this.database);
    const substituted =
      typeof input.effectiveModelName === 'string'
      && input.effectiveModelName.length > 0
      && input.effectiveModelName !== input.modelName;
    const quote = await (substituted
      ? rates.resolveQuoteByModelName(input.effectiveModelName as string, input.requestStartedAt)
      : input.modelId
        ? rates.resolveQuote(input.modelId, input.requestStartedAt)
        : Promise.reject(new Error('No pinned model deployment')))
      .catch(() => null);
    const recordedModelName = quote?.modelName ?? (substituted ? (input.effectiveModelName as string) : input.modelName);
    const row = await this.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.logicalCallKey}, 0))`);
      const ordinalResult = await tx.execute(sql`
        SELECT COALESCE(MAX(${usageRecords.attemptOrdinal}), 0) AS max_attempt
        FROM ${usageRecords}
        WHERE ${usageRecords.logicalCallKey} = ${input.logicalCallKey}
      `);
      const previousOrdinal = Number((ordinalResult.rows[0] as { max_attempt?: number | string } | undefined)?.max_attempt ?? 0);
      const attemptOrdinal = Math.max(input.attemptOrdinal, previousOrdinal + 1);
      const [inserted] = await tx.insert(usageRecords).values({
        sessionId: input.sessionId,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        turn: input.turn ?? null,
        logicalCallKey: input.logicalCallKey,
        modelRequestId: input.modelRequestId ?? null,
        attemptSchemaVersion: input.schemaVersion ?? (input.modelRequestId ? 2 : 1),
        attemptOrdinal,
        callOrdinal: input.callOrdinal,
        // The substituted model's own provider, so the row's identity is internally consistent:
        // `OPENAI`/`gpt-5.4` reached over an external execution backend is exactly what happened.
        provider: substituted && quote ? quote.provider : input.provider,
        modelId: quote?.modelId ?? input.modelId ?? null,
        model: recordedModelName,
        executionBackend: input.executionBackend ?? 'api',
        requestedCategory: input.requestedCategory ?? null,
        routeReason: input.routeReason,
        fallbackOrdinal: input.fallbackOrdinal,
        requestStartedAt: input.requestStartedAt,
        status: 'started',
        circuitState: input.circuitState ?? null,
        circuitDecision: input.circuitDecision ?? null,
        rateCardId: quote?.rateCardId ?? null,
        rateWindowId: quote?.rateWindowId ?? null,
        cacheHitRatePer1m: quote?.cacheHitInputPer1m ?? 0,
        cacheMissRatePer1m: quote?.cacheMissInputPer1m ?? 0,
        outputRatePer1m: quote?.outputPer1m ?? 0,
        quotedPlatformMargin: 0,
        quotedOverheadMultiplier: 0,
        quotedCreditRatePerUsd: 0,
        creditExempt: true,
        debitStatus: 'not_applicable',
        currency: quote?.currency ?? 'usd',
        recordedAt: input.requestStartedAt,
      }).returning();
      return inserted;
    });
    if (!row) throw new Error('Failed to persist provider attempt before dispatch');
    return {
      id: row.id,
      logicalCallKey: row.logicalCallKey,
      modelRequestId: row.modelRequestId,
      attemptOrdinal: row.attemptOrdinal,
      modelId: row.modelId,
      modelName: row.model ?? recordedModelName,
      provider: row.provider,
      requestStartedAt: row.requestStartedAt,
      executionBackend: row.executionBackend ?? 'api',
      rateCardId: row.rateCardId,
      rateWindowId: row.rateWindowId,
      currency: row.currency,
      cacheHitRatePer1m: Number(row.cacheHitRatePer1m),
      cacheMissRatePer1m: Number(row.cacheMissRatePer1m),
      outputRatePer1m: Number(row.outputRatePer1m),
    };
  }

  async completeAttempt(input: CompleteUsageAttemptInput): Promise<FinalizedUsageAttempt> {
    const cacheWriteTokens = input.cacheWriteTokens ?? 0;
    const reasoningTokens = input.reasoningTokens ?? 0;
    const tokenCounts = [
      input.promptTokens,
      input.cachedPromptTokens,
      cacheWriteTokens,
      input.completionTokens,
      input.totalTokens,
      reasoningTokens,
    ];
    if (tokenCounts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('Provider usage token counts must be non-negative safe integers');
    }
    if (reasoningTokens > input.completionTokens) {
      throw new Error('Provider reasoning tokens cannot exceed output tokens');
    }
    if (input.totalTokens !== input.promptTokens + input.cachedPromptTokens + cacheWriteTokens + input.completionTokens) {
      throw new Error('Provider usage total must equal uncached input, cache read, cache write, and output tokens');
    }
    return this.database.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.id, input.attemptId))
        .limit(1)
        .for('update');
      if (!attempt) throw new Error(`Usage attempt ${input.attemptId} was not found`);
      if (attempt.status === 'completed') return { ...this.toFinalized(attempt), replayed: true };
      if (attempt.status !== 'started' && attempt.status !== 'uncertain') {
        throw new Error(`Usage attempt ${input.attemptId} cannot complete from ${attempt.status}`);
      }

      const nativeCost =
        (input.promptTokens / 1_000_000) * Number(attempt.cacheMissRatePer1m) +
        (input.cachedPromptTokens / 1_000_000) * Number(attempt.cacheHitRatePer1m) +
        (cacheWriteTokens / 1_000_000) * Number(attempt.cacheMissRatePer1m) +
        (input.completionTokens / 1_000_000) * Number(attempt.outputRatePer1m);
      // Cost visibility only: the provider's own price, with no platform overhead, margin or credits.
      const overhead = 0;
      const platformCost = nativeCost;
      const platformPrice = nativeCost;
      const credits = 0;

      const [completed] = await tx.update(usageRecords).set({
        providerRequestId: input.providerRequestId ?? null,
        reportedModel: input.reportedModel ?? null,
        requestCompletedAt: input.requestCompletedAt,
        status: 'completed',
        retryDecision: input.retryDecision ?? 'stop',
        promptTokens: input.promptTokens,
        cachedPromptTokens: input.cachedPromptTokens,
        cacheWriteTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        reasoningTokens,
        reasoningSource: input.reasoningSource ?? 'unavailable',
        cost: nativeCost,
        overhead,
        platformCost,
        platformPrice,
        credits,
        debitedCredits: 0,
        debitStatus: 'not_applicable',
      }).where(eq(usageRecords.id, input.attemptId)).returning();
      if (!completed) throw new Error(`Failed to finalize usage attempt ${input.attemptId}`);
      return this.toFinalized(completed);
    });
  }

  async failAttempt(input: FailUsageAttemptInput): Promise<void> {
    await this.database.update(usageRecords).set({
      status: input.status,
      requestCompletedAt: input.requestCompletedAt,
      providerRequestId: input.providerRequestId ?? null,
      reportedModel: input.reportedModel ?? null,
      errorClass: input.errorClass ?? null,
      retryDecision: input.retryDecision ?? null,
      backoffMs: input.backoffMs ?? null,
      reasoningTokens: input.reasoningTokens ?? 0,
      reasoningSource: input.reasoningSource ?? 'unavailable',
    }).where(and(
      eq(usageRecords.id, input.attemptId),
      input.status === 'cancelled'
        ? inArray(usageRecords.status, ['started', 'uncertain'])
        : eq(usageRecords.status, 'started'),
    ));
  }

  async listAttemptsByRequest(requestId: string): Promise<ModelAttemptRecord[]> {
    const rows = await this.database
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.modelRequestId, requestId))
      .orderBy(asc(usageRecords.attemptOrdinal));
    return rows.map((row) => this.toModelAttempt(row));
  }

  async listAttemptsBySession(sessionId: string): Promise<ModelAttemptRecord[]> {
    const rows = await this.database
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId))
      .orderBy(asc(usageRecords.recordedAt), asc(usageRecords.attemptOrdinal));
    return rows.map((row) => this.toModelAttempt(row));
  }

  private toModelAttempt(row: UsageRecordRow): ModelAttemptRecord {
    const state: ModelAttemptRecord['state'] = row.status === 'completed'
      ? 'succeeded'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.status === 'started'
          ? 'started'
          : 'failed';
    return {
      schemaVersion: row.attemptSchemaVersion,
      requestId: row.modelRequestId,
      attemptId: row.id,
      attemptOrdinal: row.attemptOrdinal,
      sessionId: row.sessionId,
      provider: row.provider,
      model: row.model ?? row.reportedModel ?? 'unknown',
      providerRequestId: row.providerRequestId,
      state,
      ...(row.status === 'uncertain' ? { settlementUncertain: true } : {}),
      errorClass: row.errorClass,
      retryDecision: row.retryDecision as ModelAttemptRecord['retryDecision'],
      backoffMs: row.backoffMs,
      circuitState: row.circuitState as ModelAttemptRecord['circuitState'],
      circuitDecision: row.circuitDecision as ModelAttemptRecord['circuitDecision'],
      usage: {
        uncachedInput: row.promptTokens,
        cacheRead: row.cachedPromptTokens,
        cacheWrite: row.cacheWriteTokens,
        output: row.completionTokens,
        reasoning: row.reasoningTokens,
        reasoningSource: row.reasoningSource as ModelAttemptRecord['usage']['reasoningSource'],
      },
      startedAt: row.requestStartedAt,
      completedAt: row.requestCompletedAt,
      provenance: row.attemptSchemaVersion >= 2 ? 'recorded' : 'legacy_reconstructed',
    };
  }

  private toFinalized(row: UsageRecordRow): FinalizedUsageAttempt {
    return {
      id: row.id,
      status: row.status as FinalizedUsageAttempt['status'],
      debitStatus: row.debitStatus as FinalizedUsageAttempt['debitStatus'],
      promptTokens: row.promptTokens,
      cachedPromptTokens: row.cachedPromptTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      nativeCost: Number(row.cost ?? 0),
      overhead: Number(row.overhead ?? 0),
      platformCost: Number(row.platformCost ?? 0),
      platformPrice: Number(row.platformPrice ?? 0),
      credits: Number(row.credits ?? 0),
      debitedCredits: Number(row.debitedCredits ?? 0),
      currency: row.currency,
      model: row.model ?? row.reportedModel ?? 'unknown',
      reasoningTokens: row.reasoningTokens,
      reasoningSource: row.reasoningSource as FinalizedUsageAttempt['reasoningSource'],
      billing: {
        platformMargin: Number(row.quotedPlatformMargin),
        creditRatePerUsd: Number(row.quotedCreditRatePerUsd),
        overheadMultiplier: Number(row.quotedOverheadMultiplier),
      },
      creditExempt: row.creditExempt,
    };
  }

  async create(values: NewUsageRecordRow): Promise<UsageRecordRow> {
    const [row] = await this.database.insert(usageRecords).values(values).returning();
    if (!row) {
      throw new Error('Failed to insert usage record');
    }
    return row;
  }

  async listBySession(sessionId: string, limit = 500, order: 'asc' | 'desc' = 'desc'): Promise<UsageRecordRow[]> {
    return this.database
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId))
      .orderBy(order === 'asc' ? usageRecords.recordedAt : desc(usageRecords.recordedAt))
      .limit(limit);
  }

  async summarizeSession(sessionId: string): Promise<UsageSummaryRow | undefined> {
    const [row] = await this.database
      .select({
        promptTokens: sql<number>`COALESCE(sum(${usageRecords.promptTokens}), 0)`,
        cachedPromptTokens: sql<number>`COALESCE(sum(${usageRecords.cachedPromptTokens}), 0)`,
        cacheWriteTokens: sql<number>`COALESCE(sum(${usageRecords.cacheWriteTokens}), 0)`,
        completionTokens: sql<number>`COALESCE(sum(${usageRecords.completionTokens}), 0)`,
        totalTokens: sql<number>`COALESCE(sum(${usageRecords.totalTokens}), 0)`,
        nativeCost: sql<number>`COALESCE(sum(${usageRecords.cost}), 0)`,
        overhead: sql<number>`COALESCE(sum(${usageRecords.overhead}), 0)`,
        platformCost: sql<number>`COALESCE(sum(${usageRecords.platformCost}), 0)`,
        platformPrice: sql<number>`COALESCE(sum(${usageRecords.platformPrice}), 0)`,
        creditEquivalent: sql<number>`COALESCE(sum(${usageRecords.credits}), 0)`,
        credits: sql<number>`COALESCE(sum(${usageRecords.debitedCredits}), 0)`,
        entries: sql<number>`COUNT(*)`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.sessionId, sessionId), eq(usageRecords.status, 'completed')));
    return row;
  }

  async hasRecordsForSession(sessionId: string): Promise<boolean> {
    const [row] = await this.database
      .select({ count: sql<number>`COUNT(*)` })
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId))
      .limit(1);
    return Boolean(row && (row.count ?? 0) > 0);
  }

  async summarizeUser(userId: string, since?: Date): Promise<UsageSummaryRow | undefined> {
    const conditions = [eq(usageRecords.userId, userId), eq(usageRecords.status, 'completed')];
    if (since) {
      conditions.push(gte(usageRecords.recordedAt, since));
    }
    const [row] = await this.database
      .select({
        promptTokens: sql<number>`COALESCE(sum(${usageRecords.promptTokens}), 0)`,
        cachedPromptTokens: sql<number>`COALESCE(sum(${usageRecords.cachedPromptTokens}), 0)`,
        completionTokens: sql<number>`COALESCE(sum(${usageRecords.completionTokens}), 0)`,
        totalTokens: sql<number>`COALESCE(sum(${usageRecords.totalTokens}), 0)`,
        nativeCost: sql<number>`COALESCE(sum(${usageRecords.cost}), 0)`,
        overhead: sql<number>`COALESCE(sum(${usageRecords.overhead}), 0)`,
        platformCost: sql<number>`COALESCE(sum(${usageRecords.platformCost}), 0)`,
        platformPrice: sql<number>`COALESCE(sum(${usageRecords.platformPrice}), 0)`,
        creditEquivalent: sql<number>`COALESCE(sum(${usageRecords.credits}), 0)`,
        credits: sql<number>`COALESCE(sum(${usageRecords.debitedCredits}), 0)`,
        entries: sql<number>`COUNT(*)`,
      })
      .from(usageRecords)
      .where(and(...conditions));
    return row;
  }

  async listUserDaily(userId: string, since?: Date): Promise<UsageDaySummaryRow[]> {
    const conditions = [eq(usageRecords.userId, userId), eq(usageRecords.status, 'completed')];
    if (since) {
      conditions.push(gte(usageRecords.recordedAt, since));
    }
    const day = sql<string>`date_trunc('day', ${usageRecords.recordedAt})`;
    const rows = await this.database
      .select({
        date: day,
        totalTokens: sql<number>`COALESCE(sum(${usageRecords.totalTokens}), 0)`,
        credits: sql<number>`COALESCE(sum(${usageRecords.debitedCredits}), 0)`,
        platformCost: sql<number>`COALESCE(sum(${usageRecords.platformCost}), 0)`,
        platformPrice: sql<number>`COALESCE(sum(${usageRecords.platformPrice}), 0)`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(day)
      .orderBy(day);
    return rows.map((row) => ({
      ...row,
      date: typeof row.date === 'object' && row.date !== null ? (row.date as Date).toISOString() : `${row.date}`,
    }));
  }

  async listUserModels(userId: string, since?: Date, limit = 5): Promise<UsageModelSummaryRow[]> {
    const conditions = [
      eq(usageRecords.userId, userId),
      eq(usageRecords.status, 'completed'),
      isNotNull(usageRecords.model),
    ];
    if (since) {
      conditions.push(gte(usageRecords.recordedAt, since));
    }
    const rows = await this.database
      .select({
        model: usageRecords.model,
        totalTokens: sql<number>`COALESCE(sum(${usageRecords.totalTokens}), 0)`,
        credits: sql<number>`COALESCE(sum(${usageRecords.debitedCredits}), 0)`,
        platformCost: sql<number>`COALESCE(sum(${usageRecords.platformCost}), 0)`,
        platformPrice: sql<number>`COALESCE(sum(${usageRecords.platformPrice}), 0)`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.model)
      .orderBy(desc(sql<number>`sum(${usageRecords.totalTokens})`))
      .limit(limit);
    
    // Filter null models and cast to UsageModelSummaryRow
    return rows
      .filter((row): row is typeof row & { model: string } => row.model !== null)
      .map((row) => ({
        model: row.model,
        totalTokens: row.totalTokens,
        credits: row.credits,
        platformCost: row.platformCost,
        platformPrice: row.platformPrice,
      }));
  }
}
