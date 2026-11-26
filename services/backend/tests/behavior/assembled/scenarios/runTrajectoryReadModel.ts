import { execFileSync } from 'node:child_process';

import { z } from 'zod';

import type { TimelineEvent } from '../../../../src/domains/agent-brain/infrastructure/telemetry/TimelineService';
import {
  RunTrajectoryService,
  type RunTrajectoryLedgerSnapshot,
  type RunTrajectoryResponse,
  type TrajectoryRecord,
} from '../../../../src/domains/security-ops/runs/RunTrajectoryService';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E9_ASSEMBLED_SCENARIO_ID =
  'harness-read-model-reconstructs-multi-session-chain';

type ChainObservation = {
  id: string;
  parentIds: string[];
  kind: string;
};

export type RunTrajectoryReadModelEvidenceBundle = {
  schema: 'behavior-lab-run-trajectory-evidence/v1';
  scenarioId: typeof E9_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  projection: {
    sessionIds: string[];
    recordCount: number;
    integrity: RunTrajectoryResponse['integrity'];
    ordering: RunTrajectoryResponse['ordering'];
    corpus: RunTrajectoryResponse['corpus'];
  };
  performance: {
    sampleCount: number;
    p95ProjectionMs: number;
    budgetMs: number;
  };
  chain: ChainObservation[];
  context: {
    id: string;
    parentIds: string[];
    sourceRequestRecordId?: string;
    replacementMessageSourceId?: string;
  };
  artifact: {
    recordId: string;
    artifactRef?: string;
    hydration: string;
    hydrated: boolean;
  };
  filters: {
    runRecordIds: string[];
    executorRecordIds: string[];
    duplicateRunIds: string[];
    duplicateSessionIds: string[];
  };
  concurrentSiblings: {
    projectedIds: string[];
    timestampSortedIds: string[];
    siblingOrder: string[];
    timestampsAreCausal: boolean;
  };
  negativeControl: {
    integrityStatus: string;
    missingParentIssues: number;
    orphanParentIds: string[];
    timestampOrderPresentedAsCausal: boolean;
  };
  assertions: VerificationAssertion[];
  verdict: {
    correctedFixturePassed: boolean;
    negativeControlDetected: boolean;
    namedMismatches: string[];
  };
};

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
): VerificationAssertion => ({
  id,
  passed,
  expected,
  actual,
  authoritativeSource: 'E3-E8 ledgers + E6 accepted trace order and integrity index',
  detail,
});

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

const buildLedger = (): RunTrajectoryLedgerSnapshot => ({
  sessions: [
    {
      id: 'e9-planner',
      agentType: 'planner',
      metadata: {},
      completed: true,
      blockedReason: null,
      createdAt: '2026-08-25T12:00:00.000Z',
      updatedAt: '2026-08-25T12:00:10.000Z',
    },
    {
      id: 'e9-executor',
      agentType: 'executor',
      metadata: { coordination: { parentSessionId: 'e9-planner' } },
      completed: true,
      blockedReason: null,
      createdAt: '2026-08-25T12:00:01.000Z',
      updatedAt: '2026-08-25T12:00:10.000Z',
    },
    {
      id: 'e9-worker',
      agentType: 'worker',
      metadata: { coordination: { parentSessionId: 'e9-executor' } },
      completed: true,
      blockedReason: null,
      createdAt: '2026-08-25T12:00:02.000Z',
      updatedAt: '2026-08-25T12:00:10.000Z',
    },
  ],
  messages: [
    {
      id: 'e9-input',
      sessionId: 'e9-planner',
      role: 'user',
      content: 'Plan, execute, and verify the neutral artifact fixture.',
      toolName: null,
      toolCallId: null,
      metadata: {},
      createdAt: '2026-08-25T12:00:00.000Z',
    },
    {
      id: 'e9-response',
      sessionId: 'e9-executor',
      role: 'assistant',
      content: 'The provider recovered and selected the artifact tool.',
      toolName: null,
      toolCallId: 'e9-tool-call',
      metadata: { modelRequestId: 'e9-request-main' },
      createdAt: '2026-08-25T12:00:06.000Z',
    },
  ],
  requests: [
    {
      requestId: 'e9-request-source',
      sessionId: 'e9-executor',
      runId: 'e9-run',
      stepId: 'e9-step-source',
      turn: 1,
      callOrdinal: 1,
      routeReason: 'behavior_fixture',
      provider: 'behavior-scripted',
      model: 'scripted-e9',
      transformationRefs: [],
      contextMeasurementRefs: [],
      digest: 'e9-source-digest',
      createdAt: '2026-08-25T12:00:01.000Z',
      envelope: {},
    },
    {
      requestId: 'e9-request-main',
      sessionId: 'e9-executor',
      runId: 'e9-run',
      stepId: 'e9-step-main',
      turn: 2,
      callOrdinal: 1,
      routeReason: 'behavior_fixture',
      provider: 'behavior-scripted',
      model: 'scripted-e9',
      transformationRefs: ['e9-context'],
      contextMeasurementRefs: [],
      digest: 'e9-main-digest',
      createdAt: '2026-08-25T12:00:03.000Z',
      envelope: {},
    },
  ],
  contexts: [{
    transactionId: 'e9-context',
    sessionId: 'e9-executor',
    runId: 'e9-run',
    stepId: 'e9-step-main',
    turn: 2,
    status: 'activated',
    reducerProfile: 'behavior-summary',
    reason: 'context_capacity',
    intent: 'reduce',
    inputMessageIds: ['e9-input'],
    replacementSummary: 'Neutral source context reduced.',
    replacementMessageId: 'e9-replacement-message',
    triggerRequestId: 'e9-request-source',
    createdAt: '2026-08-25T12:00:02.000Z',
    activatedAt: '2026-08-25T12:00:02.500Z',
  }],
  attempts: [
    {
      id: 'e9-attempt-1',
      sessionId: 'e9-executor',
      turn: 2,
      logicalCallKey: 'e9-call',
      modelRequestId: 'e9-request-main',
      attemptOrdinal: 1,
      callOrdinal: 1,
      providerRequestId: 'e9-provider-1',
      provider: 'behavior-scripted',
      reportedModel: 'scripted-e9',
      requestStartedAt: '2026-08-25T12:00:04.000Z',
      requestCompletedAt: '2026-08-25T12:00:04.010Z',
      status: 'failed',
      errorClass: 'transient',
      retryDecision: 'retry',
      backoffMs: 0,
      totalTokens: 0,
    },
    {
      id: 'e9-attempt-2',
      sessionId: 'e9-executor',
      turn: 2,
      logicalCallKey: 'e9-call',
      modelRequestId: 'e9-request-main',
      attemptOrdinal: 2,
      callOrdinal: 1,
      providerRequestId: 'e9-provider-2',
      provider: 'behavior-scripted',
      reportedModel: 'scripted-e9',
      requestStartedAt: '2026-08-25T12:00:05.000Z',
      requestCompletedAt: '2026-08-25T12:00:05.010Z',
      status: 'completed',
      errorClass: null,
      retryDecision: 'stop',
      backoffMs: null,
      totalTokens: 20,
    },
  ],
  tools: [{
    id: 'e9-tool-record',
    sessionId: 'e9-executor',
    turnId: 'turn-2',
    toolCallId: 'e9-tool-call',
    toolName: 'behavior_artifact_tool',
    modelRequestId: 'e9-request-main',
    args: { subject: 'neutral' },
    result: { artifact: true },
    status: 'completed',
    claimedAt: '2026-08-25T12:00:07.000Z',
    startedAt: '2026-08-25T12:00:07.001Z',
    completedAt: '2026-08-25T12:00:07.010Z',
    durationMs: 9,
    error: null,
  }],
});

const buildTraces = (): Record<string, TimelineEvent[]> => ({
  'e9-planner': [{
    id: 'e9-planner-init',
    sessionId: 'e9-planner',
    runId: 'e9-run',
    turn: 1,
    ts: '2026-08-25T12:00:00.500Z',
    event: 'session.init',
    severity: 'info',
    acceptedOrdinal: 1,
  }],
  'e9-executor': [{
    id: 'e9-artifact-trace',
    sessionId: 'e9-executor',
    runId: 'e9-run',
    turn: 2,
    ts: '2026-08-25T12:00:07.010Z',
    event: 'tool.finish',
    severity: 'info',
    acceptedOrdinal: 1,
    requestId: 'e9-request-main',
    toolCallId: 'e9-tool-call',
    artifactRef: 'artifacts/e9-tool-call.json.gz',
    artifactSha256: 'a'.repeat(64),
  }],
  'e9-worker': [
    {
      id: 'e9-worker-root',
      sessionId: 'e9-worker',
      runId: 'e9-run',
      turn: 1,
      ts: '2026-08-25T12:00:08.000Z',
      event: 'worker.started',
      severity: 'info',
      acceptedOrdinal: 1,
      workerTaskId: 'e9-worker-root-task',
    },
    {
      id: 'e9-worker-a',
      sessionId: 'e9-worker',
      runId: 'e9-run',
      turn: 1,
      ts: '2026-08-25T12:00:09.000Z',
      event: 'worker.progress',
      severity: 'info',
      acceptedOrdinal: 2,
      workerTaskId: 'e9-worker-a-task',
      parentEventId: 'e9-worker-root',
    },
    {
      id: 'e9-worker-b',
      sessionId: 'e9-worker',
      runId: 'e9-run',
      turn: 1,
      ts: '2026-08-25T12:00:08.500Z',
      event: 'worker.progress',
      severity: 'info',
      acceptedOrdinal: 3,
      workerTaskId: 'e9-worker-b-task',
      parentEventId: 'e9-worker-root',
    },
  ],
});

const buildService = (
  ledger: RunTrajectoryLedgerSnapshot,
  traces: Record<string, TimelineEvent[]>,
): RunTrajectoryService => new RunTrajectoryService({
  timelineService: {
    async getAllEvents(sessionId, hydrationMode) {
      return (traces[sessionId] ?? []).map((event) => hydrationMode === 'strict'
        ? { ...event, inlinePayload: { hydrated: true, proof: 'neutral-e9-artifact' } }
        : event);
    },
  },
  ledgerSource: { async load() { return ledger; } },
  sessionResolver: { async listIdsByRunId() { return ['e9-worker']; } },
  phaseSource: {
    async listByRunId() {
      return [
        { id: 'e9-phase-plan', phaseKey: 'planning', ordinal: 1, sessionId: 'e9-planner' },
        { id: 'e9-phase-execute', phaseKey: 'execution', ordinal: 2, sessionId: 'e9-executor' },
        { id: 'e9-phase-worker', phaseKey: 'verification', ordinal: 3, sessionId: 'e9-worker' },
      ];
    },
  },
  integritySource: { async find(sessionId) { return completeIntegrity(sessionId); } },
  now: () => new Date('2026-08-25T12:01:00.000Z'),
});

const duplicateIds = (records: TrajectoryRecord[]): string[] => {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
};

const chainObservation = (records: TrajectoryRecord[], ids: string[]): ChainObservation[] => ids.map((id) => {
  const record = records.find((candidate) => candidate.id === id);
  return {
    id,
    parentIds: record?.causality.parentIds ?? [],
    kind: record?.kind ?? 'missing',
  };
});

const runScenario = async (): Promise<AssembledScenarioResult<RunTrajectoryReadModelEvidenceBundle>> => {
  const ledger = buildLedger();
  const traces = buildTraces();
  const run = {
    id: 'e9-run',
    sessionId: 'e9-executor',
    plannerSessionId: 'e9-planner',
    executorSessionId: 'e9-executor',
    status: 'completed',
  };
  const service = buildService(ledger, traces);
  const corrected = await service.getTrajectory(run, { limit: 100 });
  const executor = await service.getTrajectory(run, { sessionIds: ['e9-executor'], limit: 100 });
  const artifactDetail = await service.getRecordDetail(run, 'tool:e9-tool-record:result');
  const projectionSamples: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const measured = await service.getTrajectory(run, { limit: 100 });
    projectionSamples.push(measured.corpus.projectionMs);
  }
  const sortedSamples = [...projectionSamples].sort((left, right) => left - right);
  const p95ProjectionMs = sortedSamples[Math.ceil(sortedSamples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  const chainIds = [
    'request:e9-request-main',
    'retry:e9-attempt-1',
    'retry:e9-attempt-2',
    'response:e9-response',
    'tool:e9-tool-record:invoke',
    'tool:e9-tool-record:result',
  ];
  const chain = chainObservation(corrected.records, chainIds);
  const context = corrected.records.find((record) => record.id === 'context:e9-context')!;
  const siblings = corrected.records.filter((record) => (
    record.id === 'trace:e9-worker:e9-worker-a'
    || record.id === 'trace:e9-worker:e9-worker-b'
  ));
  const timestampSortedSiblingIds = [...siblings]
    .sort((left, right) => Date.parse(left.presentation.timestamp!) - Date.parse(right.presentation.timestamp!))
    .map((record) => record.id);
  const projectedSiblingIds = [...siblings]
    .sort((left, right) => left.order.sessionOrdinal - right.order.sessionOrdinal)
    .map((record) => record.id);

  const brokenTraces = buildTraces();
  brokenTraces['e9-worker']!.push({
    id: 'e9-orphan-child',
    sessionId: 'e9-worker',
    runId: 'e9-run',
    turn: 1,
    ts: '2026-08-25T11:00:00.000Z',
    event: 'worker.progress',
    severity: 'info',
    acceptedOrdinal: 4,
    workerTaskId: 'e9-orphan-task',
    parentEventId: 'e9-removed-parent',
  });
  const negative = await buildService(buildLedger(), brokenTraces).getTrajectory(run, { limit: 100 });
  const orphan = negative.records.find((record) => record.id === 'trace:e9-worker:e9-orphan-child')!;
  const missingParentIssues = negative.integrity.issues.filter((issue) => issue.code === 'missing_causal_parent');

  const expectedChainParents = [
    ['context:e9-context'],
    ['request:e9-request-main'],
    ['retry:e9-attempt-1'],
    ['retry:e9-attempt-2'],
    ['response:e9-response'],
    ['tool:e9-tool-record:invoke'],
  ];
  const assertions = [
    assertion(
      'projection.includes_planner_executor_and_worker_sessions',
      corrected.sessionIds.join(',') === 'e9-planner,e9-executor,e9-worker',
      ['e9-planner', 'e9-executor', 'e9-worker'],
      corrected.sessionIds,
      'The run-aware projection discovers every role session through the run and phase hierarchy.',
    ),
    assertion(
      'causality.request_retry_response_tool_result_is_traversable',
      chain.every((record, index) => record.parentIds.join(',') === expectedChainParents[index]!.join(',')),
      expectedChainParents,
      chain.map((record) => record.parentIds),
      'Every hop uses an E4/E7/message/E3 identifier; no timestamp-derived edge is accepted.',
    ),
    assertion(
      'context.links_trigger_request_and_replacement_message',
      context.causality.parentIds[0] === 'request:e9-request-source'
        && context.links?.replacementMessageSourceId === 'agent_messages:e9-replacement-message',
      { source: 'request:e9-request-source', replacement: 'agent_messages:e9-replacement-message' },
      { parents: context.causality.parentIds, links: context.links },
      'The E5 record preserves both the source request and authoritative replacement message link.',
    ),
    assertion(
      'artifact.detail_hydrates_strictly_on_demand',
      artifactDetail?.hydration === 'strict'
        && artifactDetail.record.source.artifactRef === 'artifacts/e9-tool-call.json.gz'
        && (artifactDetail.detail as TimelineEvent).inlinePayload !== undefined,
      { hydration: 'strict', artifactRef: 'artifacts/e9-tool-call.json.gz' },
      artifactDetail,
      'The detail path re-reads the E6 trace in strict mode and verifies the artifact receipt.',
    ),
    assertion(
      'filters.use_one_projection_without_duplicates',
      duplicateIds(corrected.records).length === 0
        && duplicateIds(executor.records).length === 0
        && executor.records.every((record) => record.sessionId === 'e9-executor')
        && executor.records.every((record) => corrected.records.some((candidate) => candidate.id === record.id)),
      { runDuplicates: [], sessionDuplicates: [], session: 'e9-executor' },
      {
        runDuplicates: duplicateIds(corrected.records),
        sessionDuplicates: duplicateIds(executor.records),
        executorSessions: [...new Set(executor.records.map((record) => record.sessionId))],
      },
      'Session views are filters over the same stable record IDs, not separate projections.',
    ),
    assertion(
      'partial_order_marks_concurrent_siblings_unordered',
      siblings.length === 2
        && siblings.every((record) => record.causality.siblingOrder === 'unordered')
        && projectedSiblingIds.join(',') !== timestampSortedSiblingIds.join(',')
        && corrected.ordering.timestampsAreCausal === false,
      { siblingOrder: ['unordered', 'unordered'], timestampsAreCausal: false },
      { projectedSiblingIds, timestampSortedSiblingIds, ordering: corrected.ordering },
      'Accepted session ordinals remain presentation order while concurrent sibling causality stays explicitly unordered.',
    ),
    assertion(
      'integrity.reconciles_e6_and_all_source_counts',
      corrected.integrity.status === 'complete'
        && Object.values(corrected.integrity.sourceCounts).every((count) => count.source === count.projected),
      { status: 'complete', countMismatches: 0 },
      corrected.integrity,
      'Every eligible ledger row and E6 event has exactly one typed projection (two tool phases by contract).',
    ),
    assertion(
      'performance.reports_numeric_corpus_units_within_budget',
      corrected.corpus.runUnit === 'run'
        && corrected.corpus.sessionUnit === 'session'
        && corrected.corpus.fileUnit === 'source-record'
        && p95ProjectionMs < corrected.corpus.numericGates.p95ProjectionMs
        && corrected.corpus.numericGates.cacheRequired === false
        && corrected.corpus.numericGates.deeperIndexingRequired === false,
      { projectionMs: '<1000', cacheRequired: false, deeperIndexingRequired: false },
      { ...corrected.corpus, sampleCount: projectionSamples.length, measuredP95ProjectionMs: p95ProjectionMs },
      'The measured known fixture names run/session/source units and stays below the explicit indexing gates.',
    ),
    assertion(
      'negative.missing_link_fails_without_timestamp_causality',
      negative.integrity.status === 'failed'
        && missingParentIssues.length === 1
        && orphan.causality.parentIds[0] === 'trace:e9-worker:e9-removed-parent'
        && negative.ordering.timestampsAreCausal === false,
      { status: 'failed', missingParentIssues: 1, timestampsAreCausal: false },
      {
        status: negative.integrity.status,
        missingParentIssues,
        orphanParents: orphan.causality.parentIds,
        ordering: negative.ordering,
      },
      'Removing an explicit edge fails reconciliation; an earlier timestamp never becomes a substitute parent.',
    ),
  ];

  const evidence: RunTrajectoryReadModelEvidenceBundle = {
    schema: 'behavior-lab-run-trajectory-evidence/v1',
    scenarioId: E9_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    projection: {
      sessionIds: corrected.sessionIds,
      recordCount: corrected.records.length,
      integrity: corrected.integrity,
      ordering: corrected.ordering,
      corpus: corrected.corpus,
    },
    performance: {
      sampleCount: projectionSamples.length,
      p95ProjectionMs,
      budgetMs: corrected.corpus.numericGates.p95ProjectionMs,
    },
    chain,
    context: {
      id: context.id,
      parentIds: context.causality.parentIds,
      sourceRequestRecordId: context.links?.sourceRequestRecordId,
      replacementMessageSourceId: context.links?.replacementMessageSourceId,
    },
    artifact: {
      recordId: artifactDetail?.record.id ?? 'missing',
      artifactRef: artifactDetail?.record.source.artifactRef,
      hydration: artifactDetail?.hydration ?? 'missing',
      hydrated: Boolean((artifactDetail?.detail as TimelineEvent | undefined)?.inlinePayload),
    },
    filters: {
      runRecordIds: corrected.records.map((record) => record.id),
      executorRecordIds: executor.records.map((record) => record.id),
      duplicateRunIds: duplicateIds(corrected.records),
      duplicateSessionIds: duplicateIds(executor.records),
    },
    concurrentSiblings: {
      projectedIds: projectedSiblingIds,
      timestampSortedIds: timestampSortedSiblingIds,
      siblingOrder: siblings.map((record) => record.causality.siblingOrder),
      timestampsAreCausal: corrected.ordering.timestampsAreCausal,
    },
    negativeControl: {
      integrityStatus: negative.integrity.status,
      missingParentIssues: missingParentIssues.length,
      orphanParentIds: orphan.causality.parentIds,
      timestampOrderPresentedAsCausal: negative.ordering.timestampsAreCausal,
    },
    assertions,
    verdict: {
      correctedFixturePassed: assertions.slice(0, -1).every((entry) => entry.passed),
      negativeControlDetected: assertions.at(-1)?.passed === true,
      namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
    },
  };
  const schemaResult = runTrajectoryReadModelEvidenceSchema.safeParse(evidence);
  const passed = assertions.every((entry) => entry.passed) && schemaResult.success;
  return {
    id: E9_ASSEMBLED_SCENARIO_ID,
    title: 'Run trajectory read model reconstructs a multi-session chain',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `failed=${evidence.verdict.namedMismatches.join(',')}${schemaResult.success ? '' : `; schema=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const runTrajectoryReadModelEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-run-trajectory-evidence/v1'),
  scenarioId: z.literal(E9_ASSEMBLED_SCENARIO_ID),
  projection: z.object({
    sessionIds: z.tuple([z.literal('e9-planner'), z.literal('e9-executor'), z.literal('e9-worker')]),
    recordCount: z.number().int().positive(),
    integrity: z.object({ status: z.literal('complete') }).passthrough(),
    ordering: z.object({
      scope: z.literal('partial'),
      crossSessionOrder: z.literal('none'),
      timestampsAreCausal: z.literal(false),
    }).passthrough(),
    corpus: z.object({
      runUnit: z.literal('run'),
      sessionUnit: z.literal('session'),
      fileUnit: z.literal('source-record'),
      projectionMs: z.number().lt(1_000),
      numericGates: z.object({
        cacheRequired: z.literal(false),
        deeperIndexingRequired: z.literal(false),
      }).passthrough(),
    }).passthrough(),
  }),
  performance: z.object({
    sampleCount: z.literal(20),
    p95ProjectionMs: z.number().nonnegative().lt(1_000),
    budgetMs: z.literal(1_000),
  }),
  chain: z.array(z.object({
    id: z.string(),
    parentIds: z.array(z.string()).length(1),
    kind: z.string(),
  })).length(6),
  context: z.object({
    sourceRequestRecordId: z.literal('request:e9-request-source'),
    replacementMessageSourceId: z.literal('agent_messages:e9-replacement-message'),
  }).passthrough(),
  artifact: z.object({
    artifactRef: z.literal('artifacts/e9-tool-call.json.gz'),
    hydration: z.literal('strict'),
    hydrated: z.literal(true),
  }).passthrough(),
  concurrentSiblings: z.object({
    siblingOrder: z.tuple([z.literal('unordered'), z.literal('unordered')]),
    timestampsAreCausal: z.literal(false),
  }).passthrough(),
  negativeControl: z.object({
    integrityStatus: z.literal('failed'),
    missingParentIssues: z.literal(1),
    timestampOrderPresentedAsCausal: z.literal(false),
  }).passthrough(),
  assertions: z.array(z.object({ id: z.string(), passed: z.literal(true) }).passthrough()).length(9),
  verdict: z.object({
    correctedFixturePassed: z.literal(true),
    negativeControlDetected: z.literal(true),
    namedMismatches: z.array(z.string()).length(0),
  }),
}).passthrough();

export const runTrajectoryReadModelScenario:
AssembledBehaviorScenario<RunTrajectoryReadModelEvidenceBundle> = {
  id: E9_ASSEMBLED_SCENARIO_ID,
  title: 'Run trajectory read model reconstructs a multi-session chain',
  why: 'Runs the production trajectory/v1 projector over neutral planner, executor, and worker E3-E8 records, including retry, context reduction, strict artifact hydration, partial ordering, filtering, and reconciliation failure.',
  run: runScenario,
};
