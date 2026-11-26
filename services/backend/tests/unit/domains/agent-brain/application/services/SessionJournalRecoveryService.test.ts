import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { SessionJournalRecoveryService } from '@/domains/agent-brain/application/services/SessionJournalRecoveryService';
import {
  SessionJournalConflictError,
  type AppendSessionEventsInput,
  type SessionEventJournalPort,
  type ToolExecutionPort,
  type ToolExecutionRecord,
} from '@/domains/agent-brain/ports';
import type { SessionEventRecord } from '@/domains/agent-brain/domain/session-journal';

const sessionId = '11111111-1111-4111-8111-111111111111';

class MemoryJournal implements SessionEventJournalPort {
  readonly events: SessionEventRecord[] = [];

  async append(input: AppendSessionEventsInput): Promise<SessionEventRecord[]> {
    if (input.expectedSequence !== this.events.length) {
      throw new SessionJournalConflictError(input.sessionId, input.expectedSequence, this.events.length);
    }
    const appended = input.events.map((draft, index): SessionEventRecord => ({
      ...draft,
      sessionId: input.sessionId,
      sequence: this.events.length + index + 1,
      schemaVersion: draft.schemaVersion ?? 1,
      createdAt: draft.createdAt ?? new Date(0),
    }));
    this.events.push(...appended);
    return appended;
  }

  async load(): Promise<SessionEventRecord[]> {
    return [...this.events];
  }

  async loadAfter(_sessionId: string, sequence: number): Promise<SessionEventRecord[]> {
    return this.events.filter((event) => event.sequence > sequence);
  }

  async lastSequence(): Promise<number> {
    return this.events.length;
  }
}

const draft = (
  eventType: SessionEventRecord['eventType'],
  payload: Record<string, unknown>,
): AppendSessionEventsInput['events'][number] => ({
  eventId: randomUUID(),
  eventType,
  payload: payload as SessionEventRecord['payload'],
});

const seedToolTail = async (journal: MemoryJournal): Promise<void> => {
  await journal.append({
    sessionId,
    expectedSequence: 0,
    events: [
      draft('session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      draft('turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      draft('model.response.accepted', {
        turnId: 'turn-1',
        modelRequestId: '22222222-2222-4222-8222-222222222222',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"pwd"}' },
          }],
        },
      }),
      draft('tool.requested', {
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'shell',
        modelRequestId: '22222222-2222-4222-8222-222222222222',
        arguments: '{"command":"pwd"}',
      }),
    ],
  });
};

const toolPort = (records: ToolExecutionRecord[]): ToolExecutionPort => ({
  findBySession: vi.fn(async () => [...records]),
  findByTurn: vi.fn(async () => [...records]),
  findByToolCallId: vi.fn(async (_sessionId, toolCallId) => records.find((row) => row.toolCallId === toolCallId)),
  create: vi.fn(async () => { throw new Error('not used'); }),
  complete: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  block: vi.fn(async ({ toolCallId, reason }) => {
    const row = records.find((record) => record.toolCallId === toolCallId);
    if (!row) throw new Error('missing tool execution');
    row.status = 'blocked';
    row.error = reason;
    row.completedAt = new Date(2);
  }),
  markOutcomeUnknown: vi.fn(async ({ toolCallId, reason }) => {
    const row = records.find((record) => record.toolCallId === toolCallId);
    if (!row) throw new Error('missing tool execution');
    row.status = 'outcome_unknown';
    row.error = reason;
    row.completedAt = new Date(2);
  }),
});

describe('SessionJournalRecoveryService', () => {
  it('freezes a possibly dispatched tool, attaches the unknown outcome, and continues the same turn', async () => {
    const journal = new MemoryJournal();
    await seedToolTail(journal);
    const records: ToolExecutionRecord[] = [{
      id: '33333333-3333-4333-8333-333333333333',
      sessionId,
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'shell',
      status: 'started',
    }];
    const service = new SessionJournalRecoveryService(journal, toolPort(records));

    const result = await service.reconcile(sessionId);

    expect(result.continuation).toEqual({ kind: 'continue_turn', turnId: 'turn-1' });
    expect(result.repairedToolExecutionCount).toBe(1);
    expect(result.repairedEventCount).toBe(1);
    expect(records[0]?.status).toBe('outcome_unknown');
    expect(journal.events.at(-1)?.eventType).toBe('tool.outcome_attached');
  });

  it('records a safe blocked result when the durable ledger proves dispatch never began', async () => {
    const journal = new MemoryJournal();
    await seedToolTail(journal);
    const service = new SessionJournalRecoveryService(journal, toolPort([]));

    const result = await service.reconcile(sessionId);

    expect(result.continuation).toEqual({ kind: 'continue_turn', turnId: 'turn-1' });
    expect(result.repairedToolExecutionCount).toBe(0);
    expect(result.fold.pendingToolRequests).toEqual([]);
    expect(JSON.stringify(journal.events.at(-1)?.payload)).toContain('never claimed');
  });

  it('durably interrupts a pre-response turn and returns one restart decision', async () => {
    const journal = new MemoryJournal();
    await journal.append({
      sessionId,
      expectedSequence: 0,
      events: [
        draft('session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
        draft('turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      ],
    });
    const service = new SessionJournalRecoveryService(journal, toolPort([]));

    const result = await service.reconcile(sessionId);

    expect(result.continuation).toEqual({ kind: 'restart_turn', turnId: 'turn-1' });
    expect(result.fold.openTurnId).toBeUndefined();
    expect(journal.events.at(-1)?.eventType).toBe('turn.interrupted');
  });

  it('freezes provider attempts left in flight by an expired execution lease', async () => {
    const journal = new MemoryJournal();
    await journal.append({
      sessionId,
      expectedSequence: 0,
      events: [
        draft('session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
        draft('turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      ],
    });
    const interruptedAt = new Date('2026-08-29T10:52:56.000Z');
    const failAttempt = vi.fn(async () => undefined);
    const providerAttempts = {
      listAttemptsBySession: vi.fn(async () => [{
        schemaVersion: 2,
        requestId: 'request-1',
        attemptId: 'attempt-1',
        attemptOrdinal: 1,
        sessionId,
        provider: 'OPENAI',
        model: 'gpt-5.6-sol',
        state: 'started' as const,
        usage: {
          uncachedInput: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          reasoningSource: 'unavailable' as const,
        },
        startedAt: new Date('2026-08-29T10:51:17.816Z'),
        provenance: 'recorded' as const,
      }]),
      failAttempt,
    };
    const service = new SessionJournalRecoveryService(
      journal,
      toolPort([]),
      providerAttempts as never,
    );

    const result = await service.reconcile(sessionId, {
      executionInterrupted: true,
      interruptedAt,
    });

    expect(result.repairedProviderAttemptCount).toBe(1);
    expect(failAttempt).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      status: 'uncertain',
      requestCompletedAt: interruptedAt,
      errorClass: 'process_interrupted_before_settlement',
      retryDecision: 'retry',
    });
  });

  it('rebases a malformed tail, records data loss, and continues from the valid prefix', async () => {
    const journal = new MemoryJournal();
    await journal.append({
      sessionId,
      expectedSequence: 0,
      events: [
        draft('session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
        draft('input.accepted', {
          message: { id: 'user-1', role: 'user', content: 'preserve this', timestamp: 1 },
        }),
      ],
    });
    journal.events.push({
      ...draft('plan.changed', { plan: 'not-an-array' }),
      sessionId,
      sequence: 3,
      schemaVersion: 1,
      createdAt: new Date(3),
    });
    const service = new SessionJournalRecoveryService(journal, toolPort([]));

    const result = await service.reconcile(sessionId);

    expect(result.fold.issues).toEqual([]);
    expect(result.fold.messages.map((item) => item.id)).toEqual(['user-1']);
    expect(result.continuation).toEqual({ kind: 'start_pending_input', messageIds: ['user-1'] });
    expect(result.repairedEventCount).toBe(2);
    expect(journal.events.slice(-2).map((item) => item.eventType)).toEqual([
      'session.recovery_rebased',
      'session.data_loss_detected',
    ]);
  });

  it('preserves an explicit Stop found after an unrelated corrupt event', async () => {
    const journal = new MemoryJournal();
    await journal.append({
      sessionId,
      expectedSequence: 0,
      events: [
        draft('session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
        draft('input.accepted', {
          message: { id: 'user-1', role: 'user', content: 'preserve this', timestamp: 1 },
        }),
      ],
    });
    journal.events.push({
      ...draft('plan.changed', { plan: 'not-an-array' }),
      sessionId,
      sequence: 3,
      schemaVersion: 1,
      createdAt: new Date(3),
    });
    journal.events.push({
      ...draft('session.stop_requested', { requestedBy: 'operator-1' }),
      sessionId,
      sequence: 4,
      schemaVersion: 1,
      createdAt: new Date(4),
    });
    const service = new SessionJournalRecoveryService(journal, toolPort([]));

    const result = await service.reconcile(sessionId);

    expect(result.fold.issues).toEqual([]);
    expect(result.fold.desiredExecution).toBe('stopped');
    expect(result.fold.pendingInputMessageIds).toEqual(['user-1']);
    expect(result.continuation).toEqual({ kind: 'none' });
    expect(journal.events.at(-2)?.payload).toMatchObject({ desiredExecution: 'stopped' });
  });
});
