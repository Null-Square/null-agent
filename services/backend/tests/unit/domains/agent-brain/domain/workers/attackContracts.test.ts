import { describe, expect, it } from 'vitest';

import {
  AttackMissionV1Schema,
  AttackResultV1Schema,
} from '@/domains/agent-brain/domain/workers/attackContracts';
import { renderMissionEnvelope } from '@/domains/agent-brain/domain/workers/missionEnvelope';

const mission = {
  schemaVersion: 1,
  kind: 'controlled_exploitation_v1',
  objectiveFamily: 'demonstrate_command_execution',
  objective: 'Create, read, and remove one harmless marker.',
  validatedFindingIds: ['finding-1'],
  targetRef: 'https://staging.example.test',
  boundedPaths: ['/vulnerable'],
  allowedImpact: ['create_marker', 'delete_marker'],
  requestBudget: 60,
  toolBudget: 30,
  timeBudgetSeconds: 600,
  maxRequestConcurrency: 1,
  requiredProof: ['marker_created', 'marker_read', 'marker_removed'],
  stopConditions: ['proof_complete', 'policy_denied'],
  cleanupPlan: ['remove_marker', 'prove_absent'],
} as const;

describe('attack_mission/v1 and attack_result/v1', () => {
  it('accepts a bounded controlled exploitation mission', () => {
    expect(AttackMissionV1Schema.parse(mission)).toMatchObject({
      kind: 'controlled_exploitation_v1',
      requestBudget: 60,
      toolBudget: 30,
    });
  });

  it('rejects budget widening and more than three finding bindings', () => {
    expect(AttackMissionV1Schema.safeParse({
      ...mission,
      requestBudget: 101,
      validatedFindingIds: ['1', '2', '3', '4'],
    }).success).toBe(false);
  });

  it('renders bounded attack constraints into the worker mission briefing', () => {
    const rendered = renderMissionEnvelope({
      phase: 'exploitation',
      question: 'Use the admitted objective only.',
      whyReadyNow: 'The finding is validated and full-impact RoE is explicit.',
      requiredEvidence: ['marker proof'],
      expectedArtifact: 'attack_result/v1',
      stopCondition: 'Stop after proof and cleanup.',
      attack: AttackMissionV1Schema.parse(mission),
    }).join('\n');

    expect(rendered).toContain('Attack bounded paths: /vulnerable');
    expect(rendered).toContain('Allowed impact: create_marker, delete_marker');
    expect(rendered).toContain('Required proof: marker_created; marker_read; marker_removed');
    expect(rendered).toContain('Cleanup plan: remove_marker; prove_absent');
  });

  it('requires evidence for demonstrated impact and remaining risk for failed cleanup', () => {
    const baseResult = {
      schemaVersion: 1,
      missionId: 'task-1',
      validatedFindingIds: ['finding-1'],
      targetRef: mission.targetRef,
      objectiveFamily: mission.objectiveFamily,
      status: 'impact_demonstrated',
      attempts: [],
      proofClaim: 'The marker was created and observed.',
      evidenceIds: [],
      changedStateSummary: 'Created one marker.',
      cleanup: {
        required: true,
        status: 'failed',
        actions: ['attempted marker removal'],
        evidenceIds: [],
        remainingRisk: null,
      },
      limitations: [],
      policySnapshot: {
        featureEnabled: true,
        organizationAllowlisted: true,
        runTrigger: 'manual',
        workflowDiscipline: 'pentest',
        impactTolerance: 'full',
        phaseKey: 'exploitation',
        verifiedTarget: true,
        requestBudget: 60,
        toolBudget: 30,
        timeBudgetSeconds: 600,
        capturedAt: '2026-07-25T00:00:00.000Z',
      },
    };
    expect(AttackResultV1Schema.safeParse(baseResult).success).toBe(false);
    expect(AttackResultV1Schema.safeParse({
      ...baseResult,
      status: 'cleanup_failed',
      evidenceIds: ['/workspace/.artifacts/proof.txt'],
      cleanup: {
        ...baseResult.cleanup,
        remainingRisk: 'Marker removal could not be confirmed.',
      },
    }).success).toBe(true);
  });
});
