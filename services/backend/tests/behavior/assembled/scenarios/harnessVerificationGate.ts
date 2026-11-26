import { execFileSync } from 'node:child_process';

import {
  ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA,
  type AssembledBehaviorEvidenceBundle,
  type AssembledBehaviorScenario,
  type AssembledScenarioResult,
} from '../types';
import {
  E0_ARTIFACT_INLINE_LIMIT,
  E0_ASSEMBLED_SCENARIO_ID,
  E0_FAULT_POINT,
  E0_TOOL_CALL_ID,
  runAssembledFixture,
} from '../assembledRuntime';
import { assembledBehaviorEvidenceSchema } from '../evidenceSchema';
import { createTestRuntimeHostCapabilities } from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

const resolveCommit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
};

const run = async (): Promise<AssembledScenarioResult<AssembledBehaviorEvidenceBundle>> => {
  const corrected = await runAssembledFixture('corrected');
  const negativeControl = await runAssembledFixture('broken-authoritative-omission');
  const namedMismatches = negativeControl.assertions
    .filter((entry) => !entry.passed)
    .map((entry) => entry.id);
  const negativeControlDetected =
    negativeControl.legacyFirstToolAssertionPassed
    && !negativeControl.newGatePassed
    && namedMismatches.includes('authoritative.tool_execution_claim_survived_cold_restart')
    && namedMismatches.includes('external.neutral_effect_executed_once');
  const evidence = {
    schema: ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA,
    scenarioId: E0_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: resolveCommit(),
    claim: {
      text: 'A first-tool projection is verified only when the assembled runtime, authoritative persistence, hydrated artifacts, cold recovery, and neutral external state agree.',
      affectedRuntimeSurfaces: [
        'TurnToolExecutor.run',
        'ToolsRegistryAdapter.executeWithReceipt',
        'ToolsRegistry.executeResolvedTool',
        'TOOL_EXECUTION_PIPELINE_STAGES (claim before pre_hooks before start)',
        'ToolExecutionPort',
        'SessionTraceRecorder',
      ],
      terminalExpressions: [
        'toolExecutionLedger = hostedToolExecution?.lifecycle ?? this.toolExecutionDb',
        "requiresV2Lifecycle = (selectedToolExecutionCapability?.schemaVersion ?? 1) >= 2",
        'requiresV2Lifecycle && !supportsDurableToolExecutionLifecycle(ledger) -> RuntimeHostCapabilityRegistrationError',
        'toolCallId && toolExecutionLedger -> findByToolCallId, else atomic claim(), both before emitPreToolUse',
        "normalizeToolExecutionStatus: 'claimed' -> not_started/may_retry; 'started'|'outcome_unknown' -> outcome_unknown/verify_before_retry; 'succeeded' -> frozen cached result",
      ],
      authoritativeRecords: [
        'file-backed ToolExecutionPort record',
        'file-backed neutral external counter',
        'hydrated trace artifact payload',
      ],
      weakerProjections: [
        'provider first-tool call',
        'inline trace payload containing an artifact link',
      ],
    },
    configuration: {
      deterministicProvider: true,
      liveCanaryRequired: false,
      artifactInlineLimit: E0_ARTIFACT_INLINE_LIMIT,
      faultPoint: E0_FAULT_POINT,
      toolCallId: E0_TOOL_CALL_ID,
    },
    host: {
      kind: 'behavior_lab_assembled' as const,
      capabilities: createTestRuntimeHostCapabilities({
        ownerPrefix: 'DurableBehaviorStore+SessionTraceRecorder',
        durability: 'durable',
      }),
      factoryBindings: [
        'createStreamBroker',
        'SessionStore',
        'ToolsRegistry',
        'ToolsRegistryAdapter',
        'TurnToolExecutor',
        'SessionTraceRecorder',
      ],
    },
    fixtures: {
      corrected,
      negativeControl,
    },
    verdict: {
      correctedFixturePassed: corrected.newGatePassed,
      negativeControlDetected,
      legacyAssertionPassedOnBrokenFixture: negativeControl.legacyFirstToolAssertionPassed,
      namedMismatches,
    },
  };
  const schemaResult = assembledBehaviorEvidenceSchema.safeParse(evidence);
  const passed = corrected.newGatePassed && negativeControlDetected && schemaResult.success;

  return {
    id: E0_ASSEMBLED_SCENARIO_ID,
    title: 'Verification gate detects a hidden authoritative runtime failure',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `corrected=${corrected.newGatePassed}; negativeControlDetected=${negativeControlDetected}; schema=${schemaResult.success}; mismatches=${namedMismatches.join(',')}${schemaResult.success ? '' : `; schemaErrors=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const harnessVerificationGateScenario: AssembledBehaviorScenario<AssembledBehaviorEvidenceBundle> = {
  id: E0_ASSEMBLED_SCENARIO_ID,
  title: 'Verification gate detects a hidden authoritative runtime failure',
  why: 'Proves that a correct first-tool projection cannot hide a missing durable claim, duplicate external effect, or unhydrated trace artifact.',
  run,
};
