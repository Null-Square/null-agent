import { describe, expect, it } from 'vitest';

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import {
  SessionJournalConflictError,
  type AppendSessionEventsInput,
  type SessionEventJournalPort,
} from '@/domains/agent-brain/ports';
import type { SessionEventRecord } from '@/domains/agent-brain/domain/session-journal';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

class MemoryJournal implements SessionEventJournalPort {
  readonly events = new Map<string, SessionEventRecord[]>();
  readonly coordinations: AppendSessionEventsInput['coordination'][] = [];

  async append(input: AppendSessionEventsInput): Promise<SessionEventRecord[]> {
    this.coordinations.push(input.coordination);
    const current = this.events.get(input.sessionId) ?? [];
    if (current.length !== input.expectedSequence) {
      throw new SessionJournalConflictError(input.sessionId, input.expectedSequence, current.length);
    }
    const appended = input.events.map((draft, index): SessionEventRecord => ({
      ...draft,
      sessionId: input.sessionId,
      sequence: current.length + index + 1,
      schemaVersion: draft.schemaVersion ?? 1,
      createdAt: draft.createdAt ?? new Date(),
    }));
    this.events.set(input.sessionId, [...current, ...appended]);
    return appended;
  }

  async load(sessionId: string): Promise<SessionEventRecord[]> {
    return [...(this.events.get(sessionId) ?? [])];
  }

  async loadAfter(sessionId: string, sequence: number): Promise<SessionEventRecord[]> {
    return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > sequence);
  }

  async lastSequence(sessionId: string): Promise<number> {
    return this.events.get(sessionId)?.length ?? 0;
  }
}

describe('SessionStore journal boundaries', () => {
  it('uses only durable Stop and Start facts to change desired execution', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'claude-opus-4-8' });

    await store.recordStopRequestedAsync(session.id, 'operator stop', 'user-1');
    expect((await store.getJournalProjection(session.id))?.desiredExecution).toBe('stopped');
    expect(journal.coordinations.at(-1)).toMatchObject({
      nextAttemptAt: null,
      revokeExecutionClaim: true,
      blockedReason: 'user_paused',
      blockedMeta: {
        stoppedAt: expect.any(String),
        stoppedBy: 'user-1',
        reason: 'operator stop',
      },
    });

    await store.recordStartRequestedAsync(session.id, 'operator start', 'user-1');
    expect((await store.getJournalProjection(session.id))?.desiredExecution).toBe('running');
    expect(journal.events.get(session.id)?.map((event) => event.eventType)).toEqual([
      'session.created',
      'session.stop_requested',
      'session.start_requested',
    ]);
    expect(journal.coordinations.at(-1)).toMatchObject({
      reopenSession: true,
      blockedReason: null,
      nextAttemptAt: expect.any(Date),
    });
    store.shutdown();
  });

  it('reopens the process-local completion projection after durable Start', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol' });
    session.completed = true;
    session.flags = {
      ...session.flags,
      session: { completed: true, retained: 'yes' } as typeof session.flags.session,
    };
    await store.setAsync(session.id, session, 'test.completed');

    await store.recordStartRequestedAsync(session.id, 'operator start', 'user-1');

    expect(store.get(session.id)?.completed).toBe(false);
    expect(store.get(session.id)?.blockedReason).toBeUndefined();
    expect(store.get(session.id)?.blockedMeta).toBeUndefined();
    expect(store.get(session.id)?.flags.session).toEqual({ retained: 'yes' });
    expect(journal.coordinations.at(-1)?.reopenSession).toBe(true);
    store.shutdown();
  });

  it('accepts stopped-session input and schedules Start in one durable boundary', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol', mode: 'automated' });
    await store.recordStopRequestedAsync(session.id, 'operator stop', 'user-1');
    session.completed = true;
    session.flags = {
      ...session.flags,
      session: { completed: true, retained: 'yes' } as typeof session.flags.session,
    };
    session.blockedReason = 'user_paused';
    session.blockedMeta = { reason: 'operator stop' };
    await store.setAsync(session.id, session, 'test.completed-while-stopped');
    const message = {
      id: 'workbench-input-1',
      role: 'user' as const,
      content: 'Continue, but verify the target first.',
      timestamp: 10,
    };

    await store.recordInputAndStartRequestedAsync(
      session.id,
      message,
      'workbench message accepted',
      'user-1',
    );

    expect(journal.events.get(session.id)?.map((event) => event.eventType)).toEqual([
      'session.created',
      'session.stop_requested',
      'session.start_requested',
      'input.accepted',
    ]);
    expect(journal.coordinations.at(-1)).toMatchObject({
      reopenSession: true,
      blockedReason: null,
      nextAttemptAt: expect.any(Date),
    });
    expect(await store.getJournalProjection(session.id)).toMatchObject({
      desiredExecution: 'running',
      pendingInputMessageIds: ['workbench-input-1'],
      hasUnfinishedWork: true,
    });
    expect(store.get(session.id)?.messages.map((item) => item.id)).toContain('workbench-input-1');

    // The claimed continuation supplies no duplicate HTTP input. Starting the
    // turn consumes the already durable pending input from the journal.
    await store.beginJournalTurnAsync(session.id, 1);
    expect(await store.getJournalProjection(session.id)).toMatchObject({
      openTurnId: 'turn-1',
      pendingInputMessageIds: [],
    });
    store.shutdown();
  });

  it('preserves an explicit legacy Stop when recovery creates the first journal event', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol', mode: 'automated' });

    // Simulate a session persisted before the journal cutover. Its old durable
    // projection says the user stopped it, while no semantic journal exists.
    journal.events.delete(session.id);
    session.blockedReason = 'user_paused';
    await store.setAsync(session.id, session, 'test.legacy-stop');

    const projection = await store.ensureJournalForRecoveryAsync(session.id);

    expect(journal.events.get(session.id)?.map((event) => event.eventType)).toEqual([
      'legacy.session_imported',
    ]);
    expect(projection?.desiredExecution).toBe('stopped');
    expect(projection?.hasUnfinishedWork).toBe(false);
    store.shutdown();
  });

  it('accepts internal continuation work without overriding Stop intent', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol', mode: 'automated' });
    await store.recordStopRequestedAsync(session.id, 'operator stop', 'user-1');
    session.completed = true;
    session.flags = {
      ...session.flags,
      session: { completed: true, retained: 'yes' } as typeof session.flags.session,
    };
    session.blockedReason = 'user_paused';
    session.blockedMeta = { reason: 'operator stop' };
    await store.setAsync(session.id, session, 'test.internal-continuation-stopped');

    await store.recordInternalContinuationInputAsync(session.id, {
      id: 'worker-continuation:task-1:result-1',
      role: 'user',
      content: 'A background worker task changed state.',
      timestamp: 0,
      metadata: {
        visibility: 'internal',
        source: 'worker_state_continuation',
      },
    });

    expect(journal.events.get(session.id)?.map((event) => event.eventType)).toEqual([
      'session.created',
      'session.stop_requested',
      'input.accepted',
    ]);
    expect(await store.getJournalProjection(session.id)).toMatchObject({
      desiredExecution: 'stopped',
      pendingInputMessageIds: ['worker-continuation:task-1:result-1'],
      hasUnfinishedWork: true,
    });
    expect(journal.coordinations.at(-1)).toMatchObject({
      updateMode: 'if_missing',
      nextAttemptAt: expect.any(Date),
      reopenSession: true,
    });
    expect(store.get(session.id)?.completed).toBe(false);
    expect(store.get(session.id)?.blockedReason).toBe('user_paused');
    expect(store.get(session.id)?.flags.session).toEqual({ retained: 'yes' });
    store.shutdown();
  });

  it('reconstructs a completed tool turn from canonical boundary writes', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol' });
    const userMessage = {
      id: 'user-1',
      role: 'user' as const,
      content: 'inspect the workspace',
      timestamp: 1,
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: '',
      timestamp: 2,
      tool_calls: [{
        id: 'call-1',
        type: 'function' as const,
        function: { name: 'shell', arguments: '{"command":"pwd"}' },
      }],
    };
    const toolMessage = {
      id: 'tool-1',
      role: 'tool' as const,
      content: 'C:/workspace',
      timestamp: 3,
      toolCallId: 'call-1',
      metadata: {
        toolExecution: {
          schema: 'tool-execution-receipt/v1' as const,
          toolName: 'shell',
          toolCallId: 'call-1',
          outcome: 'succeeded' as const,
        },
      },
    };

    await store.beginJournalTurnAsync(session.id, 1, userMessage);
    await store.recordModelResponseAcceptedAsync(session.id, 1, 'request-1', assistantMessage);
    await store.recordToolOutcomesAcceptedAsync(session.id, 1, [toolMessage]);
    await store.finishJournalTurnAsync(session.id, 1, 'completed', 'ok');

    const projection = await store.getJournalProjection(session.id);
    expect(journal.events.get(session.id)?.map((event) => event.eventType)).toEqual([
      'session.created',
      'input.accepted',
      'turn.started',
      'model.response.accepted',
      'tool.requested',
      'tool.outcome_attached',
      'turn.completed',
    ]);
    expect(projection?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'tool-1',
    ]);
    expect(projection?.hasUnfinishedWork).toBe(false);
    expect(projection?.issues).toEqual([]);
    store.shutdown();
  });

  it('schedules an interrupted turn in the same durable append', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'gpt-5.6-sol' });

    await store.finishJournalTurnAsync(session.id, 1, 'interrupted', 'backend_restart');

    const coordination = journal.coordinations.at(-1);
    expect(coordination?.nextAttemptAt).toBeInstanceOf(Date);
    expect(coordination?.updateMode).toBe('if_missing');
    expect(journal.events.get(session.id)?.at(-1)?.eventType).toBe('turn.interrupted');
    store.shutdown();
  });

  it('coordinates closeout retry and completion from journal facts', async () => {
    const journal = new MemoryJournal();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      sessionEventJournal: journal,
    });
    const session = await store.create({ modelName: 'claude-opus-4-8', mode: 'automated' });
    const retryAt = new Date('2026-08-29T01:00:00.000Z');

    await store.recordCloseoutRequestedAsync(
      session.id,
      'report artifacts are still settling',
      retryAt,
      'turn-1',
    );

    expect(journal.coordinations.at(-1)?.nextAttemptAt).toEqual(retryAt);
    expect((await store.getJournalProjection(session.id))?.pendingCloseout?.reason)
      .toBe('report artifacts are still settling');

    await expect(store.recordCloseoutCompletedAsync(session.id, 'reconciled', 'claim-1')).resolves.toBe(true);

    expect(journal.coordinations.at(-1)?.nextAttemptAt).toBeNull();
    expect(journal.coordinations.at(-1)?.completeSession).toBe(true);
    expect(journal.coordinations.at(-1)?.expectedExecutionClaimToken).toBe('claim-1');
    expect((await store.getJournalProjection(session.id))?.pendingCloseout).toBeUndefined();
    store.shutdown();
  });
});
