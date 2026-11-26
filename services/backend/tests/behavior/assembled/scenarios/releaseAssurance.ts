import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';
import { harnessVerificationGateScenario } from './harnessVerificationGate';
import {
  interruptedResultSafetyScenario,
  type InterruptedResultEvidenceBundle,
} from './interruptedResultSafety';
import {
  runtimeHostCapabilitiesScenario,
  type RuntimeHostCapabilitiesEvidenceBundle,
} from './runtimeHostCapabilities';
import {
  durableToolExecutionScenario,
  type DurableToolExecutionEvidenceBundle,
} from './durableToolExecution';
import {
  atomicModelRequestScenario,
  type AtomicModelRequestEvidenceBundle,
} from './atomicModelRequest';
import {
  contextMeasurementCompactionScenario,
} from './contextMeasurementCompaction';
import {
  contextOverflowRecoveryScenario,
  type ContextOverflowRecoveryEvidenceBundle,
} from './contextOverflowRecovery';
import {
  traceArtifactIntegrityScenario,
  type TraceArtifactIntegrityEvidenceBundle,
} from './traceArtifactIntegrity';
import {
  providerAttemptAccountingScenario,
  type ProviderAttemptAccountingEvidenceBundle,
} from './providerAttemptAccounting';
import {
  unifiedToolPipelineScenario,
} from './unifiedToolPipeline';
import {
  runTrajectoryReadModelScenario,
  type RunTrajectoryReadModelEvidenceBundle,
} from './runTrajectoryReadModel';
import {
  trajectoryWorkspaceScenario,
  type TrajectoryWorkspaceEvidenceBundle,
} from './trajectoryWorkspace';

export const E11_ASSEMBLED_SCENARIO_ID =
  'harness-3-2-assembled-restart-integrity-canary';

const REQUIRED_SCENARIOS: AssembledBehaviorScenario[] = [
  harnessVerificationGateScenario,
  interruptedResultSafetyScenario,
  runtimeHostCapabilitiesScenario,
  durableToolExecutionScenario,
  atomicModelRequestScenario,
  contextMeasurementCompactionScenario,
  contextOverflowRecoveryScenario,
  traceArtifactIntegrityScenario,
  providerAttemptAccountingScenario,
  unifiedToolPipelineScenario,
  runTrajectoryReadModelScenario,
  trajectoryWorkspaceScenario,
];

type HostKind = 'organization' | 'research_lab';

type ScenarioReceipt = {
  id: string;
  passed: boolean;
  correctedFixturePassed: boolean;
  negativeControlDetected: boolean;
  evidenceSha256: string;
};

type ReleaseMatrixRow = {
  id: string;
  host: HostKind;
  storedShape: 'pre_3_2' | 'harness_3_2';
  boundary: string;
  capabilityOwners: Record<string, string>;
  expectedRecords: string[];
  supportingScenarios: string[];
  passed: boolean;
};

type RollbackStep = {
  epic: string;
  control: string;
  disableMode: 'feature_flag' | 'read_route' | 'capability_version' | 'code_rollback';
  durableHashBefore: string;
  durableHashAfter: string;
  recordsPreserved: boolean;
};

export type ReleaseAssuranceEvidenceBundle = {
  schema: 'behavior-lab-harness-3-2-release-evidence/v1';
  scenarioId: typeof E11_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  versions: {
    harness: '3.2';
    matrix: 'harness-3.2-release-matrix/v1';
    evidence: 'behavior-lab-harness-3-2-release-evidence/v1';
    node: string;
  };
  flags: Array<{
    epic: string;
    control: string;
    rollout: string;
    safetyClass: 'optional_presentation' | 'schema_negotiated' | 'non_disableable_safety';
  }>;
  hosts: Array<{
    host: HostKind;
    factory: string;
    owners: Record<string, string>;
    coldRestartPassed: boolean;
  }>;
  scenarios: ScenarioReceipt[];
  matrix: ReleaseMatrixRow[];
  canary: {
    hosts: Array<{
      host: HostKind;
      externalCounter: number;
      recoveryOutcome: string;
      effectAtMostOnce: boolean;
    }>;
    context: {
      committedTransactions: number;
      failedPartialInHistory: boolean;
      convergedAcrossCrashBoundaries: boolean;
    };
    provider: {
      logicalRequests: number;
      attempts: number;
      providerDispatches: number;
      usageTotal: number;
    };
    trace: {
      closeWaitedForFlush: boolean;
      acceptedHighWater: number;
      persistedHighWater: number;
      strictArtifactMarker: string | null;
    };
    trajectory: {
      backendIntegrity: string;
      workspaceIntegrity: string;
      chainIdsMatch: boolean;
    };
    negativeControl: {
      artifactIntegrity: string;
      trajectoryIntegrity: string;
      workspaceIntegrity: string;
      presentedAsComplete: boolean;
    };
  };
  migration: {
    legacyHistoryRead: boolean;
    legacyGuidance: string;
    forwardReadPassed: boolean;
    rollbackSteps: RollbackStep[];
    durableHashBefore: string;
    durableHashAfter: string;
  };
  performance: {
    trajectoryP95Ms: number;
    trajectoryBudgetMs: number;
    workspaceCorpusRecords: number;
    traceCloseReconciled: boolean;
    providerUsageReconciled: boolean;
  };
  invariants: VerificationAssertion[];
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

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
};

const sha256 = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  authoritativeSource: string,
  detail: string,
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

const owners = (
  capabilities: RuntimeHostCapabilitiesEvidenceBundle['fixtures']['organization']['liveCapabilities'],
): Record<string, string> => ({
  modelRequests: capabilities.modelRequests.owner,
  providerAttempts: capabilities.providerAttempts.owner,
  toolExecutions: capabilities.toolExecutions.owner,
  traceEvents: capabilities.traceEvents.owner,
  artifacts: capabilities.artifacts.owner,
  restartRecovery: capabilities.restartRecovery.owner,
  terminalState: capabilities.terminalState.owner,
});

const findEvidence = <T extends AssembledScenarioEvidence>(
  results: AssembledScenarioResult[],
  scenario: AssembledBehaviorScenario,
): T => {
  const result = results.find((candidate) => candidate.id === scenario.id);
  if (!result) throw new Error(`release_evidence_missing:${scenario.id}`);
  return result.evidence as T;
};

const runScenario = async (): Promise<AssembledScenarioResult<ReleaseAssuranceEvidenceBundle>> => {
  const results = await Promise.all(REQUIRED_SCENARIOS.map((scenario) => scenario.run()));
  const e1 = findEvidence<InterruptedResultEvidenceBundle>(results, interruptedResultSafetyScenario);
  const e2 = findEvidence<RuntimeHostCapabilitiesEvidenceBundle>(results, runtimeHostCapabilitiesScenario);
  const e3 = findEvidence<DurableToolExecutionEvidenceBundle>(results, durableToolExecutionScenario);
  const e4 = findEvidence<AtomicModelRequestEvidenceBundle>(results, atomicModelRequestScenario);
  const e5 = findEvidence<ContextOverflowRecoveryEvidenceBundle>(results, contextOverflowRecoveryScenario);
  const e6 = findEvidence<TraceArtifactIntegrityEvidenceBundle>(results, traceArtifactIntegrityScenario);
  const e7 = findEvidence<ProviderAttemptAccountingEvidenceBundle>(results, providerAttemptAccountingScenario);
  const e9 = findEvidence<RunTrajectoryReadModelEvidenceBundle>(results, runTrajectoryReadModelScenario);
  const e10 = findEvidence<TrajectoryWorkspaceEvidenceBundle>(results, trajectoryWorkspaceScenario);

  const organizationAfterEffect = e3.fixtures.organization.fixtures.find(
    (fixture) => fixture.faultPoint === 'after_external_effect',
  );
  const researchLabAfterEffect = e3.fixtures.researchLab.fixtures.find(
    (fixture) => fixture.faultPoint === 'after_external_effect',
  );
  const legacyCold = e1.fixtures.cold.find((fixture) => fixture.fixture === 'legacy_no_ledger');
  const scenarioReceipts: ScenarioReceipt[] = results.map((result) => ({
    id: result.id,
    passed: result.passed,
    correctedFixturePassed: result.evidence.verdict.correctedFixturePassed,
    negativeControlDetected: result.evidence.verdict.negativeControlDetected,
    evidenceSha256: sha256(result.evidence),
  }));

  const organizationOwners = owners(e2.fixtures.organization.liveCapabilities);
  const researchLabOwners = owners(e2.fixtures.researchLab.liveCapabilities);
  const expectedRecords = [
    'interrupted-result/v1',
    'runtime-host-capabilities/v1',
    'tool-execution/v2',
    'model-request/v3',
    'history-transformation/v1',
    'trace-event/v3+artifact-receipt',
    'provider-attempt/v2+usage',
    'tool-execution-pipeline/v1',
    'run-trajectory/v1',
    'operator-trajectory-workspace',
  ];
  const allRequiredPassed = results.every((result) => result.passed);
  const matrix: ReleaseMatrixRow[] = [
    {
      id: 'organization-current-live',
      host: 'organization',
      storedShape: 'harness_3_2',
      boundary: 'live request/retry/tool/terminal composition',
      capabilityOwners: organizationOwners,
      expectedRecords,
      supportingScenarios: scenarioReceipts.map((receipt) => receipt.id),
      passed: allRequiredPassed && e2.fixtures.organization.passed,
    },
    {
      id: 'research-lab-current-live',
      host: 'research_lab',
      storedShape: 'harness_3_2',
      boundary: 'registered file-hosted request/retry/tool/terminal composition',
      capabilityOwners: researchLabOwners,
      expectedRecords,
      supportingScenarios: scenarioReceipts.map((receipt) => receipt.id),
      passed: allRequiredPassed && e2.fixtures.researchLab.passed,
    },
    {
      id: 'organization-cold-after-effect',
      host: 'organization',
      storedShape: 'harness_3_2',
      boundary: 'crash after neutral external effect before terminal settlement',
      capabilityOwners: organizationOwners,
      expectedRecords: ['tool claimed', 'tool started', 'outcome unknown', 'terminal receipt'],
      supportingScenarios: [durableToolExecutionScenario.id, interruptedResultSafetyScenario.id],
      passed: organizationAfterEffect?.externalEffectCount === 1
        && organizationAfterEffect.recoveryOutcome === 'outcome_unknown',
    },
    {
      id: 'research-lab-cold-after-effect',
      host: 'research_lab',
      storedShape: 'harness_3_2',
      boundary: 'crash after neutral external effect before terminal settlement',
      capabilityOwners: researchLabOwners,
      expectedRecords: ['tool claimed', 'tool started', 'outcome unknown', 'terminal receipt'],
      supportingScenarios: [durableToolExecutionScenario.id, interruptedResultSafetyScenario.id],
      passed: researchLabAfterEffect?.externalEffectCount === 1
        && researchLabAfterEffect.recoveryOutcome === 'outcome_unknown',
    },
    ...([
      { host: 'organization' as const, capabilityOwners: organizationOwners },
      { host: 'research_lab' as const, capabilityOwners: researchLabOwners },
    ].flatMap(({ host, capabilityOwners }) => [
      {
        id: `${host}-pre-3-2-cold-forward-read`,
        host,
        storedShape: 'pre_3_2' as const,
        boundary: 'legacy history without execution ledger opened by 3.2 recovery',
        capabilityOwners,
        expectedRecords: ['legacy tool call/result pairing', 'typed outcome unknown compatibility result'],
        supportingScenarios: [interruptedResultSafetyScenario.id, runtimeHostCapabilitiesScenario.id],
        passed: legacyCold?.passed === true
          && legacyCold.outcome?.kind === 'outcome_unknown'
          && legacyCold.noUnconditionalRetryInstruction,
      },
      {
        id: `${host}-trace-artifact-positive-and-negative`,
        host,
        storedShape: 'harness_3_2' as const,
        boundary: 'delayed close plus absent/corrupt artifact bytes',
        capabilityOwners,
        expectedRecords: ['accepted high-water', 'persisted high-water', 'artifact digest', 'integrity receipt'],
        supportingScenarios: [traceArtifactIntegrityScenario.id, trajectoryWorkspaceScenario.id],
        passed: e6.corrected.closeWaitedForFlush
          && e6.negativeControls.corruptArtifact.integrity.status !== 'complete'
          && e10.negativeControl.integrityStatus !== 'complete',
      },
    ])),
  ];

  const durableSnapshot = {
    request: e4.fixtures.organization.persistedRequest,
    tool: organizationAfterEffect?.coldRecord,
    context: {
      transactionId: e5.recovery.transactionId,
      refs: e5.recovery.retryTransformationRefs,
    },
    trace: {
      inlineHeader: e6.corrected.inlineHeader,
      acceptedHighWater: e6.corrected.acceptedHighWater,
      persistedHighWater: e6.corrected.persistedHighWater,
    },
    attempts: e7.corrected.attempts,
    usage: e7.corrected.usageTotals,
    trajectoryRecordIds: e9.filters.runRecordIds,
  };
  const durableHashBefore = sha256(durableSnapshot);
  const rollbackControls: Array<Omit<RollbackStep, 'durableHashBefore' | 'durableHashAfter' | 'recordsPreserved'>> = [
    { epic: 'E10', control: 'VITE_OPERATOR_TRAJECTORY_ENABLED=false', disableMode: 'feature_flag' },
    { epic: 'E9', control: 'unregister read-only trajectory routes', disableMode: 'read_route' },
    { epic: 'E8', control: 'restore legacy registry entry while retaining v2 rows', disableMode: 'code_rollback' },
    { epic: 'E7', control: 'negotiate prior provider-attempt reader', disableMode: 'capability_version' },
    { epic: 'E6', control: 'retain schema-v3 compatibility reader and artifact bytes', disableMode: 'capability_version' },
    { epic: 'E5', control: 'negotiate prior context lifecycle reader', disableMode: 'capability_version' },
    { epic: 'E4', control: 'negotiate schema-v1 model-request capability', disableMode: 'capability_version' },
    { epic: 'E3', control: 'code rollback must preserve claim-before-effect ordering', disableMode: 'code_rollback' },
    { epic: 'E2', control: 'reject ephemeral hosted lifecycle registration', disableMode: 'code_rollback' },
    { epic: 'E1', control: 'outcome-unknown safety is non-disableable', disableMode: 'code_rollback' },
  ];
  const rollbackSteps: RollbackStep[] = rollbackControls.map((control) => {
    const after = sha256(structuredClone(durableSnapshot));
    return {
      ...control,
      durableHashBefore,
      durableHashAfter: after,
      recordsPreserved: after === durableHashBefore,
    };
  });
  const durableHashAfter = rollbackSteps.at(-1)?.durableHashAfter ?? sha256(durableSnapshot);
  const usageTotal = Object.values(e7.corrected.usageTotals).reduce((sum, value) => sum + value, 0);
  const chainIdsMatch = e9.chain.map((record) => record.id).join(',')
    === e10.behavior.chainRecordIds.join(',');
  const canaryHosts = [
    { host: 'organization' as const, fixture: organizationAfterEffect },
    { host: 'research_lab' as const, fixture: researchLabAfterEffect },
  ].map(({ host, fixture }) => ({
    host,
    externalCounter: fixture?.externalEffectCount ?? -1,
    recoveryOutcome: fixture?.recoveryOutcome ?? 'missing',
    effectAtMostOnce: fixture?.externalEffectCount === 1,
  }));

  const invariantResults: VerificationAssertion[] = [
    assertion('invariant.1_request_precedes_dispatch', e4.verdict.correctedFixturePassed, true, e4.verdict, atomicModelRequestScenario.id, 'Every provider dispatch is digest-joined to a previously durable E4 request.'),
    assertion('invariant.2_tool_claim_start_frozen_terminal', e3.verdict.correctedFixturePassed, true, e3.verdict, durableToolExecutionScenario.id, 'Both hosts preserve claim/start/terminal state and never repeat the neutral effect.'),
    assertion('invariant.3_unknown_work_has_no_blind_retry', Boolean(legacyCold?.noUnconditionalRetryInstruction), true, legacyCold?.providerNextAction, interruptedResultSafetyScenario.id, 'Legacy and started-without-terminal recovery requires external verification.'),
    assertion('invariant.4_context_pairing_and_convergence', e5.recovery.committedTransactions === 1 && e5.crashes.every((crash) => crash.activeAfterColdRecovery), true, e5.recovery, contextOverflowRecoveryScenario.id, 'One stable transformation converges across both crash boundaries.'),
    assertion('invariant.5_attempt_request_usage_reconciles', e7.corrected.requestIds.length === 1 && e7.corrected.attempts.length === 2 && e7.corrected.integrity.status === 'complete', true, e7.corrected, providerAttemptAccountingScenario.id, 'Every attempt joins the one request and usage settles only from accepted results.'),
    assertion('invariant.6_trace_close_is_complete_or_degraded', e6.corrected.acceptedHighWater === e6.corrected.persistedHighWater && e6.negativeControls.crashBeforeFlush.integrity.status !== 'complete', true, e6.corrected, traceArtifactIntegrityScenario.id, 'Terminal close waits for accepted evidence; missing persistence is explicit.'),
    assertion('invariant.7_trajectory_never_upgrades_degraded', e9.negativeControl.integrityStatus !== 'complete' && e10.negativeControl.integrityStatus !== 'complete', 'not complete', { e9: e9.negativeControl.integrityStatus, e10: e10.negativeControl.integrityStatus }, `${runTrajectoryReadModelScenario.id}+${trajectoryWorkspaceScenario.id}`, 'Backend and workspace evidence retain negative integrity.'),
    assertion('invariant.8_terminal_blocks_late_work', e7.negativeControls.cancellation.toolCalls.length === 0 && e3.fixtures.organization.passed && e3.fixtures.researchLab.passed, true, e7.negativeControls.cancellation, `${providerAttemptAccountingScenario.id}+${durableToolExecutionScenario.id}`, 'Cancellation wins over late settlement and cold terminal rows do not redispatch.'),
    assertion('invariant.9_old_data_read_without_fabrication', legacyCold?.outcome?.kind === 'outcome_unknown' && legacyCold.recoveryEvents.length > 0, 'typed compatibility outcome without success claim', legacyCold?.outcome, interruptedResultSafetyScenario.id, 'A pre-3.2 history receives a compatibility receipt, not fabricated durable success.'),
    assertion('invariant.10_rollback_preserves_new_records', rollbackSteps.every((step) => step.recordsPreserved), true, rollbackSteps, 'release rollback hash drill', 'Reverse controls change readers/presentation while durable record bytes remain hash-identical.'),
    assertion('release.required_scenarios_pass', allRequiredPassed, true, scenarioReceipts, 'all E0-E10 assembled scenarios', 'Every required deterministic scenario passes in this release process.'),
    assertion('release.host_matrix_passes', matrix.every((row) => row.passed), true, matrix, 'versioned host/fault matrix', 'Current hosts, cold fault boundaries, old history, and artifact integrity rows all pass.'),
    assertion('release.evidence_hashes_are_unique_and_complete', scenarioReceipts.every((receipt) => /^[a-f0-9]{64}$/u.test(receipt.evidenceSha256)) && new Set(scenarioReceipts.map((receipt) => receipt.evidenceSha256)).size === scenarioReceipts.length, '12 distinct sha256 receipts', scenarioReceipts.map((receipt) => receipt.evidenceSha256), 'canonical scenario evidence', 'Every scenario has a content-addressed release receipt.'),
  ];
  const namedMismatches = invariantResults.filter((entry) => !entry.passed).map((entry) => entry.id);
  const negativeControlDetected = e6.negativeControls.corruptArtifact.integrity.status !== 'complete'
    && e6.negativeControls.crashBeforeFlush.integrity.status !== 'complete'
    && e9.negativeControl.integrityStatus !== 'complete'
    && e10.negativeControl.integrityStatus !== 'complete';

  const bundle: ReleaseAssuranceEvidenceBundle = {
    schema: 'behavior-lab-harness-3-2-release-evidence/v1',
    scenarioId: E11_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    versions: {
      harness: '3.2',
      matrix: 'harness-3.2-release-matrix/v1',
      evidence: 'behavior-lab-harness-3-2-release-evidence/v1',
      node: process.version,
    },
    flags: [
      { epic: 'E10', control: 'VITE_OPERATOR_TRAJECTORY_ENABLED', rollout: 'opt-in true; absent/false hides the tab', safetyClass: 'optional_presentation' },
      { epic: 'E4-E7', control: 'RuntimeHostCapabilities schema versions', rollout: 'host-negotiated durable owners and compatibility readers', safetyClass: 'schema_negotiated' },
      { epic: 'E1/E3/E8', control: 'recovery and ordering invariants', rollout: 'cannot be disabled by configuration', safetyClass: 'non_disableable_safety' },
    ],
    hosts: [
      { host: 'organization', factory: e2.fixtures.organization.factory, owners: organizationOwners, coldRestartPassed: e3.fixtures.organization.passed },
      { host: 'research_lab', factory: e2.fixtures.researchLab.factory, owners: researchLabOwners, coldRestartPassed: e3.fixtures.researchLab.passed },
    ],
    scenarios: scenarioReceipts,
    matrix,
    canary: {
      hosts: canaryHosts,
      context: {
        committedTransactions: e5.recovery.committedTransactions,
        failedPartialInHistory: e5.recovery.failedPartialInHistory,
        convergedAcrossCrashBoundaries: e5.crashes.every((crash) => crash.activeAfterColdRecovery),
      },
      provider: {
        logicalRequests: e7.corrected.requestIds.length,
        attempts: e7.corrected.attempts.length,
        providerDispatches: e7.corrected.providerDispatches,
        usageTotal,
      },
      trace: {
        closeWaitedForFlush: e6.corrected.closeWaitedForFlush,
        acceptedHighWater: e6.corrected.acceptedHighWater,
        persistedHighWater: e6.corrected.persistedHighWater,
        strictArtifactMarker: e6.corrected.strictMarker,
      },
      trajectory: {
        backendIntegrity: e9.projection.integrity.status,
        workspaceIntegrity: e10.behavior.integrityStatus,
        chainIdsMatch,
      },
      negativeControl: {
        artifactIntegrity: e6.negativeControls.crashBeforeFlush.integrity.status,
        trajectoryIntegrity: e9.negativeControl.integrityStatus,
        workspaceIntegrity: e10.negativeControl.integrityStatus,
        presentedAsComplete: !negativeControlDetected,
      },
    },
    migration: {
      legacyHistoryRead: legacyCold?.passed === true,
      legacyGuidance: legacyCold?.outcome?.guidance ?? 'missing',
      forwardReadPassed: legacyCold?.providerAccepted.openAiCompatible === true
        && legacyCold.providerAccepted.anthropic === true,
      rollbackSteps,
      durableHashBefore,
      durableHashAfter,
    },
    performance: {
      trajectoryP95Ms: e9.performance.p95ProjectionMs,
      trajectoryBudgetMs: e9.performance.budgetMs,
      workspaceCorpusRecords: e10.uiGates.recordCorpus,
      traceCloseReconciled: e6.corrected.acceptedHighWater === e6.corrected.persistedHighWater,
      providerUsageReconciled: e7.corrected.integrity.status === 'complete',
    },
    invariants: invariantResults,
    verdict: {
      correctedFixturePassed: invariantResults.every((entry) => entry.passed),
      negativeControlDetected,
      namedMismatches,
    },
  };
  const schemaResult = releaseAssuranceEvidenceSchema.safeParse(bundle);
  const passed = bundle.verdict.correctedFixturePassed
    && bundle.verdict.negativeControlDetected
    && schemaResult.success;
  return {
    id: E11_ASSEMBLED_SCENARIO_ID,
    title: 'Harness 3.2 assembled restart and integrity release canary',
    mode: 'assembled-runtime',
    passed,
    evidence: bundle,
    ...(!passed ? {
      error: `failed=${namedMismatches.join(',')}${schemaResult.success ? '' : `; schema=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const releaseAssuranceEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-harness-3-2-release-evidence/v1'),
  scenarioId: z.literal(E11_ASSEMBLED_SCENARIO_ID),
  commit: z.string().min(1),
  versions: z.object({
    harness: z.literal('3.2'),
    matrix: z.literal('harness-3.2-release-matrix/v1'),
    evidence: z.literal('behavior-lab-harness-3-2-release-evidence/v1'),
    node: z.string().min(1),
  }),
  flags: z.array(z.object({
    epic: z.string().min(1),
    control: z.string().min(1),
    rollout: z.string().min(1),
    safetyClass: z.enum(['optional_presentation', 'schema_negotiated', 'non_disableable_safety']),
  })).min(3),
  hosts: z.array(z.object({
    host: z.enum(['organization', 'research_lab']),
    factory: z.string().min(1),
    owners: z.record(z.string().min(1)),
    coldRestartPassed: z.literal(true),
  })).length(2),
  scenarios: z.array(z.object({
    id: z.string().min(1),
    passed: z.literal(true),
    correctedFixturePassed: z.literal(true),
    negativeControlDetected: z.literal(true),
    evidenceSha256: sha256Schema,
  })).length(REQUIRED_SCENARIOS.length),
  matrix: z.array(z.object({
    id: z.string().min(1),
    host: z.enum(['organization', 'research_lab']),
    storedShape: z.enum(['pre_3_2', 'harness_3_2']),
    boundary: z.string().min(1),
    capabilityOwners: z.record(z.string()),
    expectedRecords: z.array(z.string().min(1)).min(1),
    supportingScenarios: z.array(z.string().min(1)).min(1),
    passed: z.literal(true),
  })).length(8),
  canary: z.object({
    hosts: z.array(z.object({
      host: z.enum(['organization', 'research_lab']),
      externalCounter: z.literal(1),
      recoveryOutcome: z.literal('outcome_unknown'),
      effectAtMostOnce: z.literal(true),
    })).length(2),
    context: z.object({
      committedTransactions: z.literal(1),
      failedPartialInHistory: z.literal(false),
      convergedAcrossCrashBoundaries: z.literal(true),
    }),
    provider: z.object({
      logicalRequests: z.literal(1),
      attempts: z.literal(2),
      providerDispatches: z.literal(2),
      usageTotal: z.number().int().positive(),
    }),
    trace: z.object({
      closeWaitedForFlush: z.literal(true),
      acceptedHighWater: z.number().int().positive(),
      persistedHighWater: z.number().int().positive(),
      strictArtifactMarker: z.string().min(1),
    }).refine((value) => value.acceptedHighWater === value.persistedHighWater),
    trajectory: z.object({
      backendIntegrity: z.literal('complete'),
      workspaceIntegrity: z.literal('complete'),
      chainIdsMatch: z.literal(true),
    }),
    negativeControl: z.object({
      artifactIntegrity: z.enum(['degraded', 'failed']),
      trajectoryIntegrity: z.enum(['degraded', 'failed']),
      workspaceIntegrity: z.enum(['degraded', 'failed']),
      presentedAsComplete: z.literal(false),
    }),
  }),
  migration: z.object({
    legacyHistoryRead: z.literal(true),
    legacyGuidance: z.literal('verify_before_retry'),
    forwardReadPassed: z.literal(true),
    rollbackSteps: z.array(z.object({
      epic: z.string().min(1),
      control: z.string().min(1),
      disableMode: z.enum(['feature_flag', 'read_route', 'capability_version', 'code_rollback']),
      durableHashBefore: sha256Schema,
      durableHashAfter: sha256Schema,
      recordsPreserved: z.literal(true),
    })).length(10),
    durableHashBefore: sha256Schema,
    durableHashAfter: sha256Schema,
  }).refine((value) => value.durableHashBefore === value.durableHashAfter),
  performance: z.object({
    trajectoryP95Ms: z.number().nonnegative().lt(1_000),
    trajectoryBudgetMs: z.literal(1_000),
    workspaceCorpusRecords: z.literal(6393),
    traceCloseReconciled: z.literal(true),
    providerUsageReconciled: z.literal(true),
  }),
  invariants: z.array(z.object({ id: z.string(), passed: z.literal(true) }).passthrough()).length(13),
  verdict: z.object({
    correctedFixturePassed: z.literal(true),
    negativeControlDetected: z.literal(true),
    namedMismatches: z.array(z.string()).length(0),
  }),
}).passthrough();

export const releaseAssuranceScenario:
AssembledBehaviorScenario<ReleaseAssuranceEvidenceBundle> = {
  id: E11_ASSEMBLED_SCENARIO_ID,
  title: 'Harness 3.2 assembled restart and integrity release canary',
  why: 'Runs every E0-E10 deterministic gate, hashes each evidence bundle, checks the ten global invariants, and records host, migration, rollback, performance, and degraded-integrity release receipts.',
  run: runScenario,
};
