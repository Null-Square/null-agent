import type { MissionEnvelope, MissionPhaseKey } from '../types';
import { EnumerationMissionV1Schema } from './enumerationContracts';
import { AttackMissionV1Schema } from './attackContracts';

export type MissionEnvelopeNode = MissionEnvelope & { id: string };

export interface SkillMethodologyReadRecord {
  readAt?: string;
  byPlanStepId?: string;
  path?: string;
}

export interface StepTransitionBriefing {
  stepId: string;
  assignedSkills: string[];
  unreadSkills: string[];
  reusedSkills: string[];
  currentStepReadSkills: string[];
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const CANONICAL_PHASES: ReadonlySet<MissionPhaseKey> = new Set([
  'planning',
  'recon',
  'enumeration',
  'validation',
  'exploitation',
  'evidence',
  'control_assessment',
  'reporting',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
]);

const asMissionPhase = (value: unknown): MissionPhaseKey | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return CANONICAL_PHASES.has(normalized as MissionPhaseKey)
    ? normalized as MissionPhaseKey
    : undefined;
};

const getField = (
  record: Record<string, unknown>,
  snakeName: string,
  camelName: string,
): unknown => record[snakeName] ?? record[camelName];

export const normalizeMissionEnvelope = (value: unknown): MissionEnvelope | null => {
  if (!isRecord(value)) {
    return null;
  }

  const question = asText(value.question);
  const whyReadyNow = asText(getField(value, 'why_ready_now', 'whyReadyNow'));
  const requiredEvidence = asStringArray(getField(value, 'required_evidence', 'requiredEvidence'));
  const expectedArtifact = asText(getField(value, 'expected_artifact', 'expectedArtifact'));
  const stopCondition = asText(getField(value, 'stop_condition', 'stopCondition'));
  if (!question || !whyReadyNow || requiredEvidence.length === 0 || !expectedArtifact || !stopCondition) {
    return null;
  }

  const assignedSkills = asStringArray(getField(value, 'assigned_skills', 'assignedSkills'));
  const parallelSafeWith = asStringArray(getField(value, 'parallel_safe_with', 'parallelSafeWith'));
  const revalidatesFindingId = asText(getField(value, 'revalidates_finding_id', 'revalidatesFindingId'));
  const phase = asMissionPhase(getField(value, 'phase', 'phaseKey'));
  const rawEnumeration = value.enumeration;
  const enumeration = rawEnumeration === undefined
    ? undefined
    : EnumerationMissionV1Schema.safeParse(rawEnumeration);
  if (enumeration && !enumeration.success) {
    return null;
  }
  const rawAttack = value.attack;
  const attack = rawAttack === undefined
    ? undefined
    : AttackMissionV1Schema.safeParse(rawAttack);
  if (attack && !attack.success) {
    return null;
  }
  return {
    ...(phase ? { phase } : {}),
    question,
    whyReadyNow,
    requiredEvidence,
    expectedArtifact,
    stopCondition,
    ...(assignedSkills.length > 0 ? { assignedSkills } : {}),
    ...(parallelSafeWith.length > 0 ? { parallelSafeWith } : {}),
    ...(revalidatesFindingId ? { revalidatesFindingId } : {}),
    ...(enumeration?.success ? { enumeration: enumeration.data } : {}),
    ...(attack?.success ? { attack: attack.data } : {}),
  };
};

export const normalizeMissionEnvelopeNode = (value: unknown): MissionEnvelopeNode | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = asText(value.id);
  const mission = normalizeMissionEnvelope(value);
  return id && mission ? { id, ...mission } : null;
};

export const normalizeMissionEnvelopeNodes = (value: unknown): MissionEnvelopeNode[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeMissionEnvelopeNode)
    .filter((entry): entry is MissionEnvelopeNode => entry !== null);
};

export const serializeMissionEnvelopeNode = (node: MissionEnvelopeNode): Record<string, unknown> => ({
  id: node.id,
  ...(node.phase ? { phase: node.phase } : {}),
  question: node.question,
  why_ready_now: node.whyReadyNow,
  required_evidence: node.requiredEvidence,
  expected_artifact: node.expectedArtifact,
  stop_condition: node.stopCondition,
  ...(node.assignedSkills && node.assignedSkills.length > 0 ? { assigned_skills: node.assignedSkills } : {}),
  ...(node.parallelSafeWith && node.parallelSafeWith.length > 0 ? { parallel_safe_with: node.parallelSafeWith } : {}),
  ...(node.revalidatesFindingId ? { revalidates_finding_id: node.revalidatesFindingId } : {}),
  ...(node.enumeration ? { enumeration: node.enumeration } : {}),
  ...(node.attack ? { attack: node.attack } : {}),
});

export const renderMissionEnvelope = (mission: MissionEnvelope): string[] => [
  ...(mission.phase ? [`Phase: ${mission.phase}`] : []),
  `Question: ${mission.question}`,
  `Why ready now: ${mission.whyReadyNow}`,
  `Required evidence: ${mission.requiredEvidence.join('; ')}`,
  `Expected artifact: ${mission.expectedArtifact}`,
  `Stop condition: ${mission.stopCondition}`,
  ...(mission.assignedSkills && mission.assignedSkills.length > 0
    ? [`Assigned skills: ${mission.assignedSkills.join(', ')}`]
    : []),
  ...(mission.parallelSafeWith && mission.parallelSafeWith.length > 0
    ? [`Parallel safe with: ${mission.parallelSafeWith.join(', ')}`]
    : []),
  ...(mission.revalidatesFindingId
    ? [`Revalidates finding: ${mission.revalidatesFindingId}`]
    : []),
  ...(mission.enumeration
    ? [
        `Enumeration mission: ${mission.enumeration.kind}/v${mission.enumeration.schemaVersion}`,
        `Enumeration target: ${mission.enumeration.targetRef}`,
        `Enumeration surface: ${mission.enumeration.surface.kind} (${mission.enumeration.surface.refs.join(', ')})`,
        `Enumeration techniques: ${mission.enumeration.techniqueIds.join(', ')}`,
        `Enumeration primary skill: ${mission.enumeration.primarySkill.slug}@${mission.enumeration.primarySkill.versionHash}`,
        `Enumeration fingerprint: ${mission.enumeration.missionFingerprint}`,
      ]
    : []),
  ...(mission.attack
    ? [
        `Attack mission: ${mission.attack.kind}/v${mission.attack.schemaVersion}`,
        `Attack objective: ${mission.attack.objectiveFamily} — ${mission.attack.objective}`,
        `Attack target: ${mission.attack.targetRef}`,
        ...(mission.attack.boundedPaths && mission.attack.boundedPaths.length > 0
          ? [`Attack bounded paths: ${mission.attack.boundedPaths.join(', ')}`]
          : []),
        `Validated findings: ${mission.attack.validatedFindingIds.join(', ')}`,
        `Allowed impact: ${mission.attack.allowedImpact.join(', ')}`,
        `Required proof: ${mission.attack.requiredProof.join('; ')}`,
        `Cleanup plan: ${mission.attack.cleanupPlan.join('; ')}`,
        `Attack budgets: ${mission.attack.toolBudget} tools, ${mission.attack.requestBudget} target requests, ${mission.attack.timeBudgetSeconds}s`,
      ]
    : []),
];

const normalizeSkillSlug = (skill: string): string => skill.trim().toLowerCase();

const uniqueSkillSlugs = (skills: readonly string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const skill of skills ?? []) {
    const normalized = normalizeSkillSlug(skill);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const buildStepTransitionBriefing = (params: {
  stepId: string;
  mission: MissionEnvelope;
  methodologyReads?: Record<string, SkillMethodologyReadRecord>;
}): StepTransitionBriefing | null => {
  const assignedSkills = uniqueSkillSlugs(params.mission.assignedSkills);
  if (assignedSkills.length === 0) {
    return null;
  }

  const methodologyReads = params.methodologyReads ?? {};
  const unreadSkills: string[] = [];
  const reusedSkills: string[] = [];
  const currentStepReadSkills: string[] = [];

  for (const skill of assignedSkills) {
    const read = methodologyReads[skill];
    if (!read) {
      unreadSkills.push(skill);
    } else if (read.byPlanStepId === params.stepId) {
      currentStepReadSkills.push(skill);
    } else {
      reusedSkills.push(skill);
    }
  }

  const lines = [
    `[Step transition: ${params.stepId} is now running]`,
    `Mission: ${params.mission.question}`,
    `Expected artifact: ${params.mission.expectedArtifact}`,
    `Stop condition: ${params.mission.stopCondition}`,
    `Assigned skills for this task: ${assignedSkills.join(', ')}`,
    '',
  ];

  if (unreadSkills.length > 0) {
    lines.push('Read these task methodologies before the first non-read tool call for this task:');
    for (const skill of unreadSkills) {
      lines.push(`- ${skill}: /workspace/.skills/${skill}/methodology.md`);
    }
  }

  if (reusedSkills.length > 0) {
    if (unreadSkills.length > 0) {
      lines.push('');
    }
    lines.push('Already read earlier this run; refresh only if this task uses different techniques:');
    for (const skill of reusedSkills) {
      const read = methodologyReads[skill];
      const priorStep = read?.byPlanStepId ? ` during ${read.byPlanStepId}` : '';
      lines.push(`- ${skill}${priorStep}`);
    }
  }

  if (currentStepReadSkills.length > 0 && unreadSkills.length === 0 && reusedSkills.length === 0) {
    lines.push('All assigned methodologies for this task have already been read.');
  }

  return {
    stepId: params.stepId,
    assignedSkills,
    unreadSkills,
    reusedSkills,
    currentStepReadSkills,
    message: lines.join('\n'),
  };
};
