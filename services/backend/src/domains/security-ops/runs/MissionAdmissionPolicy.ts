import type { Message, MissionPhaseKey } from '@/domains/agent-brain/domain/types/session';
import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import type { RunWorkflowDiscipline } from '@/db/schema';
import {
  normalizePhaseKey,
  phaseProfileRegistry,
  type PhaseToolPolicyContext,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';

export const isPhaseReplanSubmission = (
  messages: readonly Message[] | undefined,
): boolean => {
  if (!messages) {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.metadata?.source === 'phase_replan_request';
    }
  }
  return false;
};

const buildAdmissionToolContext = (
  workflowDiscipline: RunWorkflowDiscipline | undefined,
): PhaseToolPolicyContext => ({
  workflowDiscipline,
  // Admission rejects only tools that the phase can never receive. Runtime
  // still applies the exact repository and compliance gates for the run.
  whiteboxEnabled: true,
  connectedRepoCount: 1,
  complianceReporting: workflowDiscipline === 'compliance',
});

const referencedKnownTools = (
  mission: Pick<MissionEnvelopeNode, 'expectedArtifact' | 'stopCondition'>,
): string[] => {
  const knownTools = new Set(phaseProfileRegistry.listKnownToolNames());
  const tokens = `${mission.expectedArtifact}\n${mission.stopCondition}`
    .match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu) ?? [];
  return Array.from(new Set(tokens.filter((token) => knownTools.has(token)))).sort();
};

export type MissionToolCapabilityFailure = {
  missionId: string;
  phase: MissionPhaseKey;
  unavailableTools: string[];
};

export const findMissionToolCapabilityFailures = (
  missions: readonly MissionEnvelopeNode[],
  workflowDiscipline?: RunWorkflowDiscipline,
): MissionToolCapabilityFailure[] => {
  const context = buildAdmissionToolContext(workflowDiscipline);
  const failures: MissionToolCapabilityFailure[] = [];
  for (const mission of missions) {
    const phase = normalizePhaseKey(mission.phase);
    if (!phase) {
      continue;
    }
    const unavailableTools = phaseProfileRegistry.missingRequiredTools(
      phase,
      referencedKnownTools(mission),
      context,
    );
    if (unavailableTools.length > 0) {
      failures.push({ missionId: mission.id, phase, unavailableTools });
    }
  }
  return failures;
};

export const findSkillToolCapabilityFailures = (
  phase: RunPhaseKey,
  requiredTools: readonly string[],
  workflowDiscipline?: RunWorkflowDiscipline,
): string[] => phaseProfileRegistry.missingRequiredTools(
  phase,
  requiredTools,
  buildAdmissionToolContext(workflowDiscipline),
);
