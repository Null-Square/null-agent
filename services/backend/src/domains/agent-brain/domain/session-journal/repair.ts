import type { Message } from '../types';
import { deterministicHash128 } from '../deterministicHash';
import type { SessionJournalFold } from './fold';
import type { SessionEventProposal, SessionToolOutcome } from './types';

export interface RepairToolExecutionRecord {
  id?: string;
  toolCallId: string;
  status: 'claimed' | 'pending' | 'started' | 'succeeded' | 'completed' | 'failed' | 'blocked' | 'outcome_unknown';
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type SessionRepairContinuation =
  | { kind: 'none' }
  | { kind: 'wait_for_approval'; actionId: string }
  | { kind: 'execute_approved_tool'; actionId: string; toolCallId: string }
  | { kind: 'repair_then_reconcile' }
  | { kind: 'start_pending_input'; messageIds: string[] }
  | { kind: 'continue_turn'; turnId: string }
  | { kind: 'restart_turn'; turnId: string };

export interface SessionTailRepairPlan {
  events: SessionEventProposal[];
  toolLedgerRepairs: Array<{
    toolCallId: string;
    target: 'blocked' | 'outcome_unknown';
    reason: string;
  }>;
  continuation: SessionRepairContinuation;
}

const normalizeOutcome = (status: RepairToolExecutionRecord['status']): SessionToolOutcome | undefined => {
  if (status === 'completed' || status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'outcome_unknown' || status === 'pending' || status === 'started') return 'outcome_unknown';
  return undefined;
};

const safeStringify = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return String(value);
  }
};

const deterministicUuid = (key: string): string => {
  const digest = deterministicHash128(key);
  const versionNibble = '5';
  const variantNibble = ((Number.parseInt(digest[16] ?? '0', 16) & 0x03) | 0x08).toString(16);
  const hex = `${digest.slice(0, 12)}${versionNibble}${digest.slice(13, 16)}${variantNibble}${digest.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const recoveryToolMessage = (
  messageKey: string,
  toolCallId: string,
  toolName: string,
  outcome: SessionToolOutcome,
  record: RepairToolExecutionRecord,
  fallbackTimestamp = 0,
): Message => ({
  // Keep synthetic repair IDs deterministic so reconciliation retries project
  // the same message identity instead of duplicating the recovered outcome.
  id: deterministicUuid(`session-recovery-tool:${messageKey}`),
  role: 'tool',
  toolName,
  toolCallId,
  tool_call_id: toolCallId,
  timestamp: record.completedAt?.getTime() ?? record.startedAt?.getTime() ?? fallbackTimestamp,
  content: outcome === 'outcome_unknown'
    ? safeStringify({
      error: record.error ?? 'Tool dispatch may have occurred, but no durable terminal outcome is available.',
      outcome: 'outcome_unknown',
      guidance: 'verify_before_retry',
      recovered: true,
    })
    : safeStringify(record.result ?? (record.error ? { error: record.error } : { outcome })),
  metadata: {
    toolExecution: {
      schema: 'tool-execution-receipt/v1',
      toolName,
      toolCallId,
      outcome: outcome === 'outcome_unknown' ? 'interrupted' : outcome,
    },
    recovery: true,
  },
});

const toolRequestTimestamp = (fold: SessionJournalFold, toolCallId: string): number => {
  const assistant = [...fold.messages].reverse().find((message) =>
    message.role === 'assistant'
    && message.tool_calls?.some((toolCall) => toolCall.id === toolCallId));
  return assistant ? assistant.timestamp + 1 : 0;
};

/**
 * Propose deterministic events needed to make an interrupted journal tail safe.
 * This function performs no writes and never dispatches a tool.
 */
export const repairSessionTail = (
  fold: SessionJournalFold,
  toolExecutions: readonly RepairToolExecutionRecord[] = [],
): SessionTailRepairPlan => {
  if (!fold.created || fold.desiredExecution === 'stopped' || !fold.hasUnfinishedWork) {
    return { events: [], toolLedgerRepairs: [], continuation: { kind: 'none' } };
  }
  if (fold.pendingApprovalActionId) {
    return {
      events: [],
      toolLedgerRepairs: [],
      continuation: { kind: 'wait_for_approval', actionId: fold.pendingApprovalActionId },
    };
  }
  if (fold.approvedTool) {
    return {
      events: [],
      toolLedgerRepairs: [],
      continuation: {
        kind: 'execute_approved_tool',
        actionId: fold.approvedTool.actionId,
        toolCallId: fold.approvedTool.toolCallId,
      },
    };
  }

  const events: SessionEventProposal[] = [];
  for (const call of fold.unregisteredToolCalls) {
    events.push({
      eventType: 'tool.requested',
      correlationId: call.turnId,
      payload: {
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        modelRequestId: call.modelRequestId,
        arguments: call.arguments,
      },
    });
  }
  if (events.length > 0) {
    return { events, toolLedgerRepairs: [], continuation: { kind: 'repair_then_reconcile' } };
  }

  const executions = new Map(toolExecutions.map((record) => [record.toolCallId, record]));
  const toolLedgerRepairs: SessionTailRepairPlan['toolLedgerRepairs'] = [];
  for (const request of fold.pendingToolRequests) {
    const execution = executions.get(request.toolCallId);
    if (!execution) {
      const reason = 'Recovery proved the tool was never claimed, so no external dispatch occurred.';
      events.push({
        eventType: 'tool.outcome_attached',
        correlationId: request.turnId,
        payload: {
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          outcome: 'blocked',
          message: recoveryToolMessage(
            `${fold.sessionId ?? 'unknown'}:${request.turnId}:${request.toolCallId}:blocked`,
            request.toolCallId,
            request.toolName,
            'blocked',
            {
            toolCallId: request.toolCallId,
            status: 'blocked',
            error: reason,
            },
            toolRequestTimestamp(fold, request.toolCallId),
          ),
          repair: true,
        },
      });
      continue;
    }
    if (execution.status === 'claimed') {
      toolLedgerRepairs.push({
        toolCallId: request.toolCallId,
        target: 'blocked',
        reason: 'Recovery found a claimed tool that never crossed the durable dispatch boundary.',
      });
      continue;
    }
    if (execution.status === 'pending' || execution.status === 'started') {
      toolLedgerRepairs.push({
        toolCallId: request.toolCallId,
        target: 'outcome_unknown',
        reason: 'Recovery found a possibly dispatched tool without a durable terminal outcome.',
      });
      continue;
    }
    const outcome = normalizeOutcome(execution.status);
    if (!outcome) continue;
    events.push({
      eventType: 'tool.outcome_attached',
      correlationId: request.turnId,
      payload: {
        turnId: request.turnId,
        toolCallId: request.toolCallId,
        outcome,
        toolExecutionId: execution.id,
        message: recoveryToolMessage(
          `${fold.sessionId ?? 'unknown'}:${request.turnId}:${request.toolCallId}:${outcome}`,
          request.toolCallId,
          request.toolName,
          outcome,
          execution,
          toolRequestTimestamp(fold, request.toolCallId),
        ),
        repair: true,
      },
    });
  }
  // The external-effect ledger is authoritative. Freeze uncertain executions
  // there first, then reconcile again and attach the resulting terminal fact to
  // the journal. Never claim an unknown outcome in history ahead of the ledger.
  if (toolLedgerRepairs.length > 0) {
    return {
      events: [],
      toolLedgerRepairs,
      continuation: { kind: 'repair_then_reconcile' },
    };
  }
  if (events.length > 0) {
    return { events, toolLedgerRepairs: [], continuation: { kind: 'repair_then_reconcile' } };
  }
  if (!fold.openTurnId) {
    if (fold.pendingInputMessageIds.length > 0) {
      return {
        events: [],
        toolLedgerRepairs: [],
        continuation: {
          kind: 'start_pending_input',
          messageIds: fold.pendingInputMessageIds,
        },
      };
    }
    return fold.interruptedTurn
      ? {
          events: [],
          toolLedgerRepairs: [],
          continuation: { kind: 'restart_turn', turnId: fold.interruptedTurn.turnId },
        }
      : fold.pendingStartSequence !== undefined
        ? {
            events: [],
            toolLedgerRepairs: [],
            continuation: { kind: 'restart_turn', turnId: `start-${fold.pendingStartSequence}` },
          }
        : fold.pendingDeferred
          ? {
              events: [],
              toolLedgerRepairs: [],
              continuation: {
                kind: 'restart_turn',
                turnId: `deferred-${fold.pendingDeferred.requestedSequence}`,
              },
            }
          : { events: [], toolLedgerRepairs: [], continuation: { kind: 'none' } };
  }
  if (fold.openTurnNeedsContinuation) {
    return {
      events: [],
      toolLedgerRepairs: [],
      continuation: { kind: 'continue_turn', turnId: fold.openTurnId },
    };
  }
  if (fold.openTurnHasModelResponse) {
    return {
      events: [{
        eventType: 'turn.completed',
        correlationId: fold.openTurnId,
        payload: { turnId: fold.openTurnId, reason: 'recovered_complete_tail' },
      }],
      toolLedgerRepairs: [],
      continuation: { kind: 'repair_then_reconcile' },
    };
  }
  return {
    events: [{
      eventType: 'turn.interrupted',
      correlationId: fold.openTurnId,
      payload: {
        turnId: fold.openTurnId,
        reason: 'runtime ended before a durable model response was accepted',
        source: 'recovery',
      },
    }],
    toolLedgerRepairs: [],
    continuation: { kind: 'restart_turn', turnId: fold.openTurnId },
  };
};
