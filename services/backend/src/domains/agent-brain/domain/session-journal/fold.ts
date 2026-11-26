import type { Message, PlanItem } from '../types';
import {
  SESSION_EVENT_SCHEMA_VERSION,
  isMessage,
  isRecord,
  isSessionEventType,
  type DesiredSessionExecution,
  type SessionEventRecord,
  type SessionToolOutcome,
} from './types';

export type SessionJournalIssueCode =
  | 'sequence_gap'
  | 'session_mismatch'
  | 'unsupported_event'
  | 'unsupported_schema'
  | 'invalid_payload'
  | 'invalid_transition'
  | 'duplicate_message';

export interface SessionJournalIssue {
  code: SessionJournalIssueCode;
  sequence: number;
  detail: string;
}

export interface FoldedToolRequest {
  turnId: string;
  toolCallId: string;
  toolName: string;
  modelRequestId?: string;
  arguments?: string;
  requestedSequence: number;
  outcome?: SessionToolOutcome;
  outcomeSequence?: number;
  outcomeMessageId?: string;
}

export interface UnregisteredToolCall {
  turnId: string;
  modelRequestId: string;
  toolCallId: string;
  toolName: string;
  arguments: string;
  acceptedSequence: number;
}

export interface SessionJournalFold {
  sessionId?: string;
  created: boolean;
  desiredExecution: DesiredSessionExecution;
  /** Canonical semantic completion; the DB flag is only its rebuildable projection. */
  isCompleted: boolean;
  lastSequence: number;
  recoverableThroughSequence: number;
  issues: SessionJournalIssue[];
  messages: Message[];
  pendingInputMessageIds: string[];
  openTurnId?: string;
  openTurnNumber?: number;
  openTurnHasModelResponse: boolean;
  openTurnNeedsContinuation: boolean;
  interruptedTurn?: {
    turnId: string;
    turnNumber?: number;
    reason: string;
  };
  toolRequests: FoldedToolRequest[];
  pendingToolRequests: FoldedToolRequest[];
  unregisteredToolCalls: UnregisteredToolCall[];
  pendingApprovalActionId?: string;
  approvedTool?: {
    actionId: string;
    toolCallId: string;
  };
  plan: PlanItem[];
  compactionVersion?: number;
  compactionTransactionId?: string;
  lastDeferredReason?: string;
  /** A durable retry remains executable until a replacement turn opens. */
  pendingDeferred?: {
    reason: string;
    retryAt?: string;
    requestedSequence: number;
  };
  pendingCloseout?: {
    reason: string;
    requestedSequence: number;
  };
  /** A Start command remains executable until a replacement turn is durably opened. */
  pendingStartSequence?: number;
  hasUnfinishedWork: boolean;
}

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === 'string' ? payload[key] as string : undefined;

const numberField = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === 'number' && Number.isFinite(payload[key])
    ? payload[key] as number
    : undefined;

type RecoveryRebaseBoundary = {
  recoverableThroughSequence: number;
  abandonedThroughSequence: number;
};

const recoveryRebaseBoundary = (
  event: SessionEventRecord,
): RecoveryRebaseBoundary | undefined => {
  if (event.eventType !== 'session.recovery_rebased' || !isRecord(event.payload)) return undefined;
  const recoverableThroughSequence = numberField(event.payload, 'recoverableThroughSequence');
  const abandonedThroughSequence = numberField(event.payload, 'abandonedThroughSequence');
  if (
    recoverableThroughSequence === undefined
    || abandonedThroughSequence === undefined
    || !Number.isInteger(recoverableThroughSequence)
    || !Number.isInteger(abandonedThroughSequence)
    || recoverableThroughSequence < 0
    || abandonedThroughSequence < recoverableThroughSequence
    || abandonedThroughSequence !== event.sequence - 1
  ) {
    return undefined;
  }
  return { recoverableThroughSequence, abandonedThroughSequence };
};

const appendMessage = (
  messages: Message[],
  messageIds: Set<string>,
  message: Message,
  issues: SessionJournalIssue[],
  sequence: number,
): boolean => {
  if (messageIds.has(message.id)) {
    issues.push({
      code: 'duplicate_message',
      sequence,
      detail: `Message ${message.id} was already accepted; duplicate ignored.`,
    });
    return false;
  }
  messages.push(message);
  messageIds.add(message.id);
  return true;
};

/**
 * Reconstruct the longest valid, contiguous prefix of a session journal.
 *
 * A malformed or gapped tail never destroys the prefix that came before it. The
 * returned issue identifies where recovery fidelity ended so callers can record
 * and surface the degradation without guessing at missing facts.
 */
export const foldSessionJournal = (events: readonly SessionEventRecord[]): SessionJournalFold => {
  // A rebase marker is appended after corruption is detected. It never erases
  // rows; it explicitly declares which unreadable physical tail is abandoned.
  // Filtering that range lets normal folding continue at the marker and keeps
  // all later facts ordered by their original sequence numbers.
  const rebaseMarkers = events.flatMap((event) => {
    const boundary = recoveryRebaseBoundary(event);
    return boundary ? [{ event, boundary }] : [];
  });
  const effectiveEvents = events.filter((candidate) => !rebaseMarkers.some(({ event, boundary }) =>
    candidate.sequence > boundary.recoverableThroughSequence
      && candidate.sequence <= boundary.abandonedThroughSequence
      && candidate.sequence !== event.sequence));
  const messages: Message[] = [];
  const messageIds = new Set<string>();
  const messageSequences = new Map<string, number>();
  const pendingInputs = new Set<string>();
  const toolRequests = new Map<string, FoldedToolRequest>();
  const modelToolCalls = new Map<string, UnregisteredToolCall>();
  const issues: SessionJournalIssue[] = [];

  let sessionId: string | undefined;
  let expectedSequence = 1;
  let recoverableThroughSequence = 0;
  let created = false;
  let desiredExecution: DesiredSessionExecution = 'stopped';
  let isCompleted = false;
  let openTurnId: string | undefined;
  let openTurnNumber: number | undefined;
  let openTurnHasModelResponse = false;
  let interruptedTurn: SessionJournalFold['interruptedTurn'];
  let pendingApproval: { actionId: string; toolCallId: string } | undefined;
  let approvedTool: SessionJournalFold['approvedTool'];
  let plan: PlanItem[] = [];
  let compactionVersion: number | undefined;
  let compactionTransactionId: string | undefined;
  let lastDeferredReason: string | undefined;
  let pendingDeferred: SessionJournalFold['pendingDeferred'];
  let pendingCloseout: SessionJournalFold['pendingCloseout'];
  let pendingStartSequence: number | undefined;

  for (const event of effectiveEvents) {
    if (event.sequence !== expectedSequence) {
      const rebase = recoveryRebaseBoundary(event);
      if (
        !rebase
        || rebase.recoverableThroughSequence !== recoverableThroughSequence
        || expectedSequence !== rebase.recoverableThroughSequence + 1
      ) {
        issues.push({
          code: 'sequence_gap',
          sequence: event.sequence,
          detail: `Expected sequence ${expectedSequence}, received ${event.sequence}.`,
        });
        break;
      }
      expectedSequence = event.sequence;
    }
    if (sessionId && event.sessionId !== sessionId) {
      issues.push({
        code: 'session_mismatch',
        sequence: event.sequence,
        detail: `Expected session ${sessionId}, received ${event.sessionId}.`,
      });
      break;
    }
    if (!isSessionEventType(event.eventType)) {
      issues.push({
        code: 'unsupported_event',
        sequence: event.sequence,
        detail: `Unsupported event type ${String(event.eventType)}.`,
      });
      break;
    }
    if (event.schemaVersion !== SESSION_EVENT_SCHEMA_VERSION) {
      issues.push({
        code: 'unsupported_schema',
        sequence: event.sequence,
        detail: `Unsupported schema version ${event.schemaVersion} for ${event.eventType}.`,
      });
      break;
    }
    if (!isRecord(event.payload)) {
      issues.push({
        code: 'invalid_payload',
        sequence: event.sequence,
        detail: `Payload for ${event.eventType} is not an object.`,
      });
      break;
    }

    const payload = event.payload as Record<string, unknown>;
    const invalid = (detail: string): void => {
      issues.push({ code: 'invalid_payload', sequence: event.sequence, detail });
    };
    const invalidTransition = (detail: string): void => {
      issues.push({ code: 'invalid_transition', sequence: event.sequence, detail });
    };

    if (!created
      && event.eventType !== 'session.created'
      && event.eventType !== 'legacy.session_imported'
      && event.eventType !== 'session.recovery_rebased') {
      invalidTransition(`${event.eventType} cannot precede the session creation/import boundary.`);
      break;
    }

    sessionId ??= event.sessionId;

    switch (event.eventType) {
      case 'session.created': {
        if (created) {
          invalidTransition('session.created cannot occur more than once.');
          break;
        }
        if (typeof payload.modelName !== 'string' || typeof payload.mode !== 'string') {
          invalid('session.created requires modelName and mode.');
          break;
        }
        created = true;
        desiredExecution = payload.desiredExecution === 'stopped' ? 'stopped' : 'running';
        break;
      }
      case 'legacy.session_imported': {
        if (created) {
          invalidTransition('legacy.session_imported cannot replace an initialized journal.');
          break;
        }
        if (!Array.isArray(payload.messages)
          || !payload.messages.every(isMessage)
          || (payload.desiredExecution !== 'running' && payload.desiredExecution !== 'stopped')) {
          invalid('legacy.session_imported requires desiredExecution and valid messages.');
          break;
        }
        created = true;
        desiredExecution = payload.desiredExecution;
        for (const message of payload.messages) {
          if (appendMessage(messages, messageIds, message, issues, event.sequence)) {
            messageSequences.set(message.id, event.sequence);
          }
        }
        break;
      }
      case 'session.start_requested':
        desiredExecution = 'running';
        isCompleted = false;
        pendingStartSequence = event.sequence;
        break;
      case 'session.stop_requested':
        desiredExecution = 'stopped';
        pendingStartSequence = undefined;
        break;
      case 'session.completed': {
        const reason = stringField(payload, 'reason');
        if (!reason) {
          invalid('session.completed requires reason.');
          break;
        }
        isCompleted = true;
        pendingStartSequence = undefined;
        pendingDeferred = undefined;
        break;
      }
      case 'input.accepted': {
        if (!isMessage(payload.message) || payload.message.role !== 'user') {
          invalid('input.accepted requires a user message.');
          break;
        }
        if (appendMessage(messages, messageIds, payload.message, issues, event.sequence)) {
          messageSequences.set(payload.message.id, event.sequence);
        }
        pendingInputs.add(payload.message.id);
        isCompleted = false;
        break;
      }
      case 'message.accepted': {
        if (!isMessage(payload.message)) {
          invalid('message.accepted requires a valid message.');
          break;
        }
        if (appendMessage(messages, messageIds, payload.message, issues, event.sequence)) {
          messageSequences.set(payload.message.id, event.sequence);
        }
        break;
      }
      case 'turn.started': {
        const turnId = stringField(payload, 'turnId');
        const turnNumber = numberField(payload, 'turnNumber');
        if (!turnId || turnNumber === undefined) {
          invalid('turn.started requires turnId and turnNumber.');
          break;
        }
        if (openTurnId) {
          invalidTransition(`turn ${turnId} cannot start while ${openTurnId} is open.`);
          break;
        }
        openTurnId = turnId;
        openTurnNumber = turnNumber;
        openTurnHasModelResponse = false;
        interruptedTurn = undefined;
        pendingStartSequence = undefined;
        pendingDeferred = undefined;
        const inputMessageIds = Array.isArray(payload.inputMessageIds)
          ? payload.inputMessageIds.filter((value): value is string => typeof value === 'string')
          : [];
        for (const messageId of inputMessageIds) pendingInputs.delete(messageId);
        break;
      }
      case 'model.response.accepted': {
        const turnId = stringField(payload, 'turnId');
        const modelRequestId = stringField(payload, 'modelRequestId');
        if (!turnId || !modelRequestId || !isMessage(payload.message) || payload.message.role !== 'assistant') {
          invalid('model.response.accepted requires turnId, modelRequestId, and an assistant message.');
          break;
        }
        if (turnId !== openTurnId) {
          invalidTransition(`model response for ${turnId} does not match open turn ${openTurnId ?? 'none'}.`);
          break;
        }
        if (appendMessage(messages, messageIds, payload.message, issues, event.sequence)) {
          messageSequences.set(payload.message.id, event.sequence);
        }
        if (turnId === openTurnId) openTurnHasModelResponse = true;
        for (const toolCall of payload.message.tool_calls ?? []) {
          modelToolCalls.set(toolCall.id, {
            turnId,
            modelRequestId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            arguments: toolCall.function.arguments,
            acceptedSequence: event.sequence,
          });
        }
        break;
      }
      case 'tool.requested': {
        const turnId = stringField(payload, 'turnId');
        const toolCallId = stringField(payload, 'toolCallId');
        const toolName = stringField(payload, 'toolName');
        if (!turnId || !toolCallId || !toolName) {
          invalid('tool.requested requires turnId, toolCallId, and toolName.');
          break;
        }
        if (toolRequests.has(toolCallId)) {
          invalidTransition(`tool request ${toolCallId} was already recorded.`);
          break;
        }
        const modelCall = modelToolCalls.get(toolCallId);
        if (!modelCall || modelCall.turnId !== turnId) {
          invalidTransition(`tool request ${toolCallId} has no matching accepted model response.`);
          break;
        }
        toolRequests.set(toolCallId, {
          turnId,
          toolCallId,
          toolName,
          modelRequestId: stringField(payload, 'modelRequestId'),
          arguments: stringField(payload, 'arguments'),
          requestedSequence: event.sequence,
        });
        modelToolCalls.delete(toolCallId);
        break;
      }
      case 'tool.outcome_attached': {
        const toolCallId = stringField(payload, 'toolCallId');
        const outcome = stringField(payload, 'outcome') as SessionToolOutcome | undefined;
        if (!toolCallId
          || !['succeeded', 'failed', 'blocked', 'outcome_unknown'].includes(outcome ?? '')
          || !isMessage(payload.message)
          || payload.message.role !== 'tool') {
          invalid('tool.outcome_attached requires a terminal outcome and tool message.');
          break;
        }
        const requested = toolRequests.get(toolCallId);
        if (!requested) {
          invalidTransition(`tool outcome ${toolCallId} has no matching request.`);
          break;
        }
        if (requested.outcome) {
          invalidTransition(`tool outcome ${toolCallId} was already attached.`);
          break;
        }
        if (appendMessage(messages, messageIds, payload.message, issues, event.sequence)) {
          messageSequences.set(payload.message.id, event.sequence);
        }
        requested.outcome = outcome;
        requested.outcomeSequence = event.sequence;
        requested.outcomeMessageId = payload.message.id;
        if (approvedTool?.toolCallId === toolCallId) approvedTool = undefined;
        break;
      }
      case 'approval.requested': {
        const actionId = stringField(payload, 'actionId');
        const toolCallId = stringField(payload, 'toolCallId');
        if (!actionId || !toolCallId) invalid('approval.requested requires actionId and toolCallId.');
        else if (pendingApproval) {
          invalidTransition(`approval ${pendingApproval.actionId} is already pending.`);
        } else if (!toolRequests.has(toolCallId)) {
          invalidTransition(`approval ${actionId} has no matching tool request ${toolCallId}.`);
        } else pendingApproval = { actionId, toolCallId };
        break;
      }
      case 'approval.decided': {
        const actionId = stringField(payload, 'actionId');
        if (!actionId || (payload.decision !== 'granted' && payload.decision !== 'denied')) {
          invalid('approval.decided requires actionId and decision.');
          break;
        }
        if (pendingApproval?.actionId !== actionId) {
          invalidTransition(`approval decision ${actionId} does not match pending approval ${pendingApproval?.actionId ?? 'none'}.`);
          break;
        }
        if (payload.decision === 'granted') {
          approvedTool = { actionId, toolCallId: pendingApproval.toolCallId };
        }
        pendingApproval = undefined;
        break;
      }
      case 'plan.changed':
        if (!Array.isArray(payload.plan)) invalid('plan.changed requires plan array.');
        else plan = payload.plan as PlanItem[];
        break;
      case 'compaction.applied': {
        const transactionId = stringField(payload, 'transactionId');
        const throughMessageId = stringField(payload, 'throughMessageId');
        if (!transactionId
          || !throughMessageId
          || !isMessage(payload.summaryMessage)
          || payload.summaryMessage.role !== 'assistant') {
          invalid('compaction.applied requires transactionId, throughMessageId, and an assistant summaryMessage.');
          break;
        }
        const summaryMessage = payload.summaryMessage;
        const cutoffIndex = messages.findIndex((message) => message.id === throughMessageId);
        if (cutoffIndex < 0) {
          invalidTransition(`compaction boundary message ${throughMessageId} is not in canonical history.`);
          break;
        }
        const cutoffSequence = messageSequences.get(throughMessageId);
        if (cutoffSequence === undefined) {
          invalidTransition(`compaction boundary message ${throughMessageId} has no journal sequence.`);
          break;
        }
        const removedMessages = messages.slice(0, cutoffIndex + 1);
        const removedMessageIds = new Set(removedMessages.map((message) => message.id));
        const compactedPendingInput = [...pendingInputs].find((messageId) => removedMessageIds.has(messageId));
        const compactedPendingTool = [...toolRequests.values()].find(
          (request) => !request.outcome && request.requestedSequence <= cutoffSequence,
        );
        const compactedUnregisteredTool = [...modelToolCalls.values()].find(
          (request) => request.acceptedSequence <= cutoffSequence,
        );
        if (compactedPendingInput || compactedPendingTool || compactedUnregisteredTool) {
          invalidTransition('compaction cannot discard unfinished input or tool work.');
          break;
        }
        const retainedMessages = messages.slice(cutoffIndex + 1);
        if (retainedMessages.some((message) => message.id === summaryMessage.id)) {
          invalidTransition(`compaction summary message ${summaryMessage.id} collides with retained history.`);
          break;
        }
        messages.splice(0, messages.length, summaryMessage, ...retainedMessages);
        messageIds.clear();
        for (const message of messages) messageIds.add(message.id);
        for (const removed of removedMessages) messageSequences.delete(removed.id);
        messageSequences.set(summaryMessage.id, event.sequence);
        for (const [toolCallId, request] of toolRequests) {
          if (request.outcomeSequence !== undefined && request.outcomeSequence <= cutoffSequence) {
            toolRequests.delete(toolCallId);
          }
        }
        compactionVersion = (compactionVersion ?? 0) + 1;
        compactionTransactionId = transactionId;
        break;
      }
      case 'execution.deferred': {
        const reason = stringField(payload, 'reason');
        if (!reason) invalid('execution.deferred requires reason.');
        else {
          lastDeferredReason = reason;
          pendingDeferred = {
            reason,
            retryAt: stringField(payload, 'retryAt'),
            requestedSequence: event.sequence,
          };
        }
        break;
      }
      case 'closeout.requested': {
        const reason = stringField(payload, 'reason');
        if (!reason) invalid('closeout.requested requires reason.');
        else pendingCloseout = { reason, requestedSequence: event.sequence };
        break;
      }
      case 'closeout.completed':
        pendingCloseout = undefined;
        isCompleted = true;
        pendingStartSequence = undefined;
        pendingDeferred = undefined;
        break;
      case 'turn.interrupted':
      case 'turn.completed': {
        const turnId = stringField(payload, 'turnId');
        if (!turnId) {
          invalid(`${event.eventType} requires turnId.`);
          break;
        }
        if (openTurnId !== turnId) {
          invalidTransition(`${event.eventType} for ${turnId} does not match open turn ${openTurnId ?? 'none'}.`);
          break;
        }
        if (event.eventType === 'turn.interrupted') {
          interruptedTurn = {
            turnId,
            turnNumber: openTurnNumber,
            reason: stringField(payload, 'reason') ?? 'interrupted',
          };
        } else {
          interruptedTurn = undefined;
        }
        openTurnId = undefined;
        openTurnNumber = undefined;
        openTurnHasModelResponse = false;
        break;
      }
      case 'session.recovery_rebased': {
        const boundary = recoveryRebaseBoundary(event);
        const reason = stringField(payload, 'reason');
        const replacementIntent = payload.desiredExecution;
        if (!boundary
          || !reason
          || (replacementIntent !== undefined
            && replacementIntent !== 'running'
            && replacementIntent !== 'stopped')) {
          invalid('session.recovery_rebased requires a valid abandoned range and reason.');
          break;
        }
        if (boundary.recoverableThroughSequence !== recoverableThroughSequence) {
          invalidTransition(
            `session.recovery_rebased expected recoverable sequence ${recoverableThroughSequence}, received ${boundary.recoverableThroughSequence}.`,
          );
          break;
        }
        // Catastrophic loss of the original creation row still leaves a
        // startable empty session. Later Start/Input facts can build on this
        // explicit replacement genesis instead of terminalizing the session.
        if (!created && boundary.recoverableThroughSequence === 0) {
          created = true;
        }
        if (replacementIntent === 'running' || replacementIntent === 'stopped') {
          desiredExecution = replacementIntent;
          if (replacementIntent === 'running') isCompleted = false;
          pendingStartSequence = replacementIntent === 'running' ? event.sequence : undefined;
        }
        break;
      }
      case 'session.data_loss_detected':
        if (!stringField(payload, 'kind') || !stringField(payload, 'detail')) {
          invalid('session.data_loss_detected requires kind and detail.');
        }
        break;
    }

    if (issues.some((issue) => issue.sequence === event.sequence
      && (issue.code === 'invalid_payload' || issue.code === 'invalid_transition'))) {
      break;
    }
    recoverableThroughSequence = event.sequence;
    expectedSequence += 1;
  }

  const pendingToolRequests = [...toolRequests.values()].filter((request) => !request.outcome);
  const unregisteredToolCalls = [...modelToolCalls.values()];
  const openTurnToolRequests = openTurnId
    ? [...toolRequests.values()].filter((request) => request.turnId === openTurnId)
    : [];
  return {
    sessionId,
    created,
    desiredExecution,
    isCompleted,
    lastSequence: recoverableThroughSequence,
    recoverableThroughSequence,
    issues,
    messages,
    pendingInputMessageIds: [...pendingInputs],
    openTurnId,
    openTurnNumber,
    openTurnHasModelResponse,
    openTurnNeedsContinuation: Boolean(
      openTurnId
      && openTurnHasModelResponse
      && openTurnToolRequests.length > 0
      && openTurnToolRequests.every((request) => request.outcome !== undefined),
    ),
    interruptedTurn,
    toolRequests: [...toolRequests.values()],
    pendingToolRequests,
    unregisteredToolCalls,
    pendingApprovalActionId: pendingApproval?.actionId,
    approvedTool,
    plan,
    compactionVersion,
    compactionTransactionId,
    lastDeferredReason,
    pendingDeferred,
    pendingCloseout,
    pendingStartSequence,
    hasUnfinishedWork: Boolean(
      openTurnId
      || pendingInputs.size > 0
      || pendingToolRequests.length > 0
      || unregisteredToolCalls.length > 0
      || pendingApproval
      || approvedTool
      || interruptedTurn
      || pendingDeferred
      || pendingCloseout
      || pendingStartSequence,
    ),
  };
};
