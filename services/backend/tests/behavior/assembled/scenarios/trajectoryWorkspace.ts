import { z } from 'zod';

import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';
import {
  E9_ASSEMBLED_SCENARIO_ID,
  runTrajectoryReadModelScenario,
} from './runTrajectoryReadModel';

export const E10_ASSEMBLED_SCENARIO_ID =
  'harness-trajectory-explains-retry-compaction-tool-chain';

export type TrajectoryWorkspaceEvidenceBundle = {
  schema: 'behavior-lab-trajectory-workspace-evidence/v1';
  scenarioId: typeof E10_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  sourceScenarioId: typeof E9_ASSEMBLED_SCENARIO_ID;
  behavior: {
    neutralTaskCompleted: boolean;
    integrityStatus: string;
    chainRecordIds: string[];
    contextSourceRequestRecordId?: string;
    artifactRef?: string;
    artifactHydration: string;
    filteredIdsRemainStable: boolean;
  };
  negativeControl: {
    integrityStatus: string;
    missingParentIssues: number;
    siblingOrder: string[];
    timestampsAreCausal: boolean;
  };
  uiGates: {
    contract: 'adminpanel-component-gate/v1';
    recordCorpus: 6393;
    typedArtifactRendererRequired: true;
    missingArtifactMustNotBeSynthesized: true;
  };
  assertions: VerificationAssertion[];
  verdict: {
    correctedFixturePassed: boolean;
    negativeControlDetected: boolean;
    namedMismatches: string[];
  };
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
  authoritativeSource: 'E9 production run-trajectory/v1 projection',
  detail,
});

const runScenario = async (): Promise<AssembledScenarioResult<TrajectoryWorkspaceEvidenceBundle>> => {
  const source = await runTrajectoryReadModelScenario.run();
  const evidence = source.evidence;
  const expectedChainIds = [
    'request:e9-request-main',
    'retry:e9-attempt-1',
    'retry:e9-attempt-2',
    'response:e9-response',
    'tool:e9-tool-record:invoke',
    'tool:e9-tool-record:result',
  ];
  const filteredIdsRemainStable = evidence.filters.executorRecordIds.every((recordId) =>
    evidence.filters.runRecordIds.includes(recordId));
  const assertions = [
    assertion(
      'behavior.neutral_task_completes_with_complete_e9_chain',
      source.passed && evidence.projection.integrity.status === 'complete',
      { sourcePassed: true, integrityStatus: 'complete' },
      { sourcePassed: source.passed, integrityStatus: evidence.projection.integrity.status },
      'The workspace scenario starts from the same completed neutral planner/executor/worker fixture as E9.',
    ),
    assertion(
      'workspace.request_retry_response_tool_result_chain_is_followable',
      evidence.chain.map((record) => record.id).join(',') === expectedChainIds.join(','),
      expectedChainIds,
      evidence.chain.map((record) => record.id),
      'Every inspector hop is backed by a stable E9 record identity and explicit parent relation.',
    ),
    assertion(
      'workspace.compaction_preserves_source_reference',
      evidence.context.sourceRequestRecordId === 'request:e9-request-source',
      'request:e9-request-source',
      evidence.context.sourceRequestRecordId,
      'The context inspector can follow the authoritative request that triggered the transformation.',
    ),
    assertion(
      'workspace.artifact_detail_is_strictly_hydrated',
      evidence.artifact.hydration === 'strict' && evidence.artifact.hydrated,
      { hydration: 'strict', hydrated: true },
      evidence.artifact,
      'The tool inspector receives verified artifact detail rather than substituting inline ledger data.',
    ),
    assertion(
      'workspace.session_filter_preserves_record_identity',
      filteredIdsRemainStable
        && evidence.filters.duplicateRunIds.length === 0
        && evidence.filters.duplicateSessionIds.length === 0,
      { stable: true, runDuplicates: [], sessionDuplicates: [] },
      {
        stable: filteredIdsRemainStable,
        runDuplicates: evidence.filters.duplicateRunIds,
        sessionDuplicates: evidence.filters.duplicateSessionIds,
      },
      'Run and session modes are filters over one projection, so copied record links do not change identity.',
    ),
    assertion(
      'negative.degraded_chain_keeps_ambiguous_sibling_order_explicit',
      evidence.negativeControl.integrityStatus !== 'complete'
        && evidence.negativeControl.missingParentIssues === 1
        && evidence.concurrentSiblings.siblingOrder.every((order) => order === 'unordered')
        && evidence.concurrentSiblings.timestampsAreCausal === false,
      {
        integrityStatus: 'not complete',
        missingParentIssues: 1,
        siblingOrder: ['unordered', 'unordered'],
        timestampsAreCausal: false,
      },
      {
        ...evidence.negativeControl,
        siblingOrder: evidence.concurrentSiblings.siblingOrder,
      },
      'The negative fixture stays visibly incomplete and supplies no timestamp-derived replacement edge.',
    ),
  ];
  const namedMismatches = assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
  const bundle: TrajectoryWorkspaceEvidenceBundle = {
    schema: 'behavior-lab-trajectory-workspace-evidence/v1',
    scenarioId: E10_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    sourceScenarioId: E9_ASSEMBLED_SCENARIO_ID,
    behavior: {
      neutralTaskCompleted: source.passed,
      integrityStatus: evidence.projection.integrity.status,
      chainRecordIds: evidence.chain.map((record) => record.id),
      contextSourceRequestRecordId: evidence.context.sourceRequestRecordId,
      artifactRef: evidence.artifact.artifactRef,
      artifactHydration: evidence.artifact.hydration,
      filteredIdsRemainStable,
    },
    negativeControl: {
      integrityStatus: evidence.negativeControl.integrityStatus,
      missingParentIssues: evidence.negativeControl.missingParentIssues,
      siblingOrder: evidence.concurrentSiblings.siblingOrder,
      timestampsAreCausal: evidence.concurrentSiblings.timestampsAreCausal,
    },
    uiGates: {
      contract: 'adminpanel-component-gate/v1',
      recordCorpus: 6393,
      typedArtifactRendererRequired: true,
      missingArtifactMustNotBeSynthesized: true,
    },
    assertions,
    verdict: {
      correctedFixturePassed: assertions.slice(0, -1).every((entry) => entry.passed),
      negativeControlDetected: assertions.at(-1)?.passed === true,
      namedMismatches,
    },
  };
  const schemaResult = trajectoryWorkspaceEvidenceSchema.safeParse(bundle);
  const passed = assertions.every((entry) => entry.passed) && schemaResult.success;
  return {
    id: E10_ASSEMBLED_SCENARIO_ID,
    title: 'Operator trajectory explains retry, compaction, and tool chain',
    mode: 'assembled-runtime',
    passed,
    evidence: bundle,
    ...(!passed ? {
      error: `failed=${namedMismatches.join(',')}${schemaResult.success ? '' : `; schema=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const trajectoryWorkspaceEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-trajectory-workspace-evidence/v1'),
  scenarioId: z.literal(E10_ASSEMBLED_SCENARIO_ID),
  sourceScenarioId: z.literal(E9_ASSEMBLED_SCENARIO_ID),
  behavior: z.object({
    neutralTaskCompleted: z.literal(true),
    integrityStatus: z.literal('complete'),
    chainRecordIds: z.tuple([
      z.literal('request:e9-request-main'),
      z.literal('retry:e9-attempt-1'),
      z.literal('retry:e9-attempt-2'),
      z.literal('response:e9-response'),
      z.literal('tool:e9-tool-record:invoke'),
      z.literal('tool:e9-tool-record:result'),
    ]),
    contextSourceRequestRecordId: z.literal('request:e9-request-source'),
    artifactRef: z.literal('artifacts/e9-tool-call.json.gz'),
    artifactHydration: z.literal('strict'),
    filteredIdsRemainStable: z.literal(true),
  }),
  negativeControl: z.object({
    integrityStatus: z.literal('failed'),
    missingParentIssues: z.literal(1),
    siblingOrder: z.tuple([z.literal('unordered'), z.literal('unordered')]),
    timestampsAreCausal: z.literal(false),
  }),
  uiGates: z.object({
    contract: z.literal('adminpanel-component-gate/v1'),
    recordCorpus: z.literal(6393),
    typedArtifactRendererRequired: z.literal(true),
    missingArtifactMustNotBeSynthesized: z.literal(true),
  }),
  assertions: z.array(z.object({ id: z.string(), passed: z.literal(true) }).passthrough()).length(6),
  verdict: z.object({
    correctedFixturePassed: z.literal(true),
    negativeControlDetected: z.literal(true),
    namedMismatches: z.array(z.string()).length(0),
  }),
}).passthrough();

export const trajectoryWorkspaceScenario:
AssembledBehaviorScenario<TrajectoryWorkspaceEvidenceBundle> = {
  id: E10_ASSEMBLED_SCENARIO_ID,
  title: 'Operator trajectory explains retry, compaction, and tool chain',
  why: 'Reuses the neutral E9 production projection to prove the linked chain, strict artifact detail, stable filtering, and degraded partial-order inputs consumed by the E10 workspace.',
  run: runScenario,
};
