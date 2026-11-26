import { describe, expect, it } from 'vitest';

import { SetupSkillLoader } from '@/domains/security-ops/setup/SetupSkillLoader';

describe('SetupSkillLoader', () => {
  it('loads seeded setup skills from config', async () => {
    const loader = new SetupSkillLoader();

    const catalog = await loader.loadCatalog();

    expect(catalog.map((skill) => skill.slug)).toEqual(
      expect.arrayContaining([
        'interview-org-brief',
        'interview-roe',
        'engagement-readiness-check',
        'register-and-verify-targets',
        'configure-scheduled-scan',
        'capture-credentials',
        'draft-roe-from-document',
      ]),
    );
  });

  it('ranks target verification and automation requests to the right playbooks', async () => {
    const loader = new SetupSkillLoader();

    const targetMatches = await loader.rankRelevantSkills({
      text: 'What is the fastest way to verify my WordPress domain target?',
      gaps: ['verify_target'],
    });
    const automationMatches = await loader.rankRelevantSkills({
      text: 'Create a weekly scheduled automation for readiness review',
      gaps: ['create_automation'],
    });

    expect(targetMatches[0]?.slug).toBe('register-and-verify-targets');
    expect(automationMatches[0]?.slug).toBe('configure-scheduled-scan');
  });

  it('loads a setup skill playbook by slug', async () => {
    const loader = new SetupSkillLoader();

    const skill = await loader.loadBySlug('interview-roe');

    expect(skill).toMatchObject({
      slug: 'interview-roe',
      intent: 'change',
      produces: expect.arrayContaining(['scope.roeDocument']),
    });
    expect(skill?.content).toContain('Interview Rules of Engagement');
  });
});
