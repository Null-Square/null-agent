import { describe, expect, it } from 'vitest';
import {
  RunTrajectoryService,
  type RunTrajectoryLedgerSnapshot,
} from '@/domains/security-ops/runs/RunTrajectoryService';

/**
 * The order a conversation comes back in.
 *
 * This is the regression that mattered most. Every ledger used to number its
 * own records on its own scale — trace events from 1, requests by
 * `turn * 10_000`, messages not at all — so a comparison across two of them was
 * meaningless and the sort produced strata: all requests, then all messages,
 * then all attempts, then all answers. On the page that read as a wall of chat
 * followed by a wall of tool calls, which is not what a session is.
 *
 * The fixture is deliberately hostile: the second user message carries a UUID
 * that sorts BEFORE the first one, which is how the old tiebreak decided ties.
 */
const S = '11111111-1111-4111-8111-111111111111';
const at = (n: number) => new Date(Date.parse('2026-08-25T10:00:00.000Z') + n * 1000).toISOString();

const REQUEST_ONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQUEST_TWO = 'aaaaaaaa-0000-4000-8000-000000000002';

const ledger = (): RunTrajectoryLedgerSnapshot => ({
  sessions: [{
    id: S,
    agentType: 'executor',
    metadata: {},
    completed: true,
    blockedReason: null,
    createdAt: at(0),
    updatedAt: at(100),
  }],
  messages: [
    {
      id: 'ffffffff-0000-4000-8000-000000000001',
      sessionId: S,
      role: 'user',
      content: 'FIRST question',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: at(0),
    },
    {
      id: '00000000-0000-4000-8000-00000000000a',
      sessionId: S,
      role: 'assistant',
      content: 'FIRST answer',
      toolName: null,
      toolCallId: null,
      metadata: {
        modelRequestId: REQUEST_ONE,
        provider_reasoning: {
          provider: 'p',
          format: 'reasoning_content',
          content: 'Let me read the file first.',
          capturedAt: at(4),
        },
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }],
      },
      createdAt: at(5),
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: S,
      role: 'user',
      content: 'SECOND question',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: at(20),
    },
    {
      id: '22222222-0000-4000-8000-00000000000b',
      sessionId: S,
      role: 'assistant',
      content: 'SECOND answer',
      toolName: null,
      toolCallId: null,
      metadata: { modelRequestId: REQUEST_TWO },
      createdAt: at(25),
    },
  ],
  requests: [
    {
      requestId: REQUEST_ONE,
      sessionId: S,
      runId: 'run-1',
      stepId: null,
      turn: 1,
      callOrdinal: 1,
      routeReason: 'primary',
      provider: 'p',
      model: 'm',
      transformationRefs: [],
      contextMeasurementRefs: [],
      digest: 'd1',
      createdAt: at(2),
      envelope: {},
    },
    {
      requestId: REQUEST_TWO,
      sessionId: S,
      runId: 'run-1',
      stepId: null,
      turn: 2,
      callOrdinal: 1,
      routeReason: 'primary',
      provider: 'p',
      model: 'm',
      transformationRefs: [],
      contextMeasurementRefs: [],
      digest: 'd2',
      createdAt: at(22),
      envelope: {},
    },
  ],
  contexts: [],
  attempts: [
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      sessionId: S,
      turn: 1,
      logicalCallKey: 'k1',
      modelRequestId: REQUEST_ONE,
      attemptOrdinal: 1,
      callOrdinal: 1,
      providerRequestId: null,
      provider: 'p',
      reportedModel: 'm',
      requestStartedAt: at(2),
      requestCompletedAt: at(4),
      status: 'completed',
      errorClass: null,
      retryDecision: null,
      backoffMs: null,
      promptTokens: 900,
      cachedPromptTokens: 100,
      cacheWriteTokens: 0,
      completionTokens: 250,
      reasoningTokens: 80,
      totalTokens: 1250,
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      sessionId: S,
      turn: 2,
      logicalCallKey: 'k2',
      modelRequestId: REQUEST_TWO,
      attemptOrdinal: 1,
      callOrdinal: 1,
      providerRequestId: null,
      provider: 'p',
      reportedModel: 'm',
      requestStartedAt: at(22),
      requestCompletedAt: at(24),
      status: 'completed',
      errorClass: null,
      retryDecision: null,
      backoffMs: null,
      totalTokens: 400,
    },
  ],
  tools: [
    {
      id: 'tool-1',
      sessionId: S,
      turnId: 'turn-1',
      toolCallId: 'c1',
      toolName: 'file_read',
      modelRequestId: REQUEST_ONE,
      args: { path: 'a.md' },
      result: 'ok',
      status: 'completed',
      claimedAt: at(6),
      startedAt: at(6),
      completedAt: at(7),
      durationMs: 1000,
      error: null,
    },
  ],
});

const project = async (events: unknown[] = []) => {
  const snapshot = ledger();
  const service = new RunTrajectoryService({
    timelineService: { getAllEvents: async () => events } as never,
    ledgerSource: { load: async () => snapshot },
    sessionResolver: { listIdsByRunId: async () => [S] },
    integritySource: {
      find: async () => ({
        acceptedHighWater: 0,
        persistedHighWater: 0,
        integrityStatus: 'complete',
        integrityDetails: {},
      }),
    },
  });
  return service.getTrajectory({ id: 'run-1', sessionId: S, status: 'completed' } as never, { limit: 200 });
};

describe('trajectory order', () => {
  it('returns a conversation in the order it happened', async () => {
    const response = await project();
    const spoken = response.records
      .filter((record) => record.kind === 'input' || record.kind === 'response')
      .map((record) => record.summary);

    expect(spoken).toEqual(['FIRST question', 'FIRST answer', 'SECOND question', 'SECOND answer']);
  });

  it('interleaves what was said with what was done', async () => {
    const response = await project();
    const flow = response.records
      .filter((record) => (
        ['input', 'response', 'tool'].includes(record.kind)
        && record.causality.relation !== 'tool_invocation'
      ))
      .map((record) => record.kind);

    // The read of a.md happened between the first answer and the second
    // question, and that is where it has to appear. It used to sort after every
    // message in the session.
    expect(flow).toEqual(['input', 'response', 'tool', 'input', 'response']);
  });

  it('gives every message the turn it belongs to', async () => {
    const response = await project();
    const turns = response.records
      .filter((record) => record.kind === 'input' || record.kind === 'response')
      .map((record) => record.turn);

    // `agent_messages` has no turn column, so this is derived: an assistant
    // message from its own request, a user message from the request it caused.
    // Without it the transcript had no turns at all and could not group.
    expect(turns).toEqual([1, 1, 2, 2]);
  });

  it('carries the thinking, the tokens and the calls the answer made', async () => {
    const response = await project([
      {
        id: 'e1',
        sessionId: S,
        turn: 1,
        ts: at(4),
        event: 'model.call.finish',
        severity: 'info',
        acceptedOrdinal: 1,
        requestId: REQUEST_ONE,
        payload: { ttftMs: 420 },
      },
    ]);
    const answer = response.records.find((record) => record.summary === 'FIRST answer');

    // All three were already recorded and none had ever reached a surface: the
    // reasoning on the message's own metadata, the tokens on the provider
    // attempt, the time-to-first-token inside a trace payload the page hides.
    expect(answer?.thinking).toBe('Let me read the file first.');
    expect(answer?.tokens).toMatchObject({
      input: 900,
      cacheRead: 100,
      output: 250,
      reasoning: 80,
      total: 1250,
    });
    expect(answer?.ttftMs).toBe(420);
    expect(answer?.toolCallIds).toEqual(['c1']);
  });
});
