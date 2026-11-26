import { describe, expect, it } from 'vitest';

import {
  assembledBehaviorEvidenceSchema,
  assembledScenarios,
  type AssembledBehaviorEvidenceBundle,
  type AssembledScenarioResult,
  E1_ASSEMBLED_SCENARIO_ID,
  interruptedResultEvidenceSchema,
  type InterruptedResultEvidenceBundle,
  E2_ASSEMBLED_SCENARIO_ID,
  runtimeHostCapabilitiesEvidenceSchema,
  type RuntimeHostCapabilitiesEvidenceBundle,
  E3_ASSEMBLED_SCENARIO_ID,
  durableToolExecutionEvidenceSchema,
  type DurableToolExecutionEvidenceBundle,
  E4_ASSEMBLED_SCENARIO_ID,
  atomicModelRequestEvidenceSchema,
  type AtomicModelRequestEvidenceBundle,
  E5_LARGE_WINDOW_SCENARIO_ID,
  contextMeasurementCompactionEvidenceSchema,
  type ContextMeasurementCompactionEvidenceBundle,
  E5_OVERFLOW_SCENARIO_ID,
  contextOverflowRecoveryEvidenceSchema,
  type ContextOverflowRecoveryEvidenceBundle,
  E6_ASSEMBLED_SCENARIO_ID,
  traceArtifactIntegrityEvidenceSchema,
  type TraceArtifactIntegrityEvidenceBundle,
  E7_ASSEMBLED_SCENARIO_ID,
  providerAttemptAccountingEvidenceSchema,
  type ProviderAttemptAccountingEvidenceBundle,
  E8_ASSEMBLED_SCENARIO_ID,
  unifiedToolPipelineEvidenceSchema,
  type UnifiedToolPipelineEvidenceBundle,
  E9_ASSEMBLED_SCENARIO_ID,
  runTrajectoryReadModelEvidenceSchema,
  type RunTrajectoryReadModelEvidenceBundle,
  E10_ASSEMBLED_SCENARIO_ID,
  trajectoryWorkspaceEvidenceSchema,
  type TrajectoryWorkspaceEvidenceBundle,
  E11_ASSEMBLED_SCENARIO_ID,
  releaseAssuranceEvidenceSchema,
  type ReleaseAssuranceEvidenceBundle,
} from './assembled';
import {
  TOOL_TRUTH_SCENARIO_ID,
  type ToolTruthEvidence,
} from './assembled/scenarios/toolTruth';
import {
  SHIPPING_COMPOSITION_SCENARIO_ID,
  type ShippingCompositionEvidence,
} from './assembled/scenarios/shippingComposition';

describe('Harness 3.2 E0 assembled Behavior Lab', () => {
  it('detects a hidden authoritative failure that the first-tool assertion accepts', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === 'harness-verification-gate-detects-hidden-runtime-failure',
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<AssembledBehaviorEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(assembledBehaviorEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.fixtures.corrected.newGatePassed).toBe(true);
    expect(result.evidence.fixtures.negativeControl.legacyFirstToolAssertionPassed).toBe(true);
    expect(result.evidence.fixtures.negativeControl.newGatePassed).toBe(false);
    expect(result.evidence.verdict.namedMismatches).toEqual(expect.arrayContaining([
      'authoritative.tool_execution_claim_survived_cold_restart',
      'external.neutral_effect_executed_once',
    ]));
    expect(result.evidence.fixtures.corrected.artifacts.length).toBeGreaterThan(0);
    expect(result.evidence.fixtures.corrected.trace.some(
      (event) => event.payloadMode === 'artifact' && event.hydratedPayload !== undefined,
    )).toBe(true);
    expect(result.evidence.fixtures.corrected.externalState.count).toBe(1);
    expect(result.evidence.fixtures.negativeControl.externalState.count).toBe(2);
  });
});

describe('Harness 3.2 E2 runtime host capabilities', () => {
  it('selects durable owners and rejects ephemeral Research Lab tool state before dispatch', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E2_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<RuntimeHostCapabilitiesEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(runtimeHostCapabilitiesEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.fixtures.organization).toMatchObject({
      hostKind: 'organization',
      coldRestartPerformed: true,
      passed: true,
    });
    expect(result.evidence.fixtures.researchLab).toMatchObject({
      hostKind: 'research_lab',
      coldRestartPerformed: true,
      passed: true,
    });
    expect(result.evidence.fixtures.negativeControl).toMatchObject({
      rejected: true,
      errorCode: 'runtime_host_capability_registration_rejected',
      providerDispatches: 0,
      toolDispatches: 0,
      passed: true,
    });
  });
});

describe('Harness 3.2 E1 interrupted result safety', () => {
  it('requires verification unless durable evidence proves dispatch did not start', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E1_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<InterruptedResultEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(interruptedResultEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    for (const mode of [result.evidence.fixtures.live, result.evidence.fixtures.cold]) {
      expect(mode.find((fixture) => fixture.fixture === 'not_started')).toMatchObject({
        outcome: { kind: 'not_started', guidance: 'may_retry' },
        providerNextAction: 'retry_counter_increment',
        toolResultCounts: { openAiCompatible: 1, anthropic: 1 },
      });
      for (const fixtureName of ['started_without_terminal', 'legacy_no_ledger'] as const) {
        expect(mode.find((fixture) => fixture.fixture === fixtureName)).toMatchObject({
          outcome: { kind: 'outcome_unknown', guidance: 'verify_before_retry' },
          providerNextAction: 'verify_external_state',
          toolResultCounts: { openAiCompatible: 1, anthropic: 1 },
        });
      }
    }
    expect(result.evidence.verdict.negativeControlDetected).toBe(true);
    expect(result.evidence.verdict.namedMismatches).toContain(
      'recovery.no_unconditional_retry_instruction',
    );
  });
});

describe('Harness 3.2 E3 durable tool execution', () => {
  it('does not duplicate a neutral effect across the four restart boundaries', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E3_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<DurableToolExecutionEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(durableToolExecutionEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    for (const host of [
      result.evidence.fixtures.organization,
      result.evidence.fixtures.researchLab,
    ]) {
      expect(host.passed).toBe(true);
      expect(host.fixtures).toHaveLength(4);
      expect(host.fixtures.every((fixture) => fixture.externalEffectCount <= 1)).toBe(true);
      expect(host.fixtures.find((fixture) => fixture.faultPoint === 'after_claim'))
        .toMatchObject({ recoveryOutcome: 'not_started', externalEffectCount: 0 });
      expect(host.fixtures.find((fixture) => fixture.faultPoint === 'after_settle'))
        .toMatchObject({ recoveryOutcome: 'cached_success', externalEffectCount: 1 });
    }
    expect(result.evidence.fixtures.negativeControl.externalEffectCount).toBe(2);
    expect(result.evidence.verdict.namedMismatches).toEqual(expect.arrayContaining([
      'ordering.claim_precedes_external_effect',
      'external.effect_at_most_once',
    ]));
  });
});

describe('Harness 3.2 E4 atomic model request', () => {
  it('persists the exact provider envelope before both retry attempts', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E4_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<AtomicModelRequestEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(atomicModelRequestEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    for (const host of [
      result.evidence.fixtures.organization,
      result.evidence.fixtures.researchLab,
    ]) {
      expect(host.passed).toBe(true);
      expect(host.persistedRequest.schemaVersion).toBe(3);
      expect(host.persistedRequest.contextMeasurement).toMatchObject({
        requestId: host.persistedRequest.requestId,
        routedCapacity: 128000,
      });
      expect(host.dispatchedEnvelopes).toHaveLength(2);
      expect(host.attempts).toHaveLength(2);
      expect(new Set(host.attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
      expect(new Set(host.attempts.map((attempt) => attempt.requestId))).toEqual(
        new Set([host.persistedRequest.requestId]),
      );
    }
    expect(result.evidence.fixtures.negativeControl).toMatchObject({
      transportDispatches: 0,
      errorCode: 'model_request_digest_mismatch',
      passed: false,
    });
    expect(result.evidence.verdict.namedMismatches).toContain(
      'dispatch.digest_matches_record',
    );
  });
});

describe('Harness 3.2 E5 routed context measurement', () => {
  it('keeps all five profiles idle near the old 11% trigger and active near routed soft capacity', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E5_LARGE_WINDOW_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<ContextMeasurementCompactionEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(contextMeasurementCompactionEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.profiles).toHaveLength(5);
    expect(result.evidence.profiles.every((profile) => !profile.oldTriggerCompacted)).toBe(true);
    expect(result.evidence.profiles.every((profile) => profile.nearSoftCompacted)).toBe(true);
    expect(result.evidence.profiles.map((profile) => profile.selectedReducer)).toEqual([
      'exposure_verification',
      'finding_disposition',
      'compliance',
      'code_review',
      'pentest',
    ]);
    expect(result.evidence.routeChangeInvalidated).toBe(true);
    expect(result.evidence.negativeControl).toMatchObject({
      legacyWouldCompact: true,
      correctedCompacted: false,
      detected: true,
    });
  });
});

describe('Harness 3.2 E5 bounded context overflow recovery', () => {
  it('commits one stable-ID transformation, survives both crash boundaries, and stops a second overflow', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E5_OVERFLOW_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<ContextOverflowRecoveryEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(contextOverflowRecoveryEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.recovery).toMatchObject({
      providerDispatches: 2,
      committedTransactions: 1,
      failedPartialInHistory: false,
      result: 'recovered',
    });
    expect(result.evidence.recovery.requestIds).toHaveLength(2);
    expect(result.evidence.recovery.retryTransformationRefs).toContain(
      result.evidence.recovery.transactionId,
    );
    expect(result.evidence.crashes).toEqual([
      expect.objectContaining({
        faultPoint: 'before_activation',
        activeImmediatelyAfterCrash: false,
        activeAfterColdRecovery: true,
        transactionCount: 1,
        summarizerCalls: 1,
      }),
      expect.objectContaining({
        faultPoint: 'after_activation',
        activeImmediatelyAfterCrash: true,
        activeAfterColdRecovery: true,
        transactionCount: 1,
        summarizerCalls: 1,
      }),
    ]);
    expect(result.evidence.secondOverflow).toEqual({
      providerDispatches: 2,
      requestCount: 2,
      committedTransactions: 1,
      stopped: true,
    });
    expect(result.evidence.negativeControl.detected).toBe(true);
  });
});

describe('Harness 3.2 E6 trace and artifact integrity', () => {
  it('waits for accepted writes, verifies artifact detail, and exposes every incomplete control', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E6_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<TraceArtifactIntegrityEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(traceArtifactIntegrityEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.corrected).toMatchObject({
      closeWaitedForFlush: true,
      strictMarker: 'artifact-backed-terminal-marker',
      pairing: { starts: 1, finishes: 1, unmatched: 0 },
      integrity: { status: 'complete' },
    });
    expect(result.evidence.corrected.acceptedHighWater)
      .toBe(result.evidence.corrected.persistedHighWater);
    expect(result.evidence.negativeControls.corruptArtifact).toMatchObject({
      strictFailed: true,
      integrity: { status: 'failed' },
    });
    expect(result.evidence.negativeControls.rejectedWrite).toMatchObject({
      reason: 'closed',
      integrity: { status: 'degraded' },
    });
    expect(result.evidence.negativeControls.crashBeforeFlush).toMatchObject({
      recoveredEvents: 0,
      integrity: { status: 'degraded' },
    });
  });
});

describe('Harness 3.2 E7 provider attempts and accounting', () => {
  it('keeps one logical request across retry and blocks non-retryable/cancelled settlement', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E7_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<ProviderAttemptAccountingEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(providerAttemptAccountingEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.corrected.requestIds).toHaveLength(1);
    expect(result.evidence.corrected.attempts).toEqual([
      expect.objectContaining({
        attemptOrdinal: 1,
        state: 'failed',
        retryDecision: 'retry',
        backoffMs: 0,
      }),
      expect.objectContaining({
        attemptOrdinal: 2,
        state: 'succeeded',
        retryDecision: 'stop',
        usage: expect.objectContaining({
          cacheRead: 300,
          cacheWrite: 200,
          reasoning: 40,
          reasoningSource: 'estimated',
        }),
      }),
    ]);
    expect(result.evidence.corrected).toMatchObject({
      providerDispatches: 2,
      toolCalls: [{ id: 'tool-e7', name: 'neutral_counter' }],
      integrity: { status: 'complete' },
    });
    expect(result.evidence.negativeControls.nonRetryable).toMatchObject({
      providerDispatches: 1,
      attempts: [expect.objectContaining({ state: 'failed', retryDecision: 'stop' })],
    });
    expect(result.evidence.negativeControls.cancellation).toMatchObject({
      providerDispatches: 1,
      attempts: [expect.objectContaining({ state: 'cancelled' })],
      toolCalls: [],
    });
  });
});

describe('Harness 3.2 E8 unified tool pipeline', () => {
  it('preserves decisions and results while rejecting policy widening', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E8_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<UnifiedToolPipelineEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(unifiedToolPipelineEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.catalogCoverage).toMatchObject({
      owner: 'ToolsRegistry.executeResolvedTool',
      uncoveredToolIds: [],
    });
    expect(result.evidence.differential).toMatchObject({
      legacyDispatches: 1,
      unifiedDispatches: 1,
    });
    expect(result.evidence.lifecycle).toMatchObject({
      approvalEvents: 1,
      finalState: { dispatches: { read: 1, update: 1, denied: 0 } },
      invariantTraceEvents: 1,
      integrity: { status: 'complete' },
    });
    expect(result.evidence.lifecycle.toolRecords).toHaveLength(2);
    expect(result.evidence.lifecycle.requestIds).toHaveLength(4);
    expect(result.evidence.lifecycle.attempts).toHaveLength(4);
    expect(result.evidence.decisions.allowed.receipt.pipeline?.completedStages)
      .toEqual([
        'resolve', 'validate', 'describe', 'decide', 'claim', 'pre_hooks', 'start',
        'dispatch', 'normalize', 'settle', 'post_hooks', 'project', 'observe',
      ]);
    expect(result.evidence.decisions.approvalInitial.receipt).toMatchObject({
      outcome: 'awaiting_approval',
      pipeline: { completedStages: ['resolve', 'validate', 'describe', 'decide'] },
    });
    expect(result.evidence.decisions.wideningNegative.result).toMatchObject({
      pipelineInvariant: 'decision_monotonicity',
      forbidden: true,
    });
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });
  });
});

describe('Harness 3.2 E9 run-aware trajectory read model', () => {
  it('reconstructs the multi-session causal chain without timestamp causality', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E9_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<RunTrajectoryReadModelEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(runTrajectoryReadModelEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.projection).toMatchObject({
      sessionIds: ['e9-planner', 'e9-executor', 'e9-worker'],
      integrity: { status: 'complete' },
      ordering: { scope: 'partial', crossSessionOrder: 'none', timestampsAreCausal: false },
      corpus: {
        runUnit: 'run',
        sessionUnit: 'session',
        fileUnit: 'source-record',
        numericGates: { cacheRequired: false, deeperIndexingRequired: false },
      },
    });
    expect(result.evidence.chain.map((record) => record.id)).toEqual([
      'request:e9-request-main',
      'retry:e9-attempt-1',
      'retry:e9-attempt-2',
      'response:e9-response',
      'tool:e9-tool-record:invoke',
      'tool:e9-tool-record:result',
    ]);
    expect(result.evidence.context).toMatchObject({
      sourceRequestRecordId: 'request:e9-request-source',
      replacementMessageSourceId: 'agent_messages:e9-replacement-message',
    });
    expect(result.evidence.artifact).toMatchObject({
      artifactRef: 'artifacts/e9-tool-call.json.gz',
      hydration: 'strict',
      hydrated: true,
    });
    expect(result.evidence.concurrentSiblings).toMatchObject({
      siblingOrder: ['unordered', 'unordered'],
      timestampsAreCausal: false,
    });
    expect(result.evidence.negativeControl).toMatchObject({
      integrityStatus: 'failed',
      missingParentIssues: 1,
      timestampOrderPresentedAsCausal: false,
    });
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });
  });
});

describe('Harness 3.2 E10 operator trajectory workspace', () => {
  it('explains retry, compaction, and artifact-backed tool causality', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E10_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<TrajectoryWorkspaceEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(trajectoryWorkspaceEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.behavior).toMatchObject({
      neutralTaskCompleted: true,
      integrityStatus: 'complete',
      contextSourceRequestRecordId: 'request:e9-request-source',
      artifactHydration: 'strict',
      filteredIdsRemainStable: true,
    });
    expect(result.evidence.negativeControl).toEqual({
      integrityStatus: 'failed',
      missingParentIssues: 1,
      siblingOrder: ['unordered', 'unordered'],
      timestampsAreCausal: false,
    });
    expect(result.evidence.uiGates).toMatchObject({
      recordCorpus: 6393,
      typedArtifactRendererRequired: true,
      missingArtifactMustNotBeSynthesized: true,
    });
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });
  });
});

describe('Harness 3.2 E11 release assurance', () => {
  it('certifies every deterministic gate, supported host, and degraded rollback boundary', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === E11_ASSEMBLED_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as
      AssembledScenarioResult<ReleaseAssuranceEvidenceBundle>;

    expect(result.passed).toBe(true);
    expect(releaseAssuranceEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(result.evidence.scenarios).toHaveLength(12);
    expect(result.evidence.scenarios.every((receipt) => receipt.passed)).toBe(true);
    expect(result.evidence.hosts.map((host) => host.host)).toEqual([
      'organization',
      'research_lab',
    ]);
    expect(result.evidence.canary.hosts).toEqual([
      expect.objectContaining({
        host: 'organization',
        externalCounter: 1,
        recoveryOutcome: 'outcome_unknown',
      }),
      expect.objectContaining({
        host: 'research_lab',
        externalCounter: 1,
        recoveryOutcome: 'outcome_unknown',
      }),
    ]);
    expect(result.evidence.canary.trajectory).toEqual({
      backendIntegrity: 'complete',
      workspaceIntegrity: 'complete',
      chainIdsMatch: true,
    });
    expect(result.evidence.canary.negativeControl).toMatchObject({
      presentedAsComplete: false,
    });
    expect(result.evidence.migration).toMatchObject({
      legacyHistoryRead: true,
      legacyGuidance: 'verify_before_retry',
      forwardReadPassed: true,
    });
    expect(result.evidence.migration.durableHashAfter)
      .toBe(result.evidence.migration.durableHashBefore);
    expect(result.evidence.invariants).toHaveLength(13);
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });
  });
});

describe('Harness 3.2 tool truth', () => {
  it('separates whether a tool ran from what the target said, and records the route it took', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === TOOL_TRUTH_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<ToolTruthEvidence>;

    expect(result.passed).toBe(true);
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });
    expect(result.evidence.assertions).toHaveLength(11);
    expect(result.evidence.assertions.every((entry) => entry.passed)).toBe(true);

    // D2: the exact status distribution behind run r1's 63 failure-classed actions.
    expect(result.evidence.outcomeAxes.probesClassified).toBe(46);
    expect(result.evidence.outcomeAxes.probesCalledExecutionFailures).toBe(0);
    // ...and a request that never reached the target is still a failure.
    expect(result.evidence.outcomeAxes.runSummaryFailures).toBe(1);

    // D3: a 500 KB body no longer reaches the conversation to be truncated afterwards.
    expect(result.evidence.exchanges.largeBody.bodySize).toBe(500_000);
    expect(result.evidence.exchanges.largeBody.streamedShareOfBody).toBeLessThan(0.05);

    // D1: two network paths answering one URL are now distinguishable.
    expect(result.evidence.exchanges.disagreement.distinguishable).toBe(true);

    // D4: prose that looks like an address is not a destination.
    expect(result.evidence.networkGuard.falsePositives).toEqual([]);
    expect(result.evidence.networkGuard.missedTargets).toEqual([]);
  });
});

describe('Harness 3.2 shipping composition', () => {
  it('joins request, provider attempt, usage and terminal receipt in the production graph', async () => {
    const scenario = assembledScenarios.find(
      (candidate) => candidate.id === SHIPPING_COMPOSITION_SCENARIO_ID,
    );
    expect(scenario).toBeDefined();

    const result = await scenario!.run() as AssembledScenarioResult<ShippingCompositionEvidence>;

    expect(result.passed).toBe(true);
    expect(result.evidence.verdict).toEqual({
      correctedFixturePassed: true,
      negativeControlDetected: true,
      namedMismatches: [],
    });

    // D6: the chain is complete when the recorder reaches the attempt...
    expect(result.evidence.wired.missingFromChain).toEqual([]);
    expect(result.evidence.wired.durableAttempts).toBe(1);

    // ...and broken when it does not, which is the exact production defect. Durable
    // accounting still works, which is why nothing noticed for the life of the feature.
    expect(result.evidence.unwired.missingFromChain).toEqual([
      'model.attempt.started',
      'model.attempt.settled',
      'usage.recorded',
      // D8: lineage went to log.debug and an in-memory map, so run r1's five session traces
      // held zero lineage events and no cache question could be answered afterwards.
      'cache.lineage_expectation',
      'cache.lineage_observed',
    ]);
    expect(result.evidence.unwired.durableAttempts).toBe(1);

    // D7: one vocabulary, one meaning.
    expect(result.evidence.wired.usageVocabulary).toContain('inputTokensTotal');
    expect(result.evidence.wired.usageVocabulary).toContain('uncachedInputTokens');
    expect(result.evidence.wired.usageVocabulary).not.toContain('promptTokens');

    // D5: a close whose receipt cannot be written is not complete.
    expect(result.evidence.wired.integrityStatus).toBe('complete');
    expect(result.evidence.brokenIndex.integrityStatus).not.toBe('complete');
  });
});
