import { describe, expect, it, vi } from 'vitest';
import { RunService } from '@/domains/security-ops/runs/RunService';
import type { OrgContext } from '@/domains/security-ops/organization/OrganizationService';
import type { ScopeContext } from '@/domains/security-ops/scopes/ScopeService';

const ORG_CONTEXT: OrgContext = {
  name: 'Acme',
  context: 'Handles customer data',
};

const SCOPE_CONTEXT: ScopeContext = {
  name: 'Production',
  executionNetwork: 'external',
  attachedRunner: null,
      targets: [{ type: 'domain', value: 'example.com', verified: true }],
      exclusions: [],
  mission: null,
  impactTolerance: 'non_destructive',
  complianceFrameworks: [],
  testingPosture: 'black-box',
  testingPostureReason: 'no source access or credentials attached',
  whiteboxEnabled: false,
  connectedRepoCount: 0,
  connectedRepositories: [],
  accessMaterialCount: 0,
  accessMaterials: [],
};

const buildDbQueue = (results: unknown[]) => {
  let cursor = 0;
  return {
    select: vi.fn(() => {
      if (cursor >= results.length) {
        throw new Error(`No queued DB result for query #${cursor + 1}`);
      }
      const value = results[cursor];
      cursor += 1;
      const result = () => Promise.resolve(value);
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        groupBy: () => chain,
        orderBy: () => chain,
        limit: result,
        then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
          result().then(onfulfilled, onrejected),
      };
      return chain;
    }),
  };
};

const buildRunServiceWithDb = (database: unknown) => {
  const orgService = {
    getOrgContext: vi.fn().mockResolvedValue(ORG_CONTEXT),
  };
  const scopeService = {
    getScopeContext: vi.fn().mockResolvedValue(SCOPE_CONTEXT),
  };
  const skillContextService = {
    buildAssignedSkillsContext: vi.fn().mockResolvedValue(''),
  };

  const runService = new RunService(
    database as never,
    orgService as never,
    scopeService as never,
    {
      skillContextService: skillContextService as never,
    },
  );

  return { runService };
};

const buildRunService = (dbResults: unknown[]) =>
  buildRunServiceWithDb(buildDbQueue(dbResults));

describe('RunService recipient context', () => {
  it('includes the organization brief without appending a second intelligence snapshot', async () => {
    const { runService } = buildRunService([]);

    const context = await runService.buildExtraContextFromParts(
      'org-1',
      SCOPE_CONTEXT,
    );

    expect(context).toContain('=== ORGANIZATION BRIEF ===');
    expect(context).toContain('Handles customer data');
    expect(context).not.toContain('=== CURRENT INTELLIGENCE ===');
  });

});

describe('RunService strategic note selection for memory seeding', () => {
  it('returns only strategic note types and enforces per-type limits', async () => {
    const now = Date.now();
    const rows: Array<{
      ntype: string;
      title?: string | null;
      data: Record<string, unknown>;
      lastSeenAt: Date;
    }> = [];

    for (let i = 0; i < 30; i += 1) {
      rows.push({
        ntype: 'approach.tried',
        data: { endpoint: `/p-${i}`, technique: 'probe' },
        lastSeenAt: new Date(now - i * 1000),
      });
    }
    for (let i = 0; i < 12; i += 1) {
      rows.push({
        ntype: 'approach.blocker',
        data: { blocker_type: 'auth-wall', target: `host-${i}` },
        lastSeenAt: new Date(now - (30 + i) * 1000),
      });
    }
    for (let i = 0; i < 8; i += 1) {
      rows.push({
        ntype: 'run.digest',
        data: { goal: `goal-${i}` },
        lastSeenAt: new Date(now - (42 + i) * 1000),
      });
    }
    rows.push({
      ntype: 'http.endpoint',
      data: { url: 'https://example.com' },
      lastSeenAt: new Date(now - 100_000),
    });

    const { runService } = buildRunService([rows]);

    const notes = await runService.getStrategicNotesForMemorySeed('org-1', 'scope-1');

    expect(notes.filter((note) => note.ntype === 'approach.tried')).toHaveLength(20);
    expect(notes.filter((note) => note.ntype === 'approach.blocker')).toHaveLength(10);
    expect(notes.filter((note) => note.ntype === 'run.digest')).toHaveLength(5);
    const noteTypes = notes.map((note) => note.ntype);
    expect(noteTypes).not.toContain('http.endpoint');
  });

  it('filters strategic memory by workflow discipline while sharing scan coverage', async () => {
    const rows = [
      {
        ntype: 'run.digest',
        data: {
          workflowDiscipline: 'pentest',
          goal: 'Probe auth bypasses',
          outcome: 'completed',
        },
        lastSeenAt: new Date('2026-03-05T10:00:00.000Z'),
      },
      {
        ntype: 'run.digest',
        data: {
          workflowDiscipline: 'compliance',
          goal: 'SOC 2 readiness',
          outcome: 'partially_completed',
        },
        lastSeenAt: new Date('2026-03-05T10:05:00.000Z'),
      },
      {
        ntype: 'approach.blocker',
        data: {
          workflowDiscipline: 'pentest',
          blocker_type: 'auth-wall',
          target: 'api.example.com',
        },
        lastSeenAt: new Date('2026-03-05T10:06:00.000Z'),
      },
      {
        ntype: 'scan.coverage',
        data: {
          family: 'broad-surface',
          status: 'completed',
          target: 'api.example.com',
        },
        lastSeenAt: new Date('2026-03-05T10:07:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);
    const complianceBlock = await runService.buildPriorRunContext('org-1', 'scope-1', 'compliance');

    expect(complianceBlock).toContain('SOC 2 readiness => partially_completed');
    expect(complianceBlock).toContain('family=broad-surface');
    expect(complianceBlock).not.toContain('Probe auth bypasses');
    expect(complianceBlock).not.toContain('auth-wall @ api.example.com');
  });

  it('filters compliance strategic memory by framework when a framework is active', async () => {
    const rows = [
      {
        ntype: 'run.digest',
        data: {
          workflowDiscipline: 'compliance',
          frameworkKey: 'hipaa',
          goal: 'HIPAA readiness',
          outcome: 'partially_completed',
        },
        lastSeenAt: new Date('2026-03-05T10:05:00.000Z'),
      },
      {
        ntype: 'run.digest',
        data: {
          workflowDiscipline: 'compliance',
          frameworkKey: 'pci_dss',
          goal: 'PCI DSS readiness',
          outcome: 'partially_completed',
        },
        lastSeenAt: new Date('2026-03-05T10:06:00.000Z'),
      },
      {
        ntype: 'run.digest',
        data: {
          workflowDiscipline: 'compliance',
          goal: 'Legacy SOC 2 readiness',
          outcome: 'completed',
          closesCompliance: [{ frameworkKey: 'soc2', controlId: 'CC6.7' }],
        },
        lastSeenAt: new Date('2026-03-05T10:07:00.000Z'),
      },
      {
        ntype: 'scan.coverage',
        data: {
          family: 'broad-surface',
          status: 'completed',
          target: 'app.example.com',
        },
        lastSeenAt: new Date('2026-03-05T10:08:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);
    const pciBlock = await runService.buildPriorRunContext('org-1', 'scope-1', 'compliance', 'pci_dss');

    expect(pciBlock).toContain('PCI DSS readiness => partially_completed');
    expect(pciBlock).toContain('family=broad-surface');
    expect(pciBlock).not.toContain('HIPAA readiness');
    expect(pciBlock).not.toContain('Legacy SOC 2 readiness');
  });

  it('formats a prior run context block for planner extra context injection', async () => {
    const rows = [
      {
        ntype: 'run.digest',
        title: 'Operator digest',
        data: {
          goal: 'Assess API auth',
          outcome: 'blocked',
          blocker_summary: 'Auth wall',
          closesCompliance: [{ frameworkKey: 'soc2', controlId: 'CC6.7' }],
        },
        lastSeenAt: new Date('2026-03-05T10:00:00.000Z'),
      },
      {
        ntype: 'approach.tried',
        data: {
          technique: 'broken-auth',
          endpoint: '/login',
          result: 'blocked',
          reason: '401 on all attempts',
          http_status: 401,
        },
        lastSeenAt: new Date('2026-03-05T10:05:00.000Z'),
      },
      {
        ntype: 'approach.blocker',
        data: {
          blocker_type: 'auth-wall',
          target: 'api.example.com',
          blocker_reason: 'No token',
          prerequisites: ['API key'],
        },
        lastSeenAt: new Date('2026-03-05T10:06:00.000Z'),
      },
      {
        ntype: 'scan.coverage',
        data: {
          asset: 'api.example.com',
          family: 'broad-surface-scan',
          status: 'completed',
          stats: { endpoints: 14, services: 3 },
        },
        lastSeenAt: new Date('2026-03-05T10:07:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);
    const block = await runService.buildPriorRunContext('org-1', 'scope-1');

    expect(block).toContain('=== PRIOR RUN CONTEXT ===');
    expect(block).toContain('Recent run digests:');
    expect(block).toContain('Assess API auth => blocked');
    expect(block).toContain('closes_compliance=soc2:CC6.7');
    expect(block).toContain('Recent tried approaches:');
    expect(block).toContain('broken-auth @ /login => blocked');
    expect(block).toContain('Recent blockers:');
    expect(block).toContain('auth-wall @ api.example.com');
    expect(block).toContain('Recent scan coverage:');
    expect(block).toContain('api.example.com | family=broad-surface-scan | status=completed');
  });

  it('keeps scan.coverage in strategic memory selection with per-type limits', async () => {
    const rows = Array.from({ length: 14 }, (_, index) => ({
      ntype: 'scan.coverage',
      data: {
        asset: `asset-${index}.example.com`,
        family: 'broad-surface-scan',
        status: index % 2 === 0 ? 'completed' : 'blocked',
      },
      lastSeenAt: new Date(Date.UTC(2026, 2, 5, 10, index, 0)),
    }));

    const { runService } = buildRunService([rows]);
    const notes = await runService.getStrategicNotesForMemorySeed('org-1', 'scope-1');

    expect(notes.filter((note) => note.ntype === 'scan.coverage')).toHaveLength(12);
  });

  it('prefers rich digests over newer thin fallback digests before applying limits', async () => {
    const rows = [
      {
        ntype: 'run.digest',
        title: 'Auto-generated run digest',
        data: {
          goal: 'Thin digest',
          outcome: 'completed',
        },
        lastSeenAt: new Date('2026-03-06T10:00:00.000Z'),
      },
      {
        ntype: 'run.digest',
        title: 'Operator digest',
        data: {
          goal: 'Rich digest',
          outcome: 'blocked',
          completed_tasks: ['Mapped public authentication routes'],
        },
        lastSeenAt: new Date('2026-03-05T10:00:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);

    const notes = await runService.getStrategicNotesForMemorySeed('org-1', 'scope-1');
    const digests = notes.filter((note) => note.ntype === 'run.digest');

    expect(digests[0]?.data).toMatchObject({ goal: 'Rich digest' });
    expect(digests[1]?.title).toBe('Auto-generated run digest');
  });

  it('aggregates repeated approach notes by endpoint and technique', async () => {
    const rows = [
      {
        ntype: 'approach.tried',
        data: {
          technique: 'sqli',
          endpoint: '/api/users',
          result: 'failed',
          reason: '500 after quote',
          http_status: 500,
        },
        lastSeenAt: new Date('2026-03-05T10:00:00.000Z'),
      },
      {
        ntype: 'approach.tried',
        data: {
          technique: 'sqli',
          endpoint: '/api/users',
          result: 'failed',
          reason: 'blocked by WAF',
          http_status: 403,
        },
        lastSeenAt: new Date('2026-03-05T10:05:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);

    const notes = await runService.getStrategicNotesForMemorySeed('org-1', 'scope-1');
    const approaches = notes.filter((note) => note.ntype === 'approach.tried');

    expect(approaches).toHaveLength(1);
    expect(approaches[0]?.data).toMatchObject({
      endpoint: '/api/users',
      technique: 'sqli',
      attempt_count: 2,
      reason: 'blocked by WAF',
      http_status: '403',
    });
  });

  it('labels fallback and thin digests and summarizes repeated approaches in prior run context', async () => {
    const rows = [
      {
        ntype: 'run.digest',
        title: 'Auto-generated run digest',
        data: {
          goal: 'Assess auth',
          outcome: 'completed',
        },
        lastSeenAt: new Date('2026-03-06T10:00:00.000Z'),
      },
      {
        ntype: 'run.digest',
        title: 'Manual digest',
        data: {
          goal: 'Thin manual digest',
          outcome: 'blocked',
        },
        lastSeenAt: new Date('2026-03-05T10:00:00.000Z'),
      },
      {
        ntype: 'approach.tried',
        data: {
          technique: 'sqli',
          endpoint: '/api/users',
          result: 'failed',
          reason: 'blocked by WAF',
          attempt_count: 3,
        },
        lastSeenAt: new Date('2026-03-05T10:05:00.000Z'),
      },
    ];

    const { runService } = buildRunService([rows]);
    const block = await runService.buildPriorRunContext('org-1', 'scope-1');

    expect(block).toContain('[FALLBACK DIGEST] Assess auth => completed');
    expect(block).toContain('[THIN DIGEST] Thin manual digest => blocked');
    expect(block).toContain('sqli @ /api/users => failed (attempts=3; reason=blocked by WAF)');
  });
});
