import { describe, expect, it } from 'vitest';
import {
  RunTrajectoryService,
  type RunTrajectoryLedgerSnapshot,
} from '@/domains/security-ops/runs/RunTrajectoryService';

/**
 * Which step a record belongs to, when the clock says otherwise.
 *
 * A turn is a sequence of steps: the model is asked, it answers, it calls
 * tools, the results come back and it is asked again. Every surface that reads
 * a trajectory wants that structure, and until now the projection published it
 * on the request record and nowhere else — so every reader re-derived it by
 * asking which records happened to sit next to each other.
 *
 * This fixture is the case adjacency cannot survive, and it is not exotic. One
 * turn, two model calls. The first call fires two tools; one returns in a
 * second and the other takes half a minute. The model does not wait for the
 * slow one — it speaks again at t+20 — so the slow result is emitted *after*
 * the second step's message, because records come back in clock order.
 *
 *   t+5   step 1 speaks          "Reading both files"
 *   t+6   step 1's fast tool     file_read
 *   t+20  step 2 speaks          "Found it"
 *   t+30  step 1's SLOW tool     http_request   ← adjacent to step 2
 *
 * Group by adjacency and the slow read is filed under a step that never asked
 * for it. `stepId` and `stepOrdinal` are what make it a lookup instead.
 */
const S = '11111111-1111-4111-8111-111111111111';
const at = (n: number) => new Date(Date.parse('2026-08-28T10:00:00.000Z') + n * 1000).toISOString();

const REQUEST_ONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQUEST_TWO = 'aaaaaaaa-0000-4000-8000-000000000002';
const STEP_ONE = 'step-turn1-call1';
const STEP_TWO = 'step-turn1-call2';

const request = (over: Partial<RunTrajectoryLedgerSnapshot['requests'][number]>) => ({
  requestId: REQUEST_ONE,
  sessionId: S,
  runId: 'run-1',
  stepId: STEP_ONE,
  turn: 1,
  callOrdinal: 1,
  routeReason: 'primary',
  provider: 'p',
  model: 'm',
  transformationRefs: [],
  contextMeasurementRefs: [],
  digest: 'd',
  createdAt: at(2),
  envelope: {},
  ...over,
});

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
      content: 'read both files',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: at(0),
    },
    {
      id: '00000000-0000-4000-8000-00000000000a',
      sessionId: S,
      role: 'assistant',
      content: 'Reading both files',
      toolName: null,
      toolCallId: null,
      metadata: {
        modelRequestId: REQUEST_ONE,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'http_request', arguments: '{}' } },
        ],
      },
      createdAt: at(5),
    },
    {
      id: '00000000-0000-4000-8000-00000000000b',
      sessionId: S,
      role: 'assistant',
      content: 'Found it',
      toolName: null,
      toolCallId: null,
      metadata: { modelRequestId: REQUEST_TWO },
      createdAt: at(20),
    },
  ],
  requests: [
    request({}),
    request({ requestId: REQUEST_TWO, stepId: STEP_TWO, callOrdinal: 2, createdAt: at(18), digest: 'd2' }),
  ],
  contexts: [{
    transactionId: 'ctx-1',
    sessionId: S,
    runId: 'run-1',
    stepId: STEP_TWO,
    turn: 1,
    status: 'activated',
    reducerProfile: 'same_turn_tool_result',
    reason: 'pressure',
    intent: 'reduce',
    inputMessageIds: ['m1', 'm2', 'm3'],
    beforeMeasurement: { counts: { promptTokens: 18_400 } },
    replacementSummary: 'A long model-written summary of everything it stopped seeing.',
    replacementMessageId: null,
    afterMeasurement: { counts: { promptTokens: 3_120 } },
    triggerRequestId: REQUEST_TWO,
    createdAt: at(17),
    activatedAt: at(17),
  }],
  attempts: [],
  tools: [
    {
      id: 'tool-fast',
      sessionId: S,
      // Digits scraped out of an identifier, and they disagree with the turn the
      // harness actually assigned. The request is the one that knows.
      turnId: 'turn-9',
      toolCallId: 'c1',
      toolName: 'file_read',
      modelRequestId: REQUEST_ONE,
      args: { path: 'a.md' },
      result: 'ok',
      status: 'completed',
      claimedAt: at(6),
      startedAt: at(6),
      completedAt: at(6),
      durationMs: 400,
      error: null,
    },
    {
      id: 'tool-slow',
      sessionId: S,
      turnId: 'turn-9',
      toolCallId: 'c2',
      toolName: 'http_request',
      modelRequestId: REQUEST_ONE,
      args: { url: '/exports/4470' },
      result: 'ok',
      status: 'completed',
      claimedAt: at(6),
      startedAt: at(6),
      completedAt: at(30),
      durationMs: 24_000,
      error: null,
    },
  ],
});

const project = async () => {
  const snapshot = ledger();
  const service = new RunTrajectoryService({
    timelineService: { getAllEvents: async () => [] } as never,
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

const results = (records: Awaited<ReturnType<typeof project>>['records']) =>
  records.filter((record) => record.kind === 'tool' && record.causality.relation === 'tool_result');

describe('trajectory steps', () => {
  it('emits the slow result after the next step spoke, which is when it happened', async () => {
    const response = await project();
    const flow = response.records
      .filter((record) => (
        ['response', 'tool'].includes(record.kind)
        && record.causality.relation !== 'tool_invocation'
        && record.significance === 'primary'
      ))
      .map((record) => record.summary);

    // Not a bug to fix — this is the clock telling the truth, and it is exactly
    // why a reader cannot group by what sits next to what.
    expect(flow).toEqual(['Reading both files', 'ok', 'Found it', 'ok']);
  });

  it('keeps the slow call on the step that asked for it', async () => {
    const response = await project();
    const byCall = new Map(results(response.records).map((record) => [record.toolCallId, record]));

    expect(byCall.get('c1')?.stepId).toBe(STEP_ONE);
    expect(byCall.get('c1')?.stepOrdinal).toBe(1);
    // The one adjacency gets wrong. It is emitted after step 2's message and it
    // still belongs to step 1, because the request it came from says so.
    expect(byCall.get('c2')?.stepId).toBe(STEP_ONE);
    expect(byCall.get('c2')?.stepOrdinal).toBe(1);
  });

  it('numbers a step by the model call, not by the groups a reader opened', async () => {
    const response = await project();
    const answers = response.records.filter((record) => record.kind === 'response');

    expect(answers.map((record) => record.summary)).toEqual(['Reading both files', 'Found it']);
    expect(answers.map((record) => record.stepId)).toEqual([STEP_ONE, STEP_TWO]);
    // Both are turn 1: `callOrdinal` is per turn, so this is the first and
    // second time the model was asked inside one turn.
    expect(answers.map((record) => record.stepOrdinal)).toEqual([1, 2]);
    expect(answers.map((record) => record.turn)).toEqual([1, 1]);
  });

  it('takes a tool call turn from its request, not from digits in an id', async () => {
    const response = await project();
    // `turnId` is `turn-9` on both tools. Parsing it gave turn 9 — a turn that
    // does not exist — and put every tool call in a group of its own.
    expect(results(response.records).map((record) => record.turn)).toEqual([1, 1]);
  });

  it('carries the step onto the request record itself', async () => {
    const response = await project();
    const requests = response.records.filter((record) => record.kind === 'request');
    expect(requests.map((record) => record.stepOrdinal)).toEqual([1, 2]);
  });

  it('says what a compaction shadowed, not what the reducer is called', async () => {
    const response = await project();
    const context = response.records.find((record) => record.kind === 'context');

    // The question a reader has here is how much history the model stopped
    // seeing. `same_turn_tool_result: pressure` is the reducer naming itself.
    expect(context?.summary).toBe('Compacted 3 messages · 18.4k → 3.1k tokens');
    // The model's own summary is the reduction's content and stays on the
    // detail, which is where the row's fold opens.
    expect(context?.summary).not.toContain('long model-written summary');
  });

  it('falls back to the reducer when nothing was measured', async () => {
    const snapshot = ledger();
    snapshot.contexts = [{
      ...snapshot.contexts[0]!,
      inputMessageIds: [],
      beforeMeasurement: undefined,
      afterMeasurement: undefined,
    }];
    const service = new RunTrajectoryService({
      timelineService: { getAllEvents: async () => [] } as never,
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
    const response = await service.getTrajectory(
      { id: 'run-1', sessionId: S, status: 'completed' } as never,
      { limit: 200 },
    );
    const context = response.records.find((record) => record.kind === 'context');
    expect(context?.summary).toBe('same_turn_tool_result: pressure');
  });
});
