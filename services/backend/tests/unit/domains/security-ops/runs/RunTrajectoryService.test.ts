import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineEvent } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import {
  RunTrajectoryService,
  type RunTrajectoryLedgerSnapshot,
} from '@/domains/security-ops/runs/RunTrajectoryService';

const completeIntegrity = (sessionId: string) => ({
  acceptedHighWater: 3,
  persistedHighWater: 3,
  integrityStatus: 'complete',
  integrityDetails: {
    schema: 'trace-integrity/v1',
    sessionId,
    status: 'complete',
    acceptedHighWater: 3,
    persistedHighWater: 3,
    issues: [],
    surfaces: {
      model_requests: 'complete',
      provider_attempts: 'complete',
      tool_executions: 'complete',
      messages: 'complete',
      trace_events: 'complete',
      artifacts: 'complete',
      terminal_receipt: 'complete',
    },
  },
});

const session = (id: string, agentType: string, parentSessionId?: string) => ({
  id,
  agentType,
  metadata: parentSessionId ? { coordination: { parentSessionId } } : {},
  completed: true,
  blockedReason: null,
  createdAt: '2026-08-25T10:00:00.000Z',
  updatedAt: '2026-08-25T10:00:10.000Z',
});

const buildLedger = (): RunTrajectoryLedgerSnapshot => ({
  sessions: [
    session('planner-session', 'planner'),
    session('executor-session', 'executor', 'planner-session'),
    session('worker-session', 'worker', 'executor-session'),
  ],
  messages: [
    {
      id: 'message-input',
      sessionId: 'planner-session',
      role: 'user',
      content: 'Plan and execute the task.',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: '2026-08-25T10:00:00.000Z',
    },
    {
      id: 'message-response',
      sessionId: 'executor-session',
      role: 'assistant',
      content: 'Calling the artifact tool.',
      toolName: null,
      toolCallId: 'tool-call-1',
      metadata: { modelRequestId: 'request-main' },
      createdAt: '2026-08-25T10:00:06.000Z',
    },
  ],
  requests: [
    {
      requestId: 'request-source',
      sessionId: 'executor-session',
      runId: 'run-1',
      stepId: 'step-1',
      turn: 1,
      callOrdinal: 1,
      routeReason: 'fixture',
      provider: 'fixture',
      model: 'fixture-model',
      transformationRefs: [],
      contextMeasurementRefs: [],
      digest: 'source-digest',
      createdAt: '2026-08-25T10:00:01.000Z',
      envelope: {},
    },
    {
      requestId: 'request-main',
      sessionId: 'executor-session',
      runId: 'run-1',
      stepId: 'step-2',
      turn: 2,
      callOrdinal: 1,
      routeReason: 'fixture',
      provider: 'fixture',
      model: 'fixture-model',
      transformationRefs: ['context-1'],
      contextMeasurementRefs: [],
      digest: 'main-digest',
      createdAt: '2026-08-25T10:00:03.000Z',
      envelope: {},
    },
  ],
  contexts: [{
    transactionId: 'context-1',
    sessionId: 'executor-session',
    runId: 'run-1',
    stepId: 'step-2',
    turn: 2,
    status: 'activated',
    reducerProfile: 'summary',
    reason: 'context_capacity',
    intent: 'reduce',
    inputMessageIds: ['message-input'],
    replacementSummary: 'Earlier evidence compacted.',
    replacementMessageId: 'replacement-message-1',
    triggerRequestId: 'request-source',
    createdAt: '2026-08-25T10:00:02.000Z',
    activatedAt: '2026-08-25T10:00:02.500Z',
  }],
  attempts: [
    {
      id: 'attempt-1',
      sessionId: 'executor-session',
      turn: 2,
      logicalCallKey: 'call-1',
      modelRequestId: 'request-main',
      attemptOrdinal: 1,
      callOrdinal: 1,
      providerRequestId: 'provider-1',
      provider: 'fixture',
      reportedModel: 'fixture-model',
      requestStartedAt: '2026-08-25T10:00:04.000Z',
      requestCompletedAt: '2026-08-25T10:00:04.100Z',
      status: 'failed',
      errorClass: 'transient',
      retryDecision: 'retry',
      backoffMs: 50,
      totalTokens: 0,
    },
    {
      id: 'attempt-2',
      sessionId: 'executor-session',
      turn: 2,
      logicalCallKey: 'call-1',
      modelRequestId: 'request-main',
      attemptOrdinal: 2,
      callOrdinal: 1,
      providerRequestId: 'provider-2',
      provider: 'fixture',
      reportedModel: 'fixture-model',
      requestStartedAt: '2026-08-25T10:00:05.000Z',
      requestCompletedAt: '2026-08-25T10:00:05.200Z',
      status: 'completed',
      errorClass: null,
      retryDecision: 'stop',
      backoffMs: null,
      totalTokens: 12,
    },
  ],
  tools: [{
    id: 'tool-record-1',
    sessionId: 'executor-session',
    turnId: 'turn-2',
    toolCallId: 'tool-call-1',
    toolName: 'artifact_tool',
    modelRequestId: 'request-main',
    args: { path: 'proof.json' },
    result: { stored: true },
    status: 'completed',
    claimedAt: '2026-08-25T10:00:07.000Z',
    startedAt: '2026-08-25T10:00:07.010Z',
    completedAt: '2026-08-25T10:00:07.020Z',
    durationMs: 10,
    error: null,
  }],
});

const traces = (): Record<string, TimelineEvent[]> => ({
  'planner-session': [{
    id: 'planner-root',
    sessionId: 'planner-session',
    runId: 'run-1',
    turn: 1,
    ts: '2026-08-25T10:00:00.500Z',
    event: 'session.init',
    severity: 'info',
    acceptedOrdinal: 1,
  }],
  'executor-session': [{
    id: 'artifact-event',
    sessionId: 'executor-session',
    runId: 'run-1',
    turn: 2,
    ts: '2026-08-25T10:00:07.020Z',
    event: 'tool.finish',
    severity: 'info',
    acceptedOrdinal: 1,
    requestId: 'request-main',
    toolCallId: 'tool-call-1',
    artifactRef: 'artifacts/tool-call-1.json.gz',
    artifactSha256: 'a'.repeat(64),
    payload: { stored: true },
  }],
  'worker-session': [
    {
      id: 'worker-root',
      sessionId: 'worker-session',
      runId: 'run-1',
      turn: 1,
      ts: '2026-08-25T10:00:08.000Z',
      event: 'worker.started',
      severity: 'info',
      acceptedOrdinal: 1,
      workerTaskId: 'worker-task-1',
    },
    {
      id: 'worker-sibling-a',
      sessionId: 'worker-session',
      runId: 'run-1',
      turn: 1,
      ts: '2026-08-25T10:00:09.000Z',
      event: 'worker.progress',
      severity: 'info',
      acceptedOrdinal: 2,
      workerTaskId: 'worker-task-a',
      parentEventId: 'worker-root',
    },
    {
      id: 'worker-sibling-b',
      sessionId: 'worker-session',
      runId: 'run-1',
      turn: 1,
      ts: '2026-08-25T10:00:08.500Z',
      event: 'worker.progress',
      severity: 'info',
      acceptedOrdinal: 3,
      workerTaskId: 'worker-task-b',
      parentEventId: 'worker-root',
    },
  ],
});

describe('RunTrajectoryService', () => {
  let ledger: RunTrajectoryLedgerSnapshot;
  let events: Record<string, TimelineEvent[]>;
  let getAllEvents: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ledger = buildLedger();
    events = traces();
    getAllEvents = vi.fn(async (sessionId: string, hydrationMode: string) => (
      (events[sessionId] ?? []).map((event) => hydrationMode === 'strict'
        ? { ...event, inlinePayload: { hydrated: true, source: event.artifactRef ?? event.id } }
        : event)
    ));
  });

  const createService = () => new RunTrajectoryService({
    timelineService: { getAllEvents },
    ledgerSource: { load: vi.fn(async () => ledger) },
    sessionResolver: { listIdsByRunId: vi.fn(async () => ['worker-session']) },
    phaseSource: {
      listByRunId: vi.fn(async () => [
        { id: 'phase-plan', phaseKey: 'planning', ordinal: 1, sessionId: 'planner-session' },
        { id: 'phase-execute', phaseKey: 'execution', ordinal: 2, sessionId: 'executor-session' },
        { id: 'phase-worker', phaseKey: 'verification', ordinal: 3, sessionId: 'worker-session' },
      ]),
    },
    integritySource: { find: vi.fn(async (sessionId: string) => completeIntegrity(sessionId)) },
    now: () => new Date('2026-08-25T11:00:00.000Z'),
  });

  const run = {
    id: 'run-1',
    sessionId: 'executor-session',
    plannerSessionId: 'planner-session',
    executorSessionId: 'executor-session',
    status: 'completed',
  };

  it('reconstructs a multi-session request, retry, response, tool, and result chain', async () => {
    const response = await createService().getTrajectory(run, { limit: 100 });

    expect(response.schema).toBe('run-trajectory/v1');
    expect(response.sessionIds).toEqual(['planner-session', 'executor-session', 'worker-session']);
    expect(response.integrity.status).toBe('complete');
    expect(response.ordering).toMatchObject({
      scope: 'partial',
      crossSessionOrder: 'none',
      timestampsAreCausal: false,
    });

    const byId = new Map(response.records.map((record) => [record.id, record]));
    expect(byId.get('retry:attempt-1')?.causality.parentIds).toEqual(['request:request-main']);
    expect(byId.get('retry:attempt-2')?.causality.parentIds).toEqual(['retry:attempt-1']);
    expect(byId.get('response:message-response')?.causality.parentIds).toEqual(['retry:attempt-2']);
    expect(byId.get('tool:tool-record-1:invoke')?.causality.parentIds).toEqual(['response:message-response']);
    expect(byId.get('tool:tool-record-1:result')?.causality.parentIds).toEqual(['tool:tool-record-1:invoke']);
    expect(byId.get('tool:tool-record-1:result')?.source.artifactRef).toBe('artifacts/tool-call-1.json.gz');

    expect(byId.get('context:context-1')).toMatchObject({
      links: {
        sourceRequestRecordId: 'request:request-source',
        replacementMessageSourceId: 'agent_messages:replacement-message-1',
      },
      causality: { parentIds: ['request:request-source'] },
    });
    expect(byId.get('request:request-main')?.causality.parentIds).toEqual(['context:context-1']);

    const siblingA = byId.get('trace:worker-session:worker-sibling-a');
    const siblingB = byId.get('trace:worker-session:worker-sibling-b');
    expect(siblingA?.causality.siblingOrder).toBe('unordered');
    expect(siblingB?.causality.siblingOrder).toBe('unordered');
    expect(siblingA!.order.sessionOrdinal).toBeLessThan(siblingB!.order.sessionOrdinal);
    expect(Date.parse(siblingA!.presentation.timestamp!)).toBeGreaterThan(
      Date.parse(siblingB!.presentation.timestamp!),
    );

    expect(response.integrity.sourceCounts).toMatchObject({
      model_request_records: { source: 2, projected: 2 },
      usage_records: { source: 2, projected: 2 },
      tool_execution_records: { source: 2, projected: 2 },
      trace_events: { source: 5, projected: 5 },
    });
    expect(response.corpus).toMatchObject({
      runUnit: 'run',
      sessionUnit: 'session',
      fileUnit: 'source-record',
      sessions: 3,
      traceEvents: 5,
    });
  });

  it('hydrates artifact-backed tool detail through strict E6 trace hydration', async () => {
    const detail = await createService().getRecordDetail(run, 'tool:tool-record-1:result');

    expect(detail).toMatchObject({
      schema: 'run-trajectory-detail/v1',
      hydration: 'strict',
      record: { source: { artifactRef: 'artifacts/tool-call-1.json.gz' } },
      detail: { id: 'artifact-event', inlinePayload: { hydrated: true } },
    });
    expect(getAllEvents).toHaveBeenCalledWith('executor-session', 'strict');
  });

  it('uses the same projection for run and session filters without duplicating records', async () => {
    const service = createService();
    const runView = await service.getTrajectory(run, { limit: 100 });
    const sessionView = await service.getTrajectory(run, {
      sessionIds: ['executor-session'],
      limit: 100,
    });

    expect(new Set(runView.records.map((record) => record.id)).size).toBe(runView.records.length);
    expect(new Set(sessionView.records.map((record) => record.id)).size).toBe(sessionView.records.length);
    expect(sessionView.records.every((record) => record.sessionId === 'executor-session')).toBe(true);
    expect(sessionView.records).toEqual(
      runView.records.filter((record) => record.sessionId === 'executor-session'),
    );
  });

  it('keeps cursor reads stable when a source appends between pages', async () => {
    const service = createService();
    const first = await service.getTrajectory(run, { limit: 4 });
    expect(first.cursor.next).toBeTruthy();

    ledger.messages.push({
      id: 'message-live-append',
      sessionId: 'planner-session',
      role: 'user',
      content: 'Live follow-up input.',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: '2026-08-25T10:00:11.000Z',
    });
    const seen = [...first.records];
    let cursor = first.cursor.next;
    while (cursor) {
      const page = await service.getTrajectory(run, { limit: 4, cursor });
      seen.push(...page.records);
      cursor = page.cursor.next;
    }

    expect(new Set(seen.map((record) => record.id)).size).toBe(seen.length);
    expect(seen.some((record) => record.id === 'input:message-live-append')).toBe(true);
  });

  it('fails reconciliation for a missing explicit link and never substitutes timestamp order', async () => {
    events['worker-session']!.push({
      id: 'orphan-child',
      sessionId: 'worker-session',
      runId: 'run-1',
      turn: 1,
      ts: '2026-08-25T09:00:00.000Z',
      event: 'worker.progress',
      severity: 'info',
      acceptedOrdinal: 4,
      workerTaskId: 'worker-task-orphan',
      parentEventId: 'removed-parent',
    });

    const response = await createService().getTrajectory(run, { limit: 100 });
    const orphan = response.records.find((record) => record.id.endsWith(':orphan-child'));

    expect(response.integrity.status).toBe('failed');
    expect(response.integrity.issues).toContainEqual(expect.objectContaining({
      code: 'missing_causal_parent',
      recordId: orphan?.id,
      detail: expect.stringContaining('Timestamp order was not used'),
    }));
    expect(orphan?.causality.parentIds).toEqual(['trace:worker-session:removed-parent']);
  });

  it('supports old runs that only have messages and trace events', async () => {
    ledger = {
      sessions: [session('executor-session', 'executor')],
      messages: [buildLedger().messages[0]!],
      requests: [],
      contexts: [],
      attempts: [],
      tools: [],
    };
    ledger.messages[0] = { ...ledger.messages[0]!, sessionId: 'executor-session' };
    events = {
      'executor-session': [{
        id: 'legacy-event',
        sessionId: 'executor-session',
        turn: 0,
        ts: '2025-01-01T00:00:00.000Z',
        event: 'legacy.event',
        severity: 'info',
      }],
    };

    const response = await createService().getTrajectory({
      id: 'run-1',
      sessionId: 'executor-session',
      status: 'completed',
    }, { limit: 100 });

    expect(response.integrity.status).toBe('complete');
    // In the order they happened: the legacy event is stamped 2025, the message
    // 2026. This used to read `input, harness, terminal` because each ledger
    // numbered its own records on its own scale — trace events from 1, messages
    // not at all — so the sort produced strata rather than a sequence.
    expect(response.records.map((record) => record.kind)).toEqual(['harness', 'input', 'terminal']);
  });

  it('drops records with no known timing from a time-bounded read', async () => {
    // `presentation.timestamp` is `string | null` in the contract, and this is the
    // path that reaches the null: every ledger column feeding a timestamp is NOT
    // NULL, so an untimed record comes from a trace line whose `ts` does not
    // parse — a legacy or truncated event, which is exactly the material an
    // operator reaches for a trajectory page to explain.
    events['executor-session'] = [
      ...(events['executor-session'] ?? []),
      {
        id: 'legacy-untimed-event',
        sessionId: 'executor-session',
        turn: 2,
        ts: 'not-a-timestamp',
        event: 'legacy.untimed',
        severity: 'info',
      },
    ];

    const service = createService();
    const all = await service.getTrajectory(run, { limit: 200 });

    // The rule only means something if the fixture actually contains the case.
    const untimed = all.records.filter((record) => record.presentation.timestamp === null);
    expect(untimed.length).toBeGreaterThan(0);

    // A window in a year this run never touched selects nothing at all. The old
    // filter wrapped the range check in `if (record.presentation.timestamp)` and
    // then fell through to `return true`, so this returned every untimed record
    // in the run — the narrower the brush, the larger the share of the answer the
    // brush could not have selected.
    const outside = await service.getTrajectory(run, {
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
      limit: 200,
    });
    expect(outside.records).toEqual([]);

    // And the whole run selects every timed record and still no untimed one.
    const whole = await service.getTrajectory(run, {
      from: '2026-08-25T09:00:00.000Z',
      to: '2026-08-25T11:00:00.000Z',
      limit: 200,
    });
    // Compared as sets: dropping a record changes how the pager interleaves the
    // remaining sessions, and the claim under test is which records are selected,
    // not what order the pager hands them back in.
    expect(whole.records.map((record) => record.id).sort()).toEqual(
      all.records
        .filter((record) => record.presentation.timestamp !== null)
        .map((record) => record.id)
        .sort(),
    );
  });

  it('selects a bounded window by overlap, not by containment', async () => {
    const service = createService();
    const all = await service.getTrajectory(run, { limit: 200 });

    const spanning = all.records.find((record) => (
      record.presentation.timestamp !== null && (record.durationMs ?? 0) > 0
    ));
    expect(spanning).toBeDefined();

    const startedAt = Date.parse(spanning!.presentation.timestamp!);
    const endedAt = startedAt + spanning!.durationMs!;

    // A window that opens after the record started and closes before it ended
    // contains neither endpoint. It still overlaps, which is what a network
    // waterfall does and what an operator dragging over a lane expects.
    const inside = await service.getTrajectory(run, {
      from: new Date(startedAt + 1).toISOString(),
      to: new Date(endedAt - 1).toISOString(),
      limit: 200,
    });
    expect(inside.records.map((record) => record.id)).toContain(spanning!.id);

    // A window that closes before it started does not overlap.
    const before = await service.getTrajectory(run, {
      from: new Date(startedAt - 1000).toISOString(),
      to: new Date(startedAt - 1).toISOString(),
      limit: 200,
    });
    expect(before.records.map((record) => record.id)).not.toContain(spanning!.id);
  });

  describe('what a row actually says', () => {
    it('carries the message, not a label for the message', async () => {
      const response = await createService().getTrajectory(run, { limit: 200 });
      const byId = new Map(response.records.map((record) => [record.id, record]));

      // These used to read "User input accepted" and "Assistant response
      // accepted" for every message in every session — four hundred rows naming
      // the table they came from rather than saying what happened.
      expect(byId.get('input:message-input')?.summary).toBe('Plan and execute the task.');
      expect(byId.get('response:message-response')?.summary).toBe('Calling the artifact tool.');
    });

    it('names the calls a wordless assistant turn carried', async () => {
      ledger.messages = ledger.messages.map((message) => (
        message.id === 'message-response' ? { ...message, content: '' } : message
      ));
      const response = await createService().getTrajectory(run, { limit: 200 });
      const draft = response.records.find((record) => record.id === 'response:message-response');

      // An assistant turn that produced only tool calls said nothing. It used
      // to print as "Empty assistant message" — one line per envelope, with the
      // actual work filed elsewhere — so a transcript of a working session read
      // as a column of them. It is detail now, and it says which calls it
      // carried rather than that it was empty.
      expect(draft?.significance).toBe('detail');
      expect(draft?.summary).toBe('Called artifact_tool');
    });

    it('puts a tool call and its result on one row', async () => {
      const response = await createService().getTrajectory(run, { limit: 200 });
      const byId = new Map(response.records.map((record) => [record.id, record]));

      const result = byId.get('tool:tool-record-1:result');
      // The summary is what came BACK. The call rides `args`, where a reader
      // can pick the one argument that names the act — splicing the whole args
      // object in front of the arrow is what made every `file_write` row open
      // with the first paragraph of the file it wrote.
      expect(result?.summary).toBe('{"stored":true}');
      expect(result?.args).toEqual({ path: 'proof.json' });
      expect(result?.toolName).toBe('artifact_tool');
      // The invocation still exists — it anchors the causal edge — but reading
      // the call twice is not reading it better.
      expect(byId.get('tool:tool-record-1:invoke')?.significance).toBe('detail');
      expect(result?.significance).toBe('primary');
    });

    it('bounds an argument the model made enormous', async () => {
      ledger.tools[0] = {
        ...ledger.tools[0]!,
        args: { path: 'report.md', content: 'x'.repeat(5_000) },
      };
      const response = await createService().getTrajectory(run, { limit: 200 });
      const result = response.records.find((record) => record.id === 'tool:tool-record-1:result');

      // A `file_write` carries the whole file. The list response is not where a
      // file belongs, and the path — the fact a reader wants — survives.
      expect(result?.args?.path).toBe('report.md');
      expect(String(result?.args?.content).length).toBeLessThanOrEqual(200);
    });

    it('shows a failed tool result rather than its status word', async () => {
      ledger.tools[0] = {
        ...ledger.tools[0]!,
        status: 'error',
        error: 'connect ECONNREFUSED 10.0.0.4:443',
        result: null,
      };
      const response = await createService().getTrajectory(run, { limit: 200 });
      const result = response.records.find((record) => record.id === 'tool:tool-record-1:result');

      expect(result?.summary).toContain('ECONNREFUSED');
    });
  });

  describe('significance', () => {
    const traceEvent = (over: Partial<TimelineEvent> & { id: string; event: string }): TimelineEvent => ({
      sessionId: 'executor-session',
      turn: 1,
      ts: '2026-08-25T10:00:08.000Z',
      severity: 'info',
      ...over,
    });

    it('classifies infrastructure as detail and everything unknown as primary', async () => {
      events['executor-session'] = [
        ...(events['executor-session'] ?? []),
        traceEvent({ id: 'sandbox-1', event: 'sandbox.stats', note: 'container=75ac2e65 samples=4' }),
        traceEvent({ id: 'sandbox-2', event: 'sandbox.created', note: 'container=75ac2e65' }),
        traceEvent({ id: 'proj-1', event: 'workspace_projection.flushed' }),
        traceEvent({ id: 'model-1', event: 'model.call.finish', note: 'latency=200ms' }),
        traceEvent({ id: 'skill-1', event: 'skill.preloaded', note: 'cordis-plugin-development' }),
        // Nobody has classified this one. It arrives visible on purpose: a new
        // event that is slightly annoying beats a meaningful one silently hidden.
        traceEvent({ id: 'novel-1', event: 'something.nobody.classified' }),
      ];

      const response = await createService().getTrajectory(run, { limit: 200 });
      const significanceOf = (id: string) =>
        response.records.find((record) => record.id === `trace:executor-session:${id}`)?.significance;

      expect(significanceOf('sandbox-1')).toBe('detail');
      expect(significanceOf('sandbox-2')).toBe('detail');
      expect(significanceOf('proj-1')).toBe('detail');
      expect(significanceOf('model-1')).toBe('detail');
      expect(significanceOf('skill-1')).toBe('primary');
      expect(significanceOf('novel-1')).toBe('primary');
    });

    it('promotes a failure whatever emitted it', async () => {
      events['executor-session'] = [
        ...(events['executor-session'] ?? []),
        traceEvent({ id: 'sandbox-bad', event: 'sandbox.health_check_failed', severity: 'error' }),
        traceEvent({ id: 'sandbox-warn', event: 'sandbox.profile_fallback', severity: 'warning' }),
      ];

      const response = await createService().getTrajectory(run, { limit: 200 });
      const significanceOf = (id: string) =>
        response.records.find((record) => record.id === `trace:executor-session:${id}`)?.significance;

      // The prefix says infrastructure; the severity says something broke. A
      // sandbox that failed its health check is the reason the run died.
      expect(significanceOf('sandbox-bad')).toBe('primary');
      expect(significanceOf('sandbox-warn')).toBe('primary');
    });

    it('does not call a first successful attempt a retry', async () => {
      // The overwhelming case in a real run: one call, one attempt, it worked.
      ledger.attempts.push({
        ...ledger.attempts[1]!,
        id: 'attempt-solo',
        modelRequestId: 'request-source',
        attemptOrdinal: 1,
        status: 'completed',
        errorClass: null,
        retryDecision: 'stop',
        totalTokens: 240,
      });

      const response = await createService().getTrajectory(run, { limit: 200 });
      const byId = new Map(response.records.map((record) => [record.id, record]));

      // Fifteen consecutive rows reading "Attempt 1: completed" is the
      // projection describing `usage_records`, not the run.
      expect(byId.get('retry:attempt-solo')?.significance).toBe('detail');
      expect(byId.get('retry:attempt-solo')?.summary).not.toContain('Attempt');
      expect(byId.get('retry:attempt-solo')?.summary).toContain('240 tok');

      // A first attempt that failed, and the second that followed it, are both
      // the story of the run and stay visible.
      expect(byId.get('retry:attempt-1')?.significance).toBe('primary');
      expect(byId.get('retry:attempt-1')?.summary).toContain('Attempt 1 failed');
      expect(byId.get('retry:attempt-2')?.significance).toBe('primary');
    });

    it('narrows to the readable records on request, and keeps the rest reachable', async () => {
      const service = createService();
      const all = await service.getTrajectory(run, { limit: 200 });
      const primary = await service.getTrajectory(run, { significance: ['primary'], limit: 200 });
      const detail = await service.getTrajectory(run, { significance: ['detail'], limit: 200 });

      expect(primary.records.every((record) => record.significance === 'primary')).toBe(true);
      expect(detail.records.every((record) => record.significance === 'detail')).toBe(true);
      // Nothing is dropped from the projection — `sourceCounts` reconciliation
      // depends on every source record having a projected one.
      expect(primary.records.length + detail.records.length).toBe(all.records.length);
      expect(detail.records.length).toBeGreaterThan(0);
    });
  });
});
