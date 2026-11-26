import { describe, expect, it } from 'vitest';

import {
  foldSessionJournal,
  repairSessionTail,
  type SessionEventRecord,
} from '@/domains/agent-brain/domain/session-journal';

const sessionId = '11111111-1111-4111-8111-111111111111';

const event = (
  sequence: number,
  eventType: SessionEventRecord['eventType'],
  payload: Record<string, unknown>,
): SessionEventRecord => ({
  eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sessionId,
  sequence,
  eventType,
  schemaVersion: 1,
  payload: payload as SessionEventRecord['payload'],
  createdAt: new Date(sequence * 1000),
});

const base = () => [
  event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
  event(2, 'turn.started', { turnId: 'turn-1', turnNumber: 1 }),
];

const toolTailEvents = () => [
  ...base(),
  event(3, 'model.response.accepted', {
    turnId: 'turn-1',
    modelRequestId: '22222222-2222-4222-8222-222222222222',
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 3,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'shell', arguments: '{"command":"pwd"}' },
      }],
    },
  }),
  event(4, 'tool.requested', {
    turnId: 'turn-1',
    modelRequestId: '22222222-2222-4222-8222-222222222222',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: '{"command":"pwd"}',
  }),
];

const toolTail = () => foldSessionJournal(toolTailEvents());

describe('repairSessionTail', () => {
  it('never repairs or automatically continues a user-stopped session', () => {
    const fold = foldSessionJournal([
      ...base(),
      event(3, 'session.stop_requested', { reason: 'user pressed stop' }),
    ]);

    expect(repairSessionTail(fold)).toEqual({
      events: [],
      toolLedgerRepairs: [],
      continuation: { kind: 'none' },
    });
  });

  it('turns an explicit Start into work even when the prior tail was complete', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.6-sol', mode: 'automated' }),
      event(2, 'session.start_requested', { reason: 'continue preserved history' }),
    ]);

    expect(repairSessionTail(fold)).toEqual({
      events: [],
      toolLedgerRepairs: [],
      continuation: { kind: 'restart_turn', turnId: 'start-2' },
    });
  });

  it('restarts a deferred automated turn after its prior turn completed cleanly', () => {
    const fold = foldSessionJournal([
      event(1, 'session.created', { modelName: 'gpt-5.4', mode: 'automated' }),
      event(2, 'turn.started', { turnId: 'turn-1', turnNumber: 1 }),
      event(3, 'execution.deferred', {
        reason: 'pending_steps:1',
        retryAt: '2026-08-30T12:00:30.000Z',
      }),
      event(4, 'turn.completed', { turnId: 'turn-1', reason: 'model_completed' }),
    ]);

    expect(repairSessionTail(fold)).toEqual({
      events: [],
      toolLedgerRepairs: [],
      continuation: { kind: 'restart_turn', turnId: 'deferred-3' },
    });
  });

  it('reconstructs a missing tool.requested fact before any dispatch', () => {
    const assistant = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 3,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'shell', arguments: '{"command":"pwd"}' },
      }],
    };
    const fold = foldSessionJournal([
      ...base(),
      event(3, 'model.response.accepted', {
        turnId: 'turn-1',
        modelRequestId: '22222222-2222-4222-8222-222222222222',
        message: assistant,
      }),
    ]);

    expect(repairSessionTail(fold)).toMatchObject({
      continuation: { kind: 'repair_then_reconcile' },
      events: [{
        eventType: 'tool.requested',
        payload: { toolCallId: 'call-1', toolName: 'shell' },
      }],
    });
  });

  it('proves pre-dispatch interruption without re-executing or inventing an effect', () => {
    expect(repairSessionTail(toolTail())).toMatchObject({
      continuation: { kind: 'repair_then_reconcile' },
      events: [{
        eventType: 'tool.outcome_attached',
        payload: {
          toolCallId: 'call-1',
          outcome: 'blocked',
          repair: true,
          message: { timestamp: 4 },
        },
      }],
    });
    expect(repairSessionTail(toolTail(), [{
      toolCallId: 'call-1',
      status: 'claimed',
    }])).toMatchObject({
      continuation: { kind: 'repair_then_reconcile' },
      toolLedgerRepairs: [{
        target: 'blocked',
        toolCallId: 'call-1',
      }],
    });
  });

  it('routes a durably granted approval to the lease owner instead of generic tail repair', () => {
    const fold = foldSessionJournal([
      ...toolTailEvents(),
      event(5, 'approval.requested', {
        turnId: 'turn-1',
        toolCallId: 'call-1',
        actionId: 'approval-1',
      }),
      event(6, 'approval.decided', {
        actionId: 'approval-1',
        decision: 'granted',
      }),
    ]);

    expect(fold.approvedTool).toEqual({ actionId: 'approval-1', toolCallId: 'call-1' });
    expect(repairSessionTail(fold)).toEqual({
      events: [],
      toolLedgerRepairs: [],
      continuation: {
        kind: 'execute_approved_tool',
        actionId: 'approval-1',
        toolCallId: 'call-1',
      },
    });
  });

  it('freezes a started execution without a terminal result as outcome_unknown', () => {
    const plan = repairSessionTail(toolTail(), [{
      id: '33333333-3333-4333-8333-333333333333',
      toolCallId: 'call-1',
      status: 'started',
      startedAt: new Date(4000),
    }]);

    expect(plan.continuation).toEqual({ kind: 'repair_then_reconcile' });
    expect(plan.events).toEqual([]);
    expect(plan.toolLedgerRepairs).toEqual([{
      toolCallId: 'call-1',
      target: 'outcome_unknown',
      reason: 'Recovery found a possibly dispatched tool without a durable terminal outcome.',
    }]);
  });

  it('attaches outcome_unknown only after the tool ledger records it', () => {
    const plan = repairSessionTail(toolTail(), [{
      id: '33333333-3333-4333-8333-333333333333',
      toolCallId: 'call-1',
      status: 'outcome_unknown',
      error: 'dispatch result was lost',
      completedAt: new Date(5000),
    }]);

    expect(plan.toolLedgerRepairs).toEqual([]);
    expect(plan.events[0]).toMatchObject({
      eventType: 'tool.outcome_attached',
      payload: {
        toolCallId: 'call-1',
        outcome: 'outcome_unknown',
        repair: true,
        message: { timestamp: 5000, toolCallId: 'call-1' },
      },
    });
    expect((plan.events[0]?.payload as { message?: { id?: string } }).message?.id)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.stringify(plan.events[0])).toContain('verify_before_retry');
  });

  it('reattaches a known successful result without requesting re-execution', () => {
    const plan = repairSessionTail(toolTail(), [{
      id: '33333333-3333-4333-8333-333333333333',
      toolCallId: 'call-1',
      status: 'succeeded',
      result: { stdout: 'C:/workspace' },
      completedAt: new Date(5000),
    }]);

    expect(plan.continuation).toEqual({ kind: 'repair_then_reconcile' });
    expect(plan.events[0]).toMatchObject({
      eventType: 'tool.outcome_attached',
      payload: {
        outcome: 'succeeded',
        message: { timestamp: 5000 },
      },
    });
  });

  it('continues the same open turn after every durable tool outcome is attached', () => {
    const repairedFold = foldSessionJournal([
      ...toolTailEvents(),
      event(5, 'tool.outcome_attached', {
        turnId: 'turn-1',
        toolCallId: 'call-1',
        outcome: 'succeeded',
        message: {
          id: 'tool-1',
          role: 'tool',
          toolCallId: 'call-1',
          content: 'ok',
          timestamp: 5,
        },
      }),
    ]);

    expect(repairSessionTail(repairedFold).continuation).toEqual({
      kind: 'continue_turn',
      turnId: 'turn-1',
    });
  });

  it('closes and restarts an open turn that has no durable model response', () => {
    const plan = repairSessionTail(foldSessionJournal(base()));

    expect(plan).toMatchObject({
      continuation: { kind: 'restart_turn', turnId: 'turn-1' },
      events: [{
        eventType: 'turn.interrupted',
        payload: { turnId: 'turn-1', source: 'recovery' },
      }],
    });
  });
});
