import { describe, expect, it } from 'vitest';

import type { SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';
import { rankSkillsForState } from '@/domains/security-ops/skills/SkillRanker';

const skill = (overrides: Partial<SkillMetadata> & { slug: string }): SkillMetadata => ({
  slug: overrides.slug,
  name: overrides.name ?? overrides.slug,
  description: overrides.description ?? `${overrides.slug} skill`,
  phase: overrides.phase ?? 'validation',
  compatiblePhases: overrides.compatiblePhases ?? [overrides.phase ?? 'validation'],
  category: overrides.category ?? 'vulnerability',
  requiredTools: overrides.requiredTools ?? ['file_read'],
  toolAlternatives: overrides.toolAlternatives ?? [],
  riskTier: overrides.riskTier ?? 'standard',
  useWhen: overrides.useWhen ?? `Use ${overrides.slug}`,
  notWhen: overrides.notWhen ?? `Do not use ${overrides.slug} when not applicable`,
  requiredInputs: [],
  expectedOutputs: [],
  evidenceFloor: overrides.evidenceFloor ?? 'Deterministic proof',
  strongTerms: overrides.strongTerms ?? [],
  followUpTriggers: [],
  techTriggers: overrides.techTriggers ?? [],
  ntypeTriggers: overrides.ntypeTriggers ?? [],
  techniqueIds: overrides.techniqueIds ?? [`B1:${overrides.slug}`],
  sourceModes: overrides.sourceModes ?? ['blackbox'],
  relatedSkills: overrides.relatedSkills ?? [],
  handoffSkills: overrides.handoffSkills ?? [],
  mutationApplicability: overrides.mutationApplicability ?? 'applicable',
  supportingFiles: [],
  fixtureManifest: overrides.fixtureManifest ?? 'fixtures/manifest.yaml',
  versionHash: overrides.versionHash ?? 'a'.repeat(64),
  enabled: overrides.enabled ?? true,
  ownerCategory: overrides.ownerCategory ?? 'test',
  deliveryScope: overrides.deliveryScope ?? 'existing',
  releaseTrack: overrides.releaseTrack ?? 'b1',
  catalogVersion: overrides.catalogVersion ?? 'test',
  localPath: `/workspace/.skills/${overrides.slug}`,
});

describe('SkillRanker', () => {
  it('ranks skills from tech and ntype triggers without assigning them', () => {
    const ranked = rankSkillsForState(
      [
        skill({ slug: 'api-enumeration', phase: 'enumeration', ntypeTriggers: ['http.endpoint'] }),
        skill({ slug: 'tooling-nuclei', phase: 'validation', techTriggers: ['nuclei'] }),
        skill({ slug: 'xss', phase: 'validation', techTriggers: ['react'] }),
      ],
      {
        phaseKey: 'validation',
        assignedSkillSlugs: ['api-enumeration'],
        text: [
          'report_note ntype=http.endpoint title=Login endpoint',
          'nuclei -jsonl found a template match',
        ].join('\n'),
      },
    );

    expect(ranked.map((entry) => entry.slug)).toEqual(['tooling-nuclei', 'api-enumeration']);
    expect(ranked[0]).toEqual(
      expect.objectContaining({
        slug: 'tooling-nuclei',
        assigned: false,
        matchedTechTriggers: ['nuclei'],
      }),
    );
    expect(ranked[1]).toEqual(
      expect.objectContaining({
        slug: 'api-enumeration',
        assigned: true,
        matchedNtypeTriggers: ['http.endpoint'],
      }),
    );
  });

  it('prioritizes strong-term matches and records the matched terms', () => {
    const ranked = rankSkillsForState(
      [
        skill({ slug: 'idor', strongTerms: ['user_id', 'account id'], ntypeTriggers: ['validation.lead'] }),
        skill({ slug: 'api-enumeration', ntypeTriggers: ['validation.lead'] }),
      ],
      {
        phaseKey: 'validation',
        text: 'validation.lead: test account id and user_id access control on /api/users/{user_id}',
      },
    );

    expect(ranked.map((entry) => entry.slug)).toEqual(['idor', 'api-enumeration']);
    expect(ranked[0]).toEqual(
      expect.objectContaining({
        slug: 'idor',
        matchedStrongTerms: ['user_id', 'account id'],
        reasons: expect.arrayContaining([expect.stringContaining('strong:user_id,account id')]),
      }),
    );
  });
});
