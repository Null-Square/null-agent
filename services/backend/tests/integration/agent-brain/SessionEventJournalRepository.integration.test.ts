import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentMessages, agentSessionEvents, agentSessions } from '@/db/schema';
import { SessionEventJournalRepository } from '@/domains/agent-brain/adapters/persistence';
import { SessionJournalService } from '@/domains/agent-brain/application/services/SessionJournalService';
import { SessionJournalRecoveryService } from '@/domains/agent-brain/application/services/SessionJournalRecoveryService';
import {
  SessionJournalConflictError,
  SessionJournalIdempotencyError,
} from '@/domains/agent-brain/ports';
import { insertAgentSession } from '../../helpers/agentSessionDb';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('SessionEventJournalRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    harness = await setupTestDb();
    if (!harness) skip = true;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.truncateAll();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('appends a contiguous batch and reads only by sequence', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);

    const appended = await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [
        {
          eventId: randomUUID(),
          eventType: 'session.created',
          payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
        },
        {
          eventId: randomUUID(),
          eventType: 'input.accepted',
          payload: {
            message: { id: randomUUID(), role: 'user', content: 'continue', timestamp: 10 },
          },
        },
      ],
    });

    expect(appended.map((event) => event.sequence)).toEqual([1, 2]);
    expect((await repository.load(sessionId)).map((event) => event.eventType)).toEqual([
      'session.created',
      'input.accepted',
    ]);
    expect((await repository.loadAfter(sessionId, 1)).map((event) => event.sequence)).toEqual([2]);
    expect(await repository.lastSequence(sessionId)).toBe(2);
  });

  itMaybe('returns the committed batch when an acknowledgement-lost append is retried', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const draft = {
      eventId: randomUUID(),
      eventType: 'session.created' as const,
      payload: { modelName: 'claude-opus-4-8', mode: 'automated' as const },
    };

    const first = await repository.append({ sessionId, expectedSequence: 0, events: [draft] });
    const replay = await repository.append({ sessionId, expectedSequence: 0, events: [draft] });

    expect(replay).toEqual(first);
    expect(await repository.lastSequence(sessionId)).toBe(1);
  });

  itMaybe('replays a service-level idempotency key after the journal tail advances', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const journal = new SessionJournalService(repository);
    const input = {
      idempotencyKey: 'command:start:1',
      event: {
        eventType: 'session.start_requested' as const,
        payload: { requestedBy: 'integration-test' },
      },
    };

    const first = await journal.append(sessionId, [input]);
    await journal.append(sessionId, [{
      idempotencyKey: 'command:stop:2',
      event: {
        eventType: 'session.stop_requested',
        payload: { requestedBy: 'integration-test' },
      },
    }]);
    const replay = await journal.append(sessionId, [input]);

    expect(replay).toEqual(first);
    expect(await repository.lastSequence(sessionId)).toBe(2);
  });

  itMaybe('commits wake-up coordination atomically without letting an old replay undo a newer Stop', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const requestedAt = new Date('2026-08-28T12:00:00.000Z');
    const start = {
      eventId: randomUUID(),
      eventType: 'session.start_requested' as const,
      payload: { requestedBy: 'integration-test' },
      createdAt: requestedAt,
    };

    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [start],
      coordination: { nextAttemptAt: requestedAt, blockedReason: null },
    });
    let [session] = await harness.db
      .select({
        nextAttemptAt: agentSessions.nextAttemptAt,
        blockedReason: agentSessions.blockedReason,
        metadata: agentSessions.metadata,
        executionClaimToken: agentSessions.executionClaimToken,
        executionClaimExpiresAt: agentSessions.executionClaimExpiresAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(session?.nextAttemptAt?.toISOString()).toBe(requestedAt.toISOString());

    await harness.db
      .update(agentSessions)
      .set({
        executionClaimToken: 'worker-claim',
        executionClaimExpiresAt: new Date('2026-08-28T12:10:00.000Z'),
      })
      .where(eq(agentSessions.id, sessionId));

    await repository.append({
      sessionId,
      expectedSequence: 1,
      events: [{
        eventId: randomUUID(),
        eventType: 'session.stop_requested',
        payload: { requestedBy: 'integration-test' },
      }],
      coordination: {
        nextAttemptAt: null,
        revokeExecutionClaim: true,
        blockedReason: 'user_paused',
        blockedMeta: { stoppedBy: 'integration-test' },
      },
    });

    // Simulate the Start caller retrying after its acknowledgement was lost.
    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [start],
      coordination: { nextAttemptAt: requestedAt, blockedReason: null },
    });
    [session] = await harness.db
      .select({
        nextAttemptAt: agentSessions.nextAttemptAt,
        blockedReason: agentSessions.blockedReason,
        metadata: agentSessions.metadata,
        executionClaimToken: agentSessions.executionClaimToken,
        executionClaimExpiresAt: agentSessions.executionClaimExpiresAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(session?.nextAttemptAt).toBeNull();
    expect(session?.blockedReason).toBe('user_paused');
    expect(session?.metadata).toMatchObject({ blockedMeta: { stoppedBy: 'integration-test' } });
    expect(session?.executionClaimToken).toBeNull();
    expect(session?.executionClaimExpiresAt).toBeNull();
  });

  itMaybe('preserves an existing backoff and atomically reopens a completed session on Start', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const backoffAt = new Date('2026-08-28T12:05:00.000Z');

    await harness.db
      .update(agentSessions)
      .set({
        completed: true,
        blockedReason: 'error',
        metadata: {
          blockedMeta: { recoverable: false },
          flags: { session: { completed: true, retained: 'yes' } },
        },
      })
      .where(eq(agentSessions.id, sessionId));
    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [{
        eventId: randomUUID(),
        eventType: 'session.start_requested',
        payload: { requestedBy: 'integration-test' },
      }],
      coordination: {
        nextAttemptAt: backoffAt,
        reopenSession: true,
        blockedReason: null,
      },
    });
    await repository.append({
      sessionId,
      expectedSequence: 1,
      events: [{
        eventId: randomUUID(),
        eventType: 'execution.deferred',
        payload: { reason: 'turn_interrupted' },
      }],
      coordination: {
        nextAttemptAt: new Date('2026-08-28T12:00:00.000Z'),
        updateMode: 'if_missing',
      },
    });

    const [session] = await harness.db
      .select({
        completed: agentSessions.completed,
        blockedReason: agentSessions.blockedReason,
        nextAttemptAt: agentSessions.nextAttemptAt,
        metadata: agentSessions.metadata,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(session?.completed).toBe(false);
    expect(session?.blockedReason).toBeNull();
    expect(session?.nextAttemptAt?.toISOString()).toBe(backoffAt.toISOString());
    expect(session?.metadata).toMatchObject({
      flags: { session: { retained: 'yes' } },
    });
    expect(session?.metadata).not.toMatchObject({
      flags: { session: { completed: true } },
    });
    expect(session?.metadata).not.toHaveProperty('blockedMeta');
  });

  itMaybe('atomically completes closeout and rejects a stale execution claim', async () => {
    if (!harness) return;
    const repository = new SessionEventJournalRepository(harness.db as never);
    const sessionId = await insertAgentSession(harness.db);
    await harness.db
      .update(agentSessions)
      .set({
        executionClaimToken: 'claim-current',
        blockedReason: 'system_paused',
        nextAttemptAt: new Date('2026-08-29T02:00:00.000Z'),
        metadata: {
          blockedMeta: { code: 'closeout_pending' },
          flags: { session: { completed: false, retained: 'yes' } },
        },
      })
      .where(eq(agentSessions.id, sessionId));

    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [{
        eventId: randomUUID(),
        eventType: 'closeout.completed',
        payload: { reason: 'reconciled' },
      }],
      coordination: {
        nextAttemptAt: null,
        completeSession: true,
        expectedExecutionClaimToken: 'claim-current',
      },
    });

    const [completed] = await harness.db
      .select({
        completed: agentSessions.completed,
        blockedReason: agentSessions.blockedReason,
        nextAttemptAt: agentSessions.nextAttemptAt,
        metadata: agentSessions.metadata,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(completed).toMatchObject({
      completed: true,
      blockedReason: null,
      nextAttemptAt: null,
      metadata: { flags: { session: { retained: 'yes' } } },
    });

    const staleSessionId = await insertAgentSession(harness.db);
    await harness.db
      .update(agentSessions)
      .set({ executionClaimToken: 'claim-newer' })
      .where(eq(agentSessions.id, staleSessionId));
    await expect(repository.append({
      sessionId: staleSessionId,
      expectedSequence: 0,
      events: [{
        eventId: randomUUID(),
        eventType: 'closeout.completed',
        payload: { reason: 'stale worker' },
      }],
      coordination: {
        nextAttemptAt: null,
        completeSession: true,
        expectedExecutionClaimToken: 'claim-stale',
      },
    })).rejects.toThrow('execution_claim_lost');
    expect(await repository.lastSequence(staleSessionId)).toBe(0);
    const [stale] = await harness.db
      .select({ completed: agentSessions.completed })
      .from(agentSessions)
      .where(eq(agentSessions.id, staleSessionId));
    expect(stale?.completed).toBe(false);
    expect(await harness.db
      .select({ eventId: agentSessionEvents.eventId })
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, staleSessionId))).toHaveLength(0);
  });

  itMaybe('persists deterministic UUID messages while repairing a missing tool claim', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const assistantId = randomUUID();
    const modelRequestId = randomUUID();
    const toolCallId = 'provider-call-not-a-uuid';
    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [
        {
          eventId: randomUUID(),
          eventType: 'session.created',
          payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
        },
        {
          eventId: randomUUID(),
          eventType: 'turn.started',
          payload: { turnId: 'turn-1', turnNumber: 1 },
        },
        {
          eventId: randomUUID(),
          eventType: 'model.response.accepted',
          payload: {
            turnId: 'turn-1',
            modelRequestId,
            message: {
              id: assistantId,
              role: 'assistant',
              content: '',
              timestamp: 1,
              tool_calls: [{
                id: toolCallId,
                type: 'function',
                function: { name: 'shell', arguments: '{"command":"pwd"}' },
              }],
            },
          },
        },
        {
          eventId: randomUUID(),
          eventType: 'tool.requested',
          payload: {
            turnId: 'turn-1',
            modelRequestId,
            toolCallId,
            toolName: 'shell',
            arguments: '{"command":"pwd"}',
          },
        },
      ],
    });
    const recovery = new SessionJournalRecoveryService(repository, {
      findBySession: async () => [],
    } as never);

    const result = await recovery.reconcile(sessionId);

    expect(result.continuation).toEqual({ kind: 'continue_turn', turnId: 'turn-1' });
    const messages = await harness.db
      .select({ id: agentMessages.id, role: agentMessages.role, toolCallId: agentMessages.toolCallId })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId));
    expect(messages).toEqual(expect.arrayContaining([
      { id: assistantId, role: 'assistant', toolCallId: null },
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        role: 'tool',
        toolCallId,
      },
    ]));
  });

  itMaybe('owns the transcript projection transactionally and rebuilds it on compaction', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const userMessage = {
      id: randomUUID(),
      role: 'user' as const,
      content: 'Inspect the target.',
      timestamp: 1_000,
    };
    const assistantMessage = {
      id: randomUUID(),
      role: 'assistant' as const,
      content: 'Inspection complete.',
      timestamp: 2_000,
    };
    const summaryMessage = {
      id: randomUUID(),
      role: 'assistant' as const,
      content: 'Compacted inspection history.',
      timestamp: 3_000,
      metadata: { compaction: true },
    };

    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [
        {
          eventId: randomUUID(),
          eventType: 'session.created',
          payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
        },
        {
          eventId: randomUUID(),
          eventType: 'input.accepted',
          payload: { message: userMessage },
        },
        {
          eventId: randomUUID(),
          eventType: 'turn.started',
          payload: { turnId: 'turn-1', turnNumber: 1, inputMessageIds: [userMessage.id] },
        },
        {
          eventId: randomUUID(),
          eventType: 'model.response.accepted',
          payload: {
            turnId: 'turn-1',
            modelRequestId: randomUUID(),
            message: assistantMessage,
          },
        },
        {
          eventId: randomUUID(),
          eventType: 'turn.completed',
          payload: { turnId: 'turn-1', reason: 'done' },
        },
        {
          eventId: randomUUID(),
          eventType: 'compaction.applied',
          payload: {
            transactionId: 'compact-1',
            throughMessageId: assistantMessage.id,
            summaryMessage,
          },
        },
      ],
    });

    const rows = await harness.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: summaryMessage.id,
      role: 'assistant',
      content: summaryMessage.content,
      metadata: summaryMessage.metadata,
    });
  });

  itMaybe('rebuilds the transcript projection after abandoning a corrupt tail', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const safeMessage = {
      id: randomUUID(),
      role: 'user' as const,
      content: 'keep this prefix',
      timestamp: 1_000,
    };
    const abandonedMessage = {
      id: randomUUID(),
      role: 'tool' as const,
      content: 'this outcome has no request',
      timestamp: 2_000,
      toolCallId: 'missing-call',
    };

    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [
        {
          eventId: randomUUID(),
          eventType: 'session.created',
          payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
        },
        {
          eventId: randomUUID(),
          eventType: 'message.accepted',
          payload: { message: safeMessage },
        },
        {
          eventId: randomUUID(),
          eventType: 'tool.outcome_attached',
          payload: {
            turnId: 'turn-missing',
            toolCallId: 'missing-call',
            outcome: 'succeeded',
            message: abandonedMessage,
          },
        },
      ],
    });

    expect((await harness.db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId)))
      .map((row) => row.id)).toEqual(expect.arrayContaining([safeMessage.id, abandonedMessage.id]));

    await repository.append({
      sessionId,
      expectedSequence: 3,
      events: [
        {
          eventId: randomUUID(),
          eventType: 'session.recovery_rebased',
          payload: {
            recoverableThroughSequence: 2,
            abandonedThroughSequence: 3,
            reason: 'tool outcome had no matching request',
            desiredExecution: 'running',
          },
        },
        {
          eventId: randomUUID(),
          eventType: 'session.data_loss_detected',
          payload: {
            kind: 'invalid_event',
            detail: 'tool outcome had no matching request',
            recoverableThroughSequence: 2,
          },
        },
      ],
    });

    const rebuilt = await harness.db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId));
    expect(rebuilt.map((row) => row.id)).toEqual([safeMessage.id]);
  });

  itMaybe('rejects reuse of an event ID with different semantic content', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const eventId = randomUUID();
    await repository.append({
      sessionId,
      expectedSequence: 0,
      events: [{
        eventId,
        eventType: 'session.created',
        payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
      }],
    });

    await expect(repository.append({
      sessionId,
      expectedSequence: 0,
      events: [{
        eventId,
        eventType: 'session.created',
        payload: { modelName: 'different-model', mode: 'automated' },
      }],
    })).rejects.toBeInstanceOf(SessionJournalIdempotencyError);
  });

  itMaybe('serializes competing writers so only one expected sequence wins', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repository = new SessionEventJournalRepository(harness.db as never);
    const append = (eventId: string) => repository.append({
      sessionId,
      expectedSequence: 0,
      events: [{
        eventId,
        eventType: 'session.created',
        payload: { modelName: 'gpt-5.6-sol', mode: 'automated' },
      }],
    });

    const results = await Promise.allSettled([append(randomUUID()), append(randomUUID())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(SessionJournalConflictError) });
    expect(await repository.lastSequence(sessionId)).toBe(1);
  });
});
