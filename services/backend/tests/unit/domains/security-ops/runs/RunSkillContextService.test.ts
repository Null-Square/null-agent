import { describe, expect, it, vi } from 'vitest';

import {
  RunSkillContextService,
  type SkillMetadata,
} from '@/domains/security-ops/runs/RunSkillContextService';

const makeMetadata = (overrides: Partial<SkillMetadata> = {}): SkillMetadata => ({
  slug: 'sql-injection',
  name: 'SQL Injection Testing',
  description: 'Skill playbook for SQL Injection Testing',
  phase: 'validation',
  compatiblePhases: ['validation'],
  category: 'vulnerability',
  requiredTools: ['file_read'],
  toolAlternatives: [],
  riskTier: 'standard',
  freshScopePriority: undefined,
  useWhen: '',
  notWhen: 'Do not use without a SQL boundary',
  requiredInputs: [],
  expectedOutputs: [],
  evidenceFloor: 'Deterministic SQL impact',
  strongTerms: [],
  followUpTriggers: [],
  techTriggers: ['mysql'],
  ntypeTriggers: ['http.parameters'],
  techniqueIds: ['B1:sql-injection'],
  sourceModes: ['blackbox'],
  relatedSkills: [],
  handoffSkills: ['validation'],
  mutationApplicability: 'applicable',
  supportingFiles: ['methodology.md', 'mutation-algebra.md', 'examples.md'],
  fixtureManifest: 'fixtures/manifest.yaml',
  versionHash: 'a'.repeat(64),
  enabled: true,
  ownerCategory: 'test',
  deliveryScope: 'existing',
  releaseTrack: 'b1',
  catalogVersion: 'test',
  localPath: '/workspace/.skills/sql-injection',
  ...overrides,
});

describe('RunSkillContextService', () => {
  it('builds executor assigned-skills context with description, use-when, and path', async () => {
    const sql = makeMetadata();
    const xss = makeMetadata({
      slug: 'xss',
      name: 'XSS Testing',
      description: 'Cross-site scripting testing methodology',
      localPath: '/workspace/.skills/xss',
    });
    const loader = {
      loadSkillCatalog: vi.fn().mockResolvedValue([sql, xss]),
    };

    const service = new RunSkillContextService({
      skillLoader: loader as never,
    });

    const context = await service.buildAssignedSkillsContext(
      'org-1',
      'scope-1',
      ['SQL-INJECTION', 'xss', 'xss'],
    );
    expect(context).toContain('=== ASSIGNED METHODOLOGIES ===');
    // Description + use-when give the executor a reason to open the methodology;
    // a bare path alone was ignored in traced runs.
    expect(context).toContain('- sql-injection: Skill playbook for SQL Injection Testing');
    expect(context).toContain('- xss: Cross-site scripting testing methodology');
    expect(context).toContain('  Use when:');
    expect(context).toContain('  Methodology path: /workspace/.skills/sql-injection/methodology.md');
    expect(context.indexOf('- sql-injection')).toBeLessThan(context.indexOf('- xss'));
  });

  it('uses the canonical workspace path for unknown assigned skills', async () => {
    const loader = {
      loadSkillCatalog: vi.fn().mockResolvedValue([]),
    };

    const service = new RunSkillContextService({
      skillLoader: loader as never,
    });

    const context = await service.buildAssignedSkillsContext('org-1', 'scope-1', ['custom-skill']);
    expect(context).toContain('- custom-skill: Assigned by the planner.');
    expect(context).toContain('  Methodology path: /workspace/.skills/custom-skill/methodology.md');
  });

  it('returns empty assigned context when no skills are assigned', async () => {
    const loader = {
      loadSkillCatalog: vi.fn().mockResolvedValue([]),
    };

    const service = new RunSkillContextService({
      skillLoader: loader as never,
    });

    const context = await service.buildAssignedSkillsContext('org-1', 'scope-1', []);
    expect(context).toBe('');
  });

  it('builds a compact phase-compatible catalog with assigned skills first', async () => {
    const assigned = makeMetadata();
    const other = makeMetadata({
      slug: 'access-control',
      name: 'Access Control Testing',
      description: 'Function-level authorization testing methodology',
      useWhen: 'Endpoints expose object or function references.',
      localPath: '/workspace/.skills/access-control',
    });
    const planningOnly = makeMetadata({
      slug: 'securityops-planning',
      phase: 'planning',
      localPath: '/workspace/.skills/securityops-planning',
    });
    const loader = {
      loadSkillCatalog: vi.fn().mockResolvedValue([other, planningOnly, assigned]),
    };

    const service = new RunSkillContextService({
      skillLoader: loader as never,
    });

    const context = await service.buildPhaseCompatibleSkillCatalogContext(
      'org-1',
      'scope-1',
      'validation',
      ['sql-injection'],
    );
    expect(context).toContain('=== PHASE-COMPATIBLE WORKER SKILLS ===');
    expect(context).toContain('Phase: validation');
    expect(context).toContain('- sql-injection (assigned):');
    expect(context).toContain(
      '- access-control (phase-compatible): Function-level authorization testing methodology',
    );
    expect(context).toContain('Use when: Endpoints expose object or function references.');
    // Planning-only skills never appear in an execution-phase catalog.
    expect(context).not.toContain('securityops-planning');
    // Assigned skills sort ahead of merely compatible ones.
    expect(context.indexOf('sql-injection (assigned)')).toBeLessThan(
      context.indexOf('access-control (phase-compatible)'),
    );
  });

  it('returns an empty catalog when nothing is phase-compatible', async () => {
    const loader = {
      loadSkillCatalog: vi.fn().mockResolvedValue([
        makeMetadata({ slug: 'securityops-planning', phase: 'planning' }),
      ]),
    };

    const service = new RunSkillContextService({
      skillLoader: loader as never,
    });

    const context = await service.buildPhaseCompatibleSkillCatalogContext(
      'org-1',
      'scope-1',
      'validation',
      [],
    );
    expect(context).toBe('');
  });
});
