import { describe, expect, it } from 'vitest';

import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import { groupMissionsByCanonicalPhase } from '@/domains/security-ops/runs/RunPhaseRepository';

const mission = (
  id: string,
  phase: MissionEnvelopeNode['phase'],
  assignedSkills: string[] = [],
): MissionEnvelopeNode => ({
  id,
  phase,
  question: `${phase} question`,
  whyReadyNow: 'The prior phase produced the prerequisite evidence.',
  requiredEvidence: ['durable evidence'],
  expectedArtifact: `${phase}-artifact`,
  stopCondition: 'Bounded work is complete.',
  assignedSkills,
});

describe('RunPhaseRepository canonical phase grouping', () => {
  it('keeps workflow-owned phase order even when planner missions are out of order', () => {
    const groups = groupMissionsByCanonicalPhase([
      mission('report', 'reporting', ['security-reporting']),
      mission('attack', 'exploitation', ['command-injection']),
      mission('validate', 'validation', ['validation']),
      mission('recon', 'recon', ['broad-surface-scan']),
      mission('evidence', 'evidence'),
      mission('enumerate-a', 'enumeration', ['command-injection']),
      mission('enumerate-b', 'enumeration', ['command-injection', 'validation']),
    ]);

    expect(groups.map((group) => group.phaseKey)).toEqual([
      'recon',
      'enumeration',
      'validation',
      'exploitation',
      'evidence',
      'reporting',
    ]);
    expect(groups[1]).toMatchObject({
      stepIds: ['enumerate-a', 'enumerate-b'],
      assignedSkillSlugs: ['command-injection', 'validation'],
    });
  });
});
