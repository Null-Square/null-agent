import { describe, expect, it } from 'vitest';

import {
  foldSessionJournal,
  type SessionEventRecord,
} from '@/domains/agent-brain/domain/session-journal';

const sessionId = '11111111-1111-4111-8111-111111111111';

const event = (
  sequence: number,
  eventType: SessionEventRecord['eventType'],
  payload: Record<string, unknown>,
  overrides: Partial<SessionEventRecord> = {},
): SessionEventRecord => ({
  eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sessionId,
  sequence,
  eventType,
  schemaVersion: 1,
  payload: payload as SessionEventRecord['payload'],
  createdAt: new Date(sequence * 1000),
  ...overrides,
});

const message = (
  id: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  extra: Record<string, unknown> = {},
) => ({ id, role, content, timestamp: 1, ...extra });

describe('foldSessionJournal', () => {
  it('separates durable desired execution from interrupted turn outcomes', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'input.accepted', { message: message('user-1', 'user', 'audit this') }),
      event(3, 'turn.started', { turnId: 'turn-1', turnNumber: 1, inputMessageIds: ['user-1'] }),
      event(4, 'turn.interrupted', { turnId: 'turn-1', reason: 'backend restart', source: 'recovery' }),
    ]);

    expect(fold.desiredExecution).toBe('running');
    expect(fold.openTurnId).toBeUndefined();
    expect(fold.messages.map((item) => item.id)).toEqual(['user-1']);
    expect(fold.interruptedTurn).toMatchObject({ turnId: 'turn-1', turnNumber: 1 });
    expect(fold.hasUnfinishedWork).toBe(true);
  });

  it('uses Stop and Start as durable intent without deleting history', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'claude-opus-4-8', mode: 'automated' }),
      event(2, 'input.accepted', { message: message('user-1', 'user', 'continue the run') }),
      event(3, 'session.stop_requested', { reason: 'user pressed stop' }),
      event(4, 'session.start_requested', { reason: 'user pressed start' }),
    ]);

    expect(fold.desiredExecution).toBe('running');
    expect(fold.pendingInputMessageIds).toEqual(['user-1']);
    expect(fold.pendingStartSequence).toBe(4);
    expect(fold.messages).toHaveLength(1);
    expect(fold.hasUnfinishedWork).toBe(true);
  });

  it('consumes pending Start only when a replacement turn durably opens', () => {
    const pending = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'session.start_requested', { reason: 'continue completed history' }),
    ]);
    expect(pending.pendingStartSequence).toBe(2);
    expect(pending.hasUnfinishedWork).toBe(true);

    const started = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'session.start_requested', { reason: 'continue completed history' }),
      event(3, 'turn.started', { turnId: 'turn-2', turnNumber: 2 }),
    ]);
    expect(started.pendingStartSequence).toBeUndefined();
    expect(started.openTurnId).toBe('turn-2');
  });

  it('keeps a deferred continuation pending across turn completion until the next turn opens', () => {
    const deferred = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.4', mode: 'automated' }),
      event(2, 'turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      event(3, 'execution.deferred', {
        reason: 'pending_steps:1',
        retryAt: '2026-08-30T12:00:30.000Z',
      }),
      event(4, 'turn.completed', { turnId: 'turn-1', reason: 'model_completed' }),
    ]);

    expect(deferred.openTurnId).toBeUndefined();
    expect(deferred.pendingDeferred).toEqual({
      reason: 'pending_steps:1',
      retryAt: '2026-08-30T12:00:30.000Z',
      requestedSequence: 3,
    });
    expect(deferred.hasUnfinishedWork).toBe(true);

    const resumed = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.4', mode: 'automated' }),
      event(2, 'execution.deferred', { reason: 'pending_steps:1' }),
      event(3, 'turn.started', { turnId: 'turn-2', turnNumber: 2 }),
    ]);
    expect(resumed.pendingDeferred).toBeUndefined();
    expect(resumed.openTurnId).toBe('turn-2');
  });

  it('derives pending closeout from journal facts without a recovery action column', () => {
    const pending = foldSessionJournal([
      event(1, 'session.created', { modelName: 'claude-opus-4-8', mode: 'automated' }),
      event(2, 'closeout.requested', { reason: 'report artifacts are still settling' }),
    ]);

    expect(pending.pendingCloseout).toEqual({
      reason: 'report artifacts are still settling',
      requestedSequence: 2,
    });
    expect(pending.hasUnfinishedWork).toBe(true);

    const completed = foldSessionJournal([
      event(1, 'session.created', { modelName: 'claude-opus-4-8', mode: 'automated' }),
      event(2, 'closeout.requested', { reason: 'report artifacts are still settling' }),
      event(3, 'closeout.completed', { reason: 'reconciled' }),
    ]);
    expect(completed.pendingCloseout).toBeUndefined();
    expect(completed.hasUnfinishedWork).toBe(false);
  });

  it('recovers the longest valid prefix when the durable tail has a sequence gap', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'input.accepted', { message: message('user-1', 'user', 'preserve me') }),
      event(4, 'message.accepted', { message: message('assistant-lost', 'assistant', 'not safe') }),
    ]);

    expect(fold.recoverableThroughSequence).toBe(2);
    expect(fold.messages.map((item) => item.id)).toEqual(['user-1']);
    expect(fold.issues).toEqual([
      expect.objectContaining({ code: 'sequence_gap', sequence: 4 }),
    ]);
  });

  it('continues after an explicit rebase while retaining the valid prefix', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'message.accepted', { message: message('safe-user', 'user', 'preserve me') }),
      event(3, 'plan.changed', { plan: 'corrupt' }),
      event(4, 'session.recovery_rebased', {
        recoverableThroughSequence: 2,
        abandonedThroughSequence: 3,
        reason: 'plan payload was corrupt',
        desiredExecution: 'running',
      }),
      event(5, 'session.data_loss_detected', {
        kind: 'invalid_event',
        detail: 'plan payload was corrupt',
        recoverableThroughSequence: 2,
      }),
      event(6, 'message.accepted', { message: message('new-user', 'user', 'continue safely') }),
    ]);

    expect(fold.issues).toEqual([]);
    expect(fold.messages.map((item) => item.id)).toEqual(['safe-user', 'new-user']);
    expect(fold.lastSequence).toBe(6);
    expect(fold.desiredExecution).toBe('running');
  });

  it('keeps the session startable even when the original creation row is lost', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 42, mode: null }),
      event(2, 'session.recovery_rebased', {
        recoverableThroughSequence: 0,
        abandonedThroughSequence: 1,
        reason: 'creation payload was unreadable',
        desiredExecution: 'running',
      }),
      event(3, 'session.data_loss_detected', {
        kind: 'invalid_event',
        detail: 'creation payload was unreadable',
        recoverableThroughSequence: 0,
      }),
      event(4, 'session.start_requested', { reason: 'operator recovery' }),
    ]);

    expect(fold.issues).toEqual([]);
    expect(fold.created).toBe(true);
    expect(fold.desiredExecution).toBe('running');
    expect(fold.lastSequence).toBe(4);
  });

  it('stops at an impossible lifecycle transition instead of overwriting the open turn', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      event(3, 'turn.started', { turnId: 'turn-2', turnNumber: 2 }),
    ]);

    expect(fold.recoverableThroughSequence).toBe(2);
    expect(fold.openTurnId).toBe('turn-1');
    expect(fold.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_transition',
      sequence: 3,
    }));
  });

  it('derives missing tool-request boundaries from the accepted model response', () => {
    const assistant = message('assistant-1', 'assistant', '', {
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'shell', arguments: '{"command":"pwd"}' },
      }],
    });
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      event(3, 'model.response.accepted', {
        turnId: 'turn-1',
        modelRequestId: '22222222-2222-4222-8222-222222222222',
        message: assistant,
      }),
    ]);

    expect(fold.openTurnHasModelResponse).toBe(true);
    expect(fold.unregisteredToolCalls).toEqual([{
      turnId: 'turn-1',
      modelRequestId: '22222222-2222-4222-8222-222222222222',
      toolCallId: 'call-1',
      toolName: 'shell',
      arguments: '{"command":"pwd"}',
      acceptedSequence: 3,
    }]);
  });

  it('replaces only the compacted prefix and preserves the canonical tail', () => {
    const summary = message('summary-1', 'assistant', 'Earlier durable context');
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'message.accepted', { message: message('old-user', 'user', 'old input') }),
      event(3, 'message.accepted', { message: message('old-assistant', 'assistant', 'old output') }),
      event(4, 'message.accepted', { message: message('tail-user', 'user', 'preserve this tail') }),
      event(5, 'compaction.applied', {
        transactionId: 'history:compaction-1',
        throughMessageId: 'old-assistant',
        summaryMessage: summary,
      }),
    ]);

    expect(fold.messages).toEqual([
      summary,
      expect.objectContaining({ id: 'tail-user' }),
    ]);
    expect(fold.compactionVersion).toBe(1);
    expect(fold.compactionTransactionId).toBe('history:compaction-1');
    expect(fold.issues).toEqual([]);
  });
});
