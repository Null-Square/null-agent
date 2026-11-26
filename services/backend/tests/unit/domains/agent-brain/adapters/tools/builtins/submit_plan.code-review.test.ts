import { describe, expect, it } from 'vitest';

import {
  bindCodeReviewMissionRouting,
  validateCodeReviewMissionEnvelope,
  validatePentestMissionEnvelope,
} from '@/domains/agent-brain/adapters/tools/builtins/submit_plan';
import type { MissionPhaseKey } from '@/domains/agent-brain/domain/types';

const mission = (id: string, phase: MissionPhaseKey, assignedSkills: string[] = []) => ({
  id,
  phase,
  question: `Is ${id} complete?`,
  why_ready_now: 'The immutable Code Review context is available.',
  required_evidence: ['Revision-bound artifact'],
  expected_artifact: `${id}.json`,
  stop_condition: 'The bounded phase objective is complete or blocked.',
  assigned_skills: assignedSkills,
});

const codeReviewSkillSlugs = [
  'code-review-mapping',
  'code-review-analysis',
  'code-review-validation',
  'code-review-reporting',
];

const codeReviewMissions = () => [
  mission('map', 'review_mapping', ['code-review-mapping']),
  mission('analyze', 'review_analysis', ['code-review-analysis']),
  mission('validate', 'review_validation', ['code-review-validation']),
  mission('report', 'review_reporting', ['code-review-reporting']),
];

describe('Code Review submit_plan contract', () => {
  it('accepts only the four ordered Code Review phases', () => {
    const result = validateCodeReviewMissionEnvelope({
      plan: '# Review\n\n- Map\n- Analyze\n- Validate\n- Report',
      skillSlugs: codeReviewSkillSlugs,
      missions: codeReviewMissions(),
    });

    expect(result).not.toHaveProperty('error');
  });

  it('binds fixed phase skills when the planner omits routing metadata', () => {
    const bound = bindCodeReviewMissionRouting({
      plan: '# Review',
      missions: [
        mission('map', 'review_mapping'),
        mission('analyze', 'review_analysis'),
        mission('validate', 'review_validation'),
        mission('report', 'review_reporting'),
      ],
    });

    expect(bound.skillSlugs).toEqual(codeReviewSkillSlugs);
    expect(bound.missions?.map((item) => item.assigned_skills)).toEqual([
      ['code-review-mapping'],
      ['code-review-analysis'],
      ['code-review-validation'],
      ['code-review-reporting'],
    ]);
    expect(validateCodeReviewMissionEnvelope(bound)).not.toHaveProperty('error');
  });

  it('replaces model-supplied cross-product skills with canonical Code Review routing', () => {
    const bound = bindCodeReviewMissionRouting({
      plan: '# Review',
      skillSlugs: ['security-reporting'],
      missions: [
        mission('map', 'review_mapping', ['security-reporting']),
        ...codeReviewMissions().slice(1),
      ],
    });

    expect(bound.skillSlugs).toEqual(codeReviewSkillSlugs);
    expect(bound.missions?.[0]?.assigned_skills).toEqual(['code-review-mapping']);
    expect(validateCodeReviewMissionEnvelope(bound)).not.toHaveProperty('error');
  });

  it('still rejects Pentest or Compliance phases', () => {
    expect(
      validateCodeReviewMissionEnvelope(bindCodeReviewMissionRouting({
        plan: '# Review',
        skillSlugs: codeReviewSkillSlugs,
        missions: [
          mission('map', 'recon', ['code-review-mapping']),
          ...codeReviewMissions().slice(1),
        ],
      })),
    ).toEqual(expect.objectContaining({
      error: expect.stringContaining('Pentest and Compliance phases cannot be mixed'),
    }));
  });
});

describe('Pentest submit_plan product boundary', () => {
  const reportingMission = {
    ...mission('report', 'reporting'),
    assigned_skills: ['security-reporting'],
  };

  it('rejects Code Review and Compliance phases instead of mixing products', () => {
    for (const foreignMission of [
      mission('review', 'review_analysis'),
      mission('controls', 'control_assessment'),
    ]) {
      const result = validatePentestMissionEnvelope(undefined as never, {
        plan: '# Pentest',
        skillSlugs: ['security-reporting'],
        missions: [foreignMission, reportingMission],
      });

      expect(result).toEqual(expect.objectContaining({
        error: expect.stringContaining('require their own explicit workflow discipline'),
      }));
    }
  });
});
