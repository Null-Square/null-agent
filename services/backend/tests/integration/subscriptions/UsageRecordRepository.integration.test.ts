import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import type { PoolClient } from 'pg';
import type { UsageRecordRepository as UsageRecordRepositoryClass } from '@/domains/platform/subscriptions/infrastructure/UsageRecordRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('UsageRecordRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let UsageRecordRepository: typeof UsageRecordRepositoryClass;
  let repo: InstanceType<typeof UsageRecordRepository>;
  let lockClient: PoolClient | undefined;
  let modelId: string;
  let rateCardId: string;
  let recordOrdinal = 0;
  let skip = false;

  const insertUser = async (id: string) => {
    await harness?.pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, `user-${id}@example.com`, 'hash'],
    );
  };

  const createRecord = async (values: {
    sessionId: string;
    userId: string;
    recordedAt: Date;
    model?: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    credits: number;
  }) => {
    return repo.create({
      sessionId: values.sessionId,
      logicalCallKey: `${values.sessionId}:${values.recordedAt.getTime()}:${++recordOrdinal}`,
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'test',
      modelId,
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: values.recordedAt,
      requestCompletedAt: values.recordedAt,
      status: 'completed',
      rateCardId,
      cacheHitRatePer1m: 0,
      cacheMissRatePer1m: 0,
      outputRatePer1m: 0,
      quotedPlatformMargin: 0,
      quotedOverheadMultiplier: 0,
      quotedCreditRatePerUsd: 100,
      debitStatus: 'applied',
      debitedCredits: values.credits,
      userId: values.userId,
      turn: 1,
      promptTokens: values.promptTokens,
      cachedPromptTokens: 0,
      completionTokens: values.completionTokens,
      totalTokens: values.totalTokens,
      model: values.model ?? null,
      cost: 0,
      overhead: 0,
      platformCost: 0,
      platformPrice: 0,
      credits: values.credits,
      currency: 'usd',
      recordedAt: values.recordedAt,
      createdAt: values.recordedAt,
    });
  };

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
        return;
      }
      vi.resetModules();
      vi.doMock('@/db/client', () => ({
        db: harness!.db,
      }));
      ({ UsageRecordRepository } = await import('@/domains/platform/subscriptions/infrastructure/UsageRecordRepository'));
      repo = new UsageRecordRepository(harness.db as any);
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    recordOrdinal = 0;
    await harness.truncateAll();
    await harness.pool.query('TRUNCATE TABLE usage_records RESTART IDENTITY CASCADE;');
    await harness.pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE;');
    modelId = newId();
    rateCardId = newId();
    await harness.pool.query(
      `INSERT INTO models (id, name, provider, model_name, request_profile)
       VALUES ($1, 'Test', 'TEST', 'test-model', '{}'::jsonb)`,
      [modelId],
    );
    await harness.pool.query(
      `INSERT INTO model_rate_cards (
         id, model_id, effective_from, currency,
         base_cache_hit_input_per_1m, base_cache_miss_input_per_1m, base_output_per_1m
       ) VALUES ($1, $2, '2020-01-01T00:00:00Z', 'usd', 0, 0, 0)`,
      [rateCardId, modelId],
    );
    lockClient = await harness.pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('LOCK TABLE users, agent_sessions, usage_records IN ACCESS SHARE MODE');
  });

  afterEach(async () => {
    if (!lockClient) return;
    await lockClient.query('ROLLBACK');
    lockClient.release();
    lockClient = undefined;
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('writes and summarizes session usage', async () => {
    if (!harness) return;
    const userId = newId();
    await insertUser(userId);
    const sessionId = await insertAgentSession(harness.db, { userId });

    const firstAt = new Date('2025-01-01T00:00:00Z');
    const secondAt = new Date('2025-01-01T01:00:00Z');

    await createRecord({
      sessionId,
      userId,
      recordedAt: firstAt,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      credits: 1,
    });
    await createRecord({
      sessionId,
      userId,
      recordedAt: secondAt,
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      credits: 2,
    });

    const summary = await repo.summarizeSession(sessionId);
    expect(Number(summary?.entries)).toBe(2);
    expect(Number(summary?.promptTokens)).toBe(30);
    expect(Number(summary?.completionTokens)).toBe(15);
    expect(Number(summary?.totalTokens)).toBe(45);
    expect(Number(summary?.credits)).toBe(3);

    const list = await repo.listBySession(sessionId, 10, 'asc');
    expect(list).toHaveLength(2);
    expect(list[0]?.recordedAt.toISOString()).toBe(firstAt.toISOString());

    await expect(repo.hasRecordsForSession(sessionId)).resolves.toBe(true);
    await expect(repo.hasRecordsForSession(newId())).resolves.toBe(false);
  });

  itMaybe('summarizes user usage by day and model', async () => {
    if (!harness) return;
    const userId = newId();
    await insertUser(userId);
    const sessionId = await insertAgentSession(harness.db, { userId });

    const day1 = new Date('2025-01-01T05:00:00Z');
    const day2 = new Date('2025-01-02T05:00:00Z');

    await createRecord({
      sessionId,
      userId,
      recordedAt: day1,
      model: 'gpt-4',
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      credits: 1,
    });
    await createRecord({
      sessionId,
      userId,
      recordedAt: day2,
      model: 'gpt-4',
      promptTokens: 40,
      completionTokens: 10,
      totalTokens: 50,
      credits: 0.5,
    });
    await createRecord({
      sessionId,
      userId,
      recordedAt: day2,
      model: 'gpt-3.5',
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      credits: 0.3,
    });
    await createRecord({
      sessionId,
      userId,
      recordedAt: day2,
      model: null,
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      credits: 0.05,
    });

    const since = new Date('2025-01-02T00:00:00Z');
    const userSummary = await repo.summarizeUser(userId, since);
    expect(Number(userSummary?.totalTokens)).toBe(85);
    expect(Number(userSummary?.credits)).toBeCloseTo(0.85);

    const daily = await repo.listUserDaily(userId);
    expect(daily).toHaveLength(2);
    expect(Number(daily[0]?.totalTokens)).toBe(100);
    expect(Number(daily[1]?.totalTokens)).toBe(85);
    expect(daily[0]?.date).toContain('2025-01-01');
    expect(daily[1]?.date).toContain('2025-01-02');

    const models = await repo.listUserModels(userId);
    expect(models).toHaveLength(2);
    expect(models[0]?.model).toBe('gpt-4');
    expect(Number(models[0]?.totalTokens)).toBe(150);
    expect(models[1]?.model).toBe('gpt-3.5');
  });

  itMaybe('persists ordered v2 attempts and blocks settlement after cancellation', async () => {
    if (!harness) return;
    const userId = newId();
    await insertUser(userId);
    const sessionId = await insertAgentSession(harness.db, { userId });
    const requestId = newId();
    await harness.pool.query(
      `INSERT INTO model_request_records (
         request_id, schema_version, session_id, turn, call_ordinal, route_reason,
         provider, model, routed_context_capacity, messages, system_content, tools,
         generation_settings, context_measurement_refs, transformation_refs, envelope, digest
       ) VALUES (
         $1, 3, $2, 1, 1, 'session_pinned', 'test', 'test-model', 1000,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
         '[]'::jsonb, '{}'::jsonb, 'digest'
       )`,
      [requestId, sessionId],
    );
    const base = {
      schemaVersion: 2,
      sessionId,
      userId,
      modelId,
      modelRequestId: requestId,
      logicalCallKey: `${sessionId}:1:session_pinned:1`,
      callOrdinal: 1,
      provider: 'test',
      modelName: 'test-model',
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: new Date('2026-08-25T00:00:00.000Z'),
      billing: { platformMargin: 0, overheadMultiplier: 0, creditRatePerUsd: 100 },
      creditExempt: true,
      circuitState: 'closed' as const,
      circuitDecision: 'allow' as const,
    };
    const first = await repo.beginAttempt({ ...base, attemptOrdinal: 1 });
    await repo.failAttempt({
      attemptId: first.id,
      status: 'failed',
      requestCompletedAt: new Date('2026-08-25T00:00:01.000Z'),
      errorClass: 'network.connection_failed',
      retryDecision: 'retry',
      backoffMs: 250,
    });
    const second = await repo.beginAttempt({
      ...base,
      attemptOrdinal: 2,
      requestStartedAt: new Date('2026-08-25T00:00:02.000Z'),
    });
    await repo.completeAttempt({
      attemptId: second.id,
      requestCompletedAt: new Date('2026-08-25T00:00:03.000Z'),
      providerRequestId: 'provider-request-2',
      promptTokens: 500,
      cachedPromptTokens: 300,
      cacheWriteTokens: 200,
      completionTokens: 100,
      totalTokens: 1100,
      reasoningTokens: 40,
      reasoningSource: 'reported',
    });
    const attempts = await repo.listAttemptsByRequest(requestId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      requestId,
      attemptOrdinal: 1,
      state: 'failed',
      retryDecision: 'retry',
      backoffMs: 250,
    });
    expect(attempts[1]).toMatchObject({
      requestId,
      attemptOrdinal: 2,
      state: 'succeeded',
      retryDecision: 'stop',
      usage: {
        uncachedInput: 500,
        cacheRead: 300,
        cacheWrite: 200,
        output: 100,
        reasoning: 40,
        reasoningSource: 'reported',
      },
    });

    const cancelledRequestId = newId();
    await harness.pool.query(
      `INSERT INTO model_request_records (
         request_id, schema_version, session_id, turn, call_ordinal, route_reason,
         provider, model, routed_context_capacity, messages, system_content, tools,
         generation_settings, context_measurement_refs, transformation_refs, envelope, digest
       ) VALUES (
         $1, 3, $2, 2, 1, 'session_pinned', 'test', 'test-model', 1000,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
         '[]'::jsonb, '{}'::jsonb, 'digest-cancelled'
       )`,
      [cancelledRequestId, sessionId],
    );
    const cancelled = await repo.beginAttempt({
      ...base,
      modelRequestId: cancelledRequestId,
      logicalCallKey: `${sessionId}:2:session_pinned:1`,
      attemptOrdinal: 1,
    });
    await repo.failAttempt({
      attemptId: cancelled.id,
      status: 'cancelled',
      requestCompletedAt: new Date('2026-08-25T00:00:04.000Z'),
      errorClass: 'request_cancelled',
      retryDecision: 'stop',
    });
    await expect(repo.completeAttempt({
      attemptId: cancelled.id,
      requestCompletedAt: new Date('2026-08-25T00:00:05.000Z'),
      promptTokens: 1,
      cachedPromptTokens: 0,
      completionTokens: 1,
      totalTokens: 2,
    })).rejects.toThrow(/cannot complete from cancelled/u);
  });
});



