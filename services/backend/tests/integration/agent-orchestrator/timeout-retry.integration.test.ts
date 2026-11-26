import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
/**
 * RetrySchedulerPort integration (provider timeout -> DB backoff).
 *
 * Verifies:
 * - Retryable provider timeout triggers TurnFailurePolicy retry flow.
 * - RetrySchedulerPort schedules one durable journal continuation.
 */

import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession } from '../../helpers/agentSessionDb';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { SessionEventJournalRepository } from '@/domains/agent-brain/adapters/persistence/SessionEventJournalRepository';
import { SessionJournalService } from '@/domains/agent-brain/application/services/SessionJournalService';
import { TurnFailurePolicy } from '@/domains/agent-brain/application/orchestration/services/TurnFailurePolicy';
import { AutomationGuardHandler } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('RetrySchedulerPort (timeout -> DB backoff)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> = null!;
  let repo: SessionRepository;

  beforeAll(async () => {
    harness = await setupTestDb();
    repo = new SessionRepository(harness!.db as any);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
    repo = new SessionRepository(harness!.db as any);
  });

  it('schedules next_attempt_at for retryable provider timeout', async () => {
    const sessionId = await insertAgentSession(harness!.db, {
      mode: 'automated',
      metadata: { modelName: 'test-model' },
    });
    const journalRepository = new SessionEventJournalRepository(harness!.db as never);
    const journal = new SessionJournalService(journalRepository);
    await journal.append(sessionId, [{
      idempotencyKey: 'session.created',
      event: {
        eventType: 'session.created',
        payload: { modelName: 'test-model', mode: 'automated' },
      },
    }]);
    const session = {
      id: sessionId,
      mode: 'automated',
      modelName: 'test-model',
      profileKey: 'test',
      flags: {},
      turn: 1,
    } as any;
    const sessionStore = {
      get: vi.fn(() => session),
      setAsync: vi.fn(async () => undefined),
      recordExecutionDeferredAsync: vi.fn(async (
        id: string,
        reason: string,
        retryAt: Date,
        idempotencyKey: string,
      ) => journal.append(id, [{
        idempotencyKey,
        event: {
          eventType: 'execution.deferred',
          payload: { reason, retryAt: retryAt.toISOString() },
        },
      }], { nextAttemptAt: retryAt })),
    };

    const guard = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy({ requireReport: true }),
      sessionRepository: { setBlockedReason: vi.fn(async () => true) },
    });

    const policy = new TurnFailurePolicy({
      sessionStore: sessionStore as any,
      sessionLifecycle: {
        transitionToBlocked: vi.fn().mockResolvedValue(undefined),
      },
      retryScheduler: {
        scheduleRetry: (params) => guard.scheduleRetry(params),
      },
    });

    const error = new AppError(ERROR_CODES.LLM_TIMEOUT, 'Request timed out.', { retryAfterMs: 25 });

    await policy.handleError({
      sessionId: session.id,
      error,
      sessionState: session,
      turnNumber: 1,
      turnStream: { raw: vi.fn() },
      modelName: session.modelName,
      provider: 'openai',
      processMessage: async () => undefined,
    });

    const row = await repo.findById(session.id);
    expect(row?.nextAttemptAt).toBeTruthy();
    expect(row?.blockedReason).toBeNull();
    expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect((await journal.load(session.id)).at(-1)?.eventType).toBe('execution.deferred');
  });
});
