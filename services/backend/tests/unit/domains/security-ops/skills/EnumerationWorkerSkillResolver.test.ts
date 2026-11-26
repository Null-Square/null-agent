import { describe, expect, it, vi } from 'vitest';

import type { EnumerationMissionV1 } from '@/domains/agent-brain/domain/types';
import { SkillLoader, type LoadedSkill } from '@/domains/security-ops/skills/SkillLoader';
import { EnumerationWorkerSkillResolver } from '@/domains/security-ops/skills/EnumerationWorkerSkillResolver';

type ResolveParams = Parameters<EnumerationWorkerSkillResolver['resolve']>[0];

const withIsolatedCandidate = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = process.env.NULL_EVAL_ISOLATED_RUNNER;
  process.env.NULL_EVAL_ISOLATED_RUNNER = '1';
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.NULL_EVAL_ISOLATED_RUNNER;
    } else {
      process.env.NULL_EVAL_ISOLATED_RUNNER = previous;
    }
  }
};

const withoutIsolatedCandidate = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = process.env.NULL_EVAL_ISOLATED_RUNNER;
  delete process.env.NULL_EVAL_ISOLATED_RUNNER;
  try {
    return await operation();
  } finally {
    if (previous !== undefined) process.env.NULL_EVAL_ISOLATED_RUNNER = previous;
  }
};

const resolveCurrentCandidate = async (
  resolver: EnumerationWorkerSkillResolver,
  params: Omit<ResolveParams, 'catalogAdmission'>,
) => {
  const report = await resolver.buildEligibilityReport();
  return withIsolatedCandidate(() => resolver.resolve({
    ...params,
    catalogAdmission: {
      kind: 'evaluation_candidate',
      expectedCatalogDigest: report.catalogDigest,
    },
  }));
};

const buildMission = (
  primary: LoadedSkill,
  supporting: LoadedSkill[] = [],
  overrides: Partial<EnumerationMissionV1> = {},
): EnumerationMissionV1 => ({
  schemaVersion: 1,
  kind: 'enumeration_hunt_v1',
  phaseAttemptId: 'phase-attempt-1',
  targetRef: 'https://app.example.com',
  surface: { kind: 'path_prefix_set', refs: ['/api'] },
  techniqueIds: [primary.techniqueIds[0]!],
  primarySkill: { slug: primary.slug, versionHash: primary.versionHash },
  supportingSkills: supporting.map((skill) => ({
    slug: skill.slug,
    versionHash: skill.versionHash,
  })),
  personaRefs: [],
  sourceMode: 'blackbox',
  impactCeiling: 'non_destructive',
  budgets: {
    maxToolCalls: 22,
    maxTargetRequests: 40,
    maxRequestConcurrency: 2,
    maxWallSeconds: 360,
    maxArtifactFiles: 15,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxLeads: 5,
    maxStateChanges: 0,
  },
  stop: {
    whenTechniquesExhausted: true,
    whenBlockedByPolicy: true,
    maxHighConfidenceLeads: 5,
  },
  missionFingerprint: '0'.repeat(64),
  ...overrides,
});

describe('EnumerationWorkerSkillResolver', () => {
  it('accepts the live catalog on the platform path without a frozen digest', async () => {
    const resolver = new EnumerationWorkerSkillResolver();
    const report = await resolver.buildEligibilityReport();
    // Every slug is classified into exactly one bucket.
    expect(
      report.counts.primaryEligible + report.counts.supportingEligible + report.counts.excluded,
    ).toBe(report.counts.total);
    expect(new Set(report.entries.map((entry) => entry.slug)).size).toBe(report.counts.total);
    // The platform path no longer freezes the catalog to one accepted digest,
    // so restoring methodology depth cannot turn into a worker start failure.
    await expect(resolver.assertAcceptedCatalog()).resolves.toMatchObject({
      catalogDigest: report.catalogDigest,
    });
  });

  it('admits only the exact candidate digest inside the isolated evaluation runner', async () => {
    const resolver = new EnumerationWorkerSkillResolver();
    const report = await resolver.buildEligibilityReport();
    const admission = {
      kind: 'evaluation_candidate' as const,
      expectedCatalogDigest: report.catalogDigest,
    };

    await expect(
      withIsolatedCandidate(() => resolver.assertCatalogAdmission(admission)),
    ).resolves.toMatchObject({ catalogDigest: report.catalogDigest });
    await expect(
      withIsolatedCandidate(() => resolver.assertCatalogAdmission({
        ...admission,
        expectedCatalogDigest: '0'.repeat(64),
      })),
    ).rejects.toThrow(/evaluation_candidate_digest_mismatch/u);
    await expect(withoutIsolatedCandidate(() => resolver.assertCatalogAdmission(admission)))
      .rejects.toThrow(/evaluation_candidate_isolation_required/u);
  });

  it('admits version-pinned standard primary and low-risk supporting skills', async () => {
    const loader = new SkillLoader();
    const primary = (await loader.loadSkillBySlug('access-control'))!;
    const supporting = (await loader.loadSkillBySlug('tooling-browser'))!;
    const resolver = new EnumerationWorkerSkillResolver(loader);
    const resolved = await resolveCurrentCandidate(resolver, {
      mission: buildMission(primary, [supporting]),
      executableTools: [
        'http_payload',
        'file_read',
        'browser_action',
        'submit_worker_result',
      ],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'non_destructive',
    });
    expect(resolved.primary.slug).toBe('access-control');
    expect(resolved.supporting.map((skill) => skill.slug)).toEqual(['tooling-browser']);
  });

  it('enforces source-mode and execution-tool availability', async () => {
    const loader = new SkillLoader();
    const primary = (await loader.loadSkillBySlug('access-control'))!;
    const resolver = new EnumerationWorkerSkillResolver(loader);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(primary),
      executableTools: ['http_payload', 'file_read', 'submit_worker_result'],
      runtimeSourceMode: 'whitebox',
      runImpactTolerance: 'non_destructive',
    })).rejects.toThrow(/source_mode_mismatch/u);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(primary),
      executableTools: ['file_read', 'submit_worker_result'],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'non_destructive',
    })).rejects.toThrow(/skill_tool_unavailable/u);
  });

  it('requires poc impact tolerance for sensitive skills', async () => {
    const loader = new SkillLoader();
    const primary = (await loader.loadSkillBySlug('ai-application-security'))!;
    const resolver = new EnumerationWorkerSkillResolver(loader);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(primary),
      executableTools: ['http_payload', 'file_read', 'submit_worker_result'],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'non_destructive',
    })).rejects.toThrow(/sensitive_skill_impact_denied/u);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(primary, [], { impactCeiling: 'poc' }),
      executableTools: ['http_payload', 'file_read', 'submit_worker_result'],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'poc',
    })).resolves.toMatchObject({ primary: { slug: 'ai-application-security' } });
  });

  it('rejects excluded and explicitly OOB-dependent skills', async () => {
    const loader = new SkillLoader();
    const primary = (await loader.loadSkillBySlug('access-control'))!;
    const excluded = (await loader.loadSkillBySlug('validation'))!;
    const interactsh = (await loader.loadSkillBySlug('tooling-interactsh'))!;
    const resolver = new EnumerationWorkerSkillResolver(loader);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(excluded),
      executableTools: ['submit_worker_result'],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'non_destructive',
    })).rejects.toThrow(/primary_skill_ineligible/u);
    await expect(resolveCurrentCandidate(resolver, {
      mission: buildMission(primary, [interactsh]),
      executableTools: [
        'http_payload',
        'file_read',
        'shell_run',
        'wait_for_shell_job',
        'submit_worker_result',
      ],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'non_destructive',
    })).rejects.toThrow(/requires OOB execution/u);
  });

  it('fails closed for a restricted catalog entry', async () => {
    const base = (await new SkillLoader().loadSkillBySlug('access-control'))!;
    const restricted: LoadedSkill = {
      ...base,
      slug: 'restricted-test',
      riskTier: 'restricted',
      versionHash: 'f'.repeat(64),
    };
    const fakeLoader = {
      loadSkillBySlug: vi.fn(async (slug: string) =>
        slug === restricted.slug ? restricted : undefined),
    };
    const resolver = new EnumerationWorkerSkillResolver(fakeLoader as unknown as SkillLoader);
    vi.spyOn(resolver, 'assertCatalogAdmission').mockResolvedValue({
      schemaVersion: 1,
      reportKind: 'enumeration-worker-v1-eligibility',
      catalogVersion: '3.0.0-b1',
      catalogDigest: '0'.repeat(64),
      acceptedCatalogDigest: '0'.repeat(64),
      counts: { total: 102, primaryEligible: 73, supportingEligible: 20, excluded: 9 },
      entries: [],
    });
    await expect(resolver.resolve({
      mission: buildMission(restricted),
      executableTools: ['http_payload', 'file_read', 'submit_worker_result'],
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'full',
    })).rejects.toThrow(/restricted_skill_denied/u);
  });
});
