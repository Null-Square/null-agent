import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readinessServiceMock = vi.hoisted(() => ({
  getScopeReadiness: vi.fn(),
}));
const evidenceServiceMock = vi.hoisted(() => ({
  listEvidenceItems: vi.fn(),
}));

vi.mock('@/domains/security-ops/compliance/ComplianceReadinessService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domains/security-ops/compliance/ComplianceReadinessService')>();
  return {
    ...actual,
    ComplianceReadinessService: vi.fn(() => readinessServiceMock),
  };
});

vi.mock('@/domains/security-ops/compliance/ComplianceEvidenceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domains/security-ops/compliance/ComplianceEvidenceService')>();
  return {
    ...actual,
    ComplianceEvidenceService: vi.fn(() => evidenceServiceMock),
  };
});

import {
  createLocalWorkspaceTarget,
  createSandboxWorkspaceTarget,
  LocalWorkspaceFilePort,
} from '@/domains/security-ops/workspace/WorkspaceFilePort';
import { assertProjectionOwnedPath } from '@/domains/security-ops/workspace/WorkspaceProjectionHelpers';
import {
  buildEndpointSurfaceGraph,
  buildScanDigest,
  deriveCoverageProjectionDetail,
  normalizeProjectedEndpoint,
  scoreValidationLeadPriority,
  WorkspaceProjectionService,
} from '@/domains/security-ops/workspace/WorkspaceProjectionService';

const tempDirs: string[] = [];

const makeTempWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'nullai-workspace-projection-'));
  tempDirs.push(dir);
  return dir;
};

const makeEmptyDatabase = (): never => {
  const query: Record<PropertyKey, unknown> = new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') {
        return Promise.resolve([]).then.bind(Promise.resolve([]));
      }
      return () => query;
    },
  });
  return { select: vi.fn(() => query) } as never;
};

describe('WorkspaceProjectionService', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes the root workspace contract and artifact compatibility README through the file port', async () => {
    const workspaceDir = await makeTempWorkspace();
    const service = new WorkspaceProjectionService({} as never, {
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });

    const result = await service.projectRunWorkspace({
      orgId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspace: createLocalWorkspaceTarget({ runId: 'run-1', workspacePath: workspaceDir }),
      reason: 'unit_test',
      scopes: ['contract'],
    });

    expect(result.success).toBe(true);
    expect(result.written).toEqual(['AGENTS.md', '.artifacts/README.md']);

    const agents = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('curated projection of canonical SecurityOps state');
    expect(agents).toContain('Read `journal/model.md`');

    const artifactsReadme = await readFile(join(workspaceDir, '.artifacts', 'README.md'), 'utf8');
    expect(artifactsReadme).toContain('Compatibility Artifact Directory');
    expect(artifactsReadme).toContain('/workspace/AGENTS.md');
  });

  it('projects every run-start scope through the owned-path boundary', async () => {
    const workspaceDir = await makeTempWorkspace();
    const service = new WorkspaceProjectionService(makeEmptyDatabase(), {
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      skillLoader: { loadSkillCatalog: vi.fn(async () => []) } as never,
    });

    const result = await service.projectRunWorkspace({
      orgId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspace: createLocalWorkspaceTarget({ runId: 'run-1', workspacePath: workspaceDir }),
      reason: 'run_start',
      scopes: ['all'],
    });

    expect(result.success).toBe(true);
    expect(result.written).toContain('findings/reportable.json');
    expect(assertProjectionOwnedPath('findings/reportable.json')).toBe('findings/reportable.json');
    expect(() => assertProjectionOwnedPath('findings/validated.json')).toThrow(
      'projection_path_not_owned:findings/validated.json',
    );

    const reportable = JSON.parse(
      await readFile(join(workspaceDir, 'findings', 'reportable.json'), 'utf8'),
    ) as { source: { projection: string }; data: unknown[] };
    expect(reportable.source.projection).toBe('findings.reportable');
    expect(reportable.data).toEqual([]);
  });

  it('projects only the Code Review catalog into a Code Review workspace', async () => {
    const workspaceDir = await makeTempWorkspace();
    const skillLoader = {
      loadSkillCatalog: vi.fn(async () => [
        {
          slug: 'code-review-planning',
          name: 'Code Review Planning',
          description: 'Plan a repository review.',
          phase: 'planning',
          compatiblePhases: ['planning'],
          category: 'code_review',
          requiredTools: ['submit_plan'],
          riskTier: 'low',
          versionHash: 'review-planning-v1',
          catalogVersion: 'v1',
          useWhen: 'Planning Code Review.',
          strongTerms: [],
          techTriggers: [],
          ntypeTriggers: [],
        },
        {
          slug: 'code-review-mapping',
          name: 'Code Review Mapping',
          description: 'Map an immutable repository.',
          phase: 'review_mapping',
          compatiblePhases: ['review_mapping'],
          category: 'code_review',
          requiredTools: ['list_code_review_repository_files'],
          riskTier: 'low',
          versionHash: 'review-mapping-v1',
          catalogVersion: 'v1',
          useWhen: 'Mapping Code Review.',
          strongTerms: [],
          techTriggers: [],
          ntypeTriggers: [],
        },
        {
          slug: 'broad-surface-scan',
          name: 'Broad Surface Scan',
          description: 'Pentest reconnaissance.',
          phase: 'recon',
          compatiblePhases: ['recon'],
          category: 'recon',
          requiredTools: ['nuclei_scan'],
          riskTier: 'medium',
          versionHash: 'pentest-v1',
          catalogVersion: 'v1',
          useWhen: 'Pentest only.',
          strongTerms: [],
          techTriggers: [],
          ntypeTriggers: [],
        },
      ]),
    } as never;
    const service = new WorkspaceProjectionService({} as never, {
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      skillLoader,
    });

    await service.projectRunWorkspace({
      orgId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspace: createLocalWorkspaceTarget({ runId: 'run-1', workspacePath: workspaceDir }),
      reason: 'unit_test',
      scopes: ['skills'],
      phaseKey: 'planning',
      assignedSkillSlugs: ['code-review-planning'],
    });

    const skillIndex = await readFile(join(workspaceDir, 'skills', 'index.md'), 'utf8');
    expect(skillIndex).toContain('code-review-planning');
    expect(skillIndex).toContain('code-review-mapping');
    expect(skillIndex).not.toContain('broad-surface-scan');
  });

  it('rejects path traversal through the local workspace file port', async () => {
    const workspaceDir = await makeTempWorkspace();
    const port = new LocalWorkspaceFilePort(workspaceDir);

    await expect(port.writeFileAtomic('../outside.txt', 'nope')).rejects.toThrow(
      'workspace_path_outside_root',
    );
  });

  it('atomically replaces a projected file with complete content', async () => {
    const workspaceDir = await makeTempWorkspace();
    const port = new LocalWorkspaceFilePort(workspaceDir);

    await port.writeFileAtomic('journal/model.md', 'old');
    await port.writeFileAtomic('journal/model.md', 'new complete content');

    await expect(readFile(join(workspaceDir, 'journal', 'model.md'), 'utf8')).resolves.toBe(
      'new complete content',
    );
  });

  it('uses temp-write plus rename when writing through a sandbox runner port', async () => {
    const workspaceDir = await makeTempWorkspace();
    const session = { id: 'session-1', workspaceDir } as any;
    const sandbox = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const target = createSandboxWorkspaceTarget({
      runId: 'run-1',
      session,
      sandbox,
    });

    await target.filePort.writeFileAtomic('journal/model.md', 'remote complete content');

    expect(sandbox.writeFile).toHaveBeenCalledWith(
      session,
      expect.stringMatching(/^journal\/\.model\.md\.tmp-/),
      'remote complete content',
    );
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        cmd: expect.stringContaining("mv -f '/workspace/journal/.model.md.tmp-"),
      }),
    );
    await expect(readFile(join(workspaceDir, 'journal', 'model.md'), 'utf8')).resolves.toBe(
      'remote complete content',
    );
  });

  it('propagates sandbox write failures instead of reporting projected files as written', async () => {
    const workspaceDir = await makeTempWorkspace();
    const session = { id: 'session-1', workspaceDir } as any;
    const target = createSandboxWorkspaceTarget({
      runId: 'run-1',
      session,
      sandbox: {
        writeFile: vi.fn().mockRejectedValue(new Error('write failed: No space left on device')),
        exec: vi.fn(),
      },
    });

    await expect(target.filePort.writeFileAtomic('journal/model.md', 'content')).rejects.toThrow(
      'No space left on device',
    );
    await expect(readFile(join(workspaceDir, 'journal', 'model.md'), 'utf8')).rejects.toThrow();
  });

  it('projects a compliance workspace pack with safe evidence handles for compliance phases', async () => {
    const workspaceDir = await makeTempWorkspace();
    readinessServiceMock.getScopeReadiness.mockResolvedValue({
      selectedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
      frameworks: [
        {
          key: 'soc2',
          label: 'SOC 2',
          selected: true,
          supported: true,
          score: 90,
          statusCounts: { passing: 1 },
          outcomeCounts: { passed: 1 },
          verdictCounts: { pass: 1 },
          controls: [
            {
              id: 'CC6.1',
              title: 'Logical access controls',
              theme: 'Access Controls',
              supportLevel: 'automated_testable',
              catalogRef: 'soc2:CC6.1',
              proofObligation: { id: 'soc2-cc6.1-authz-v1' },
              requiredEvidence: ['HTTP authorization proof'],
              status: 'passing',
              verdict: 'pass',
              outcome: 'passed',
              reasonCode: 'control_operating',
              verdictReason: 'Authenticated access controls rejected unauthorized requests in the tested endpoint set. token=verdict-secret',
              nextAction: 'Reverify when new protected routes are added. Authorization: Bearer next-action-secret',
              gaps: [],
              coverageLimitations: ['Cross-role checks were not possible without supplied personas. password=limitation-secret'],
              evidenceFreshness: { status: 'fresh', freshUntil: '2026-07-01T00:00:00.000Z' },
              monitoring: { state: 'monitored', exclusionReason: null },
              assignment: { assignedToUserId: 'user-2' },
              actionRequests: [
                {
                  id: 'request-1',
                  requestType: 'access',
                  priority: 'high',
                  status: 'open',
                  title: 'Provide test personas',
                  reason: 'Cross-role authorization checks need approved test accounts. password=persona-secret',
                  requestedEvidence: ['viewer and admin test accounts by handle, token=requested-evidence-secret'],
                  dueAt: null,
                  updatedAt: '2026-06-01T00:00:00.000Z',
                },
              ],
              controlChecks: [
                {
                  id: 'check-1',
                  basis: 'agent_tested',
                  verdict: 'pass',
                  reasonCode: 'control_operating',
                  reason: 'The tested boundary rejected unauthenticated requests. secret=check-secret',
                  proofObligationId: 'soc2-cc6.1-authz-v1',
                  method: 'HTTP differential test',
                  targetRef: 'https://app.example.com/api/admin',
                  limitations: ['No customer credentials supplied. Bearer check-limitation-secret'],
                  freshUntil: '2026-07-01T00:00:00.000Z',
                  createdAt: '2026-06-01T00:00:00.000Z',
                  fresh: true,
                  eligible: true,
                  reviewStatus: 'not_required',
                  evidenceRefs: ['artifact:proof-1'],
                  artifactIds: ['artifact-1'],
                },
              ],
              evidence: [
                {
                  id: 'evidence-1',
                  kind: 'control_check',
                  title: 'HTTP proof',
                  source: 'agent',
                  sourceRef: 'artifact:proof-1',
                  lastSeenAt: '2026-06-01T00:00:00.000Z',
                  mappingSource: 'control_check',
                  mappingConfidence: 'high',
                  controlCheckVerdict: 'pass',
                },
              ],
            },
          ],
        },
        {
          key: 'hipaa',
          label: 'HIPAA Security Rule',
          selected: true,
          supported: true,
          score: 10,
          statusCounts: { missing: 1 },
          outcomeCounts: { needs_context: 1 },
          verdictCounts: { needs_context: 1 },
          controls: [
            {
              id: '164.312(a)(1)',
              title: 'Access control',
              theme: 'Technical Safeguards',
              supportLevel: 'manual_evidence_required',
              catalogRef: 'hipaa:164.312(a)(1)',
              proofObligation: { id: 'hipaa-164.312-a1-access-v1' },
              requiredEvidence: ['HIPAA access-control evidence'],
              status: 'missing',
              verdict: 'needs_context',
              outcome: 'needs_context',
              reasonCode: 'insufficient_evidence',
              verdictReason: 'HIPAA evidence is missing.',
              nextAction: 'Request HIPAA evidence.',
              gaps: [],
              coverageLimitations: [],
              evidenceFreshness: { status: 'missing', freshUntil: null },
              monitoring: { state: 'monitored', exclusionReason: null },
              assignment: null,
              actionRequests: [
                {
                  id: 'request-hipaa',
                  requestType: 'evidence',
                  priority: 'medium',
                  status: 'open',
                  title: 'Provide HIPAA access policy',
                  reason: 'HIPAA-specific evidence is missing.',
                  requestedEvidence: ['HIPAA access policy'],
                  dueAt: null,
                  updatedAt: '2026-06-01T00:00:00.000Z',
                },
              ],
              controlChecks: [],
              evidence: [],
            },
          ],
        },
      ],
    });
    evidenceServiceMock.listEvidenceItems.mockResolvedValue([
      {
        id: 'evidence-1',
        scopeId: 'scope-1',
        title: 'Access policy',
        description: 'Approved access-control policy excerpt. api_key=evidence-secret',
        sourceType: 'user_upload',
        evidenceType: 'policy',
        status: 'needs_agent_review',
        owner: 'security',
        observationStartedAt: new Date('2026-05-01T00:00:00.000Z'),
        observationEndedAt: new Date('2026-06-01T00:00:00.000Z'),
        validUntil: new Date('2026-12-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        artifact: {
          fileName: 'access-policy.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          storageRef: 's3://private-bucket/access-policy.pdf',
          sourceRef: 'upload:access-policy',
        },
        mappings: [
          {
            frameworkKey: 'soc2',
            controlId: 'CC6.1',
            mappingSource: 'system_suggested',
            confidence: 'medium',
            rationale: 'Policy discusses logical access approvals. token=mapping-secret',
          },
          {
            frameworkKey: 'hipaa',
            controlId: '164.312(a)(1)',
            mappingSource: 'system_suggested',
            confidence: 'medium',
            rationale: 'Policy also discusses HIPAA access controls.',
          },
        ],
        agentReview: null,
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  id: 'run-previous',
                  title: 'SOC 2 readiness',
                  goal: 'Assess SOC 2 controls password=prior-run-secret',
                  status: 'completed',
                  createdAt: new Date('2026-05-01T00:00:00.000Z'),
                  updatedAt: new Date('2026-05-01T01:00:00.000Z'),
                  completedAt: new Date('2026-05-01T01:00:00.000Z'),
                },
              ]),
            })),
          })),
        })),
      })),
    } as never;
    const skillLoader = {
      loadSkillBySlug: vi.fn(async (slug: string) => ({
        slug,
        name: 'Compliance Planning',
        phase: 'control_assessment',
        localPath: 'C:/Projects/Null-Ai/services/backend/skills/compliance-planning',
        requiredTools: ['record_control_check', 'record_control_request'],
        expectedOutputs: ['control checks', 'action requests'],
      })),
    } as never;
    const service = new WorkspaceProjectionService(db, {
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      skillLoader,
    });

    const result = await service.projectRunWorkspace({
      orgId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspace: createLocalWorkspaceTarget({ runId: 'run-1', workspacePath: workspaceDir }),
      reason: 'unit_test',
      scopes: ['compliance'],
      assignedSkillSlugs: ['compliance-planning'],
      activeComplianceFrameworkKey: 'soc2',
    });

    expect(result.success).toBe(true);
    expect(result.written).toEqual(expect.arrayContaining([
      '.compliance/framework.json',
      '.compliance/monitored-controls.json',
      '.compliance/readiness-current.json',
      '.compliance/open-requests.json',
      '.compliance/evidence-index.json',
      '.compliance/previous-runs.json',
      '.compliance/methodology.md',
    ]));
    const evidenceIndex = JSON.parse(await readFile(join(workspaceDir, '.compliance', 'evidence-index.json'), 'utf8'));
    expect(evidenceIndex.data[0]).toMatchObject({
      id: 'evidence-1',
      handle: 'compliance-evidence:evidence-1',
      artifact: {
        fileName: 'access-policy.pdf',
        storageHandleAvailable: true,
      },
    });
    expect(JSON.stringify(evidenceIndex)).not.toContain('s3://private-bucket');
    expect(JSON.stringify(evidenceIndex)).not.toContain('164.312');

    const openRequests = JSON.parse(await readFile(join(workspaceDir, '.compliance', 'open-requests.json'), 'utf8'));
    expect(openRequests.data).toHaveLength(1);
    expect(openRequests.data[0].request.id).toBe('request-1');
    expect(JSON.stringify(openRequests)).not.toContain('request-hipaa');

    const frameworkPack = JSON.parse(await readFile(join(workspaceDir, '.compliance', 'framework.json'), 'utf8'));
    expect(frameworkPack.data).toHaveLength(1);
    expect(frameworkPack.data[0].key).toBe('soc2');

    const complianceFiles = await Promise.all([
      readFile(join(workspaceDir, '.compliance', 'readiness-current.json'), 'utf8'),
      readFile(join(workspaceDir, '.compliance', 'open-requests.json'), 'utf8'),
      readFile(join(workspaceDir, '.compliance', 'evidence-index.json'), 'utf8'),
      readFile(join(workspaceDir, '.compliance', 'previous-runs.json'), 'utf8'),
    ]);
    const projectedComplianceText = complianceFiles.join('\n');
    expect(projectedComplianceText).not.toContain('verdict-secret');
    expect(projectedComplianceText).not.toContain('next-action-secret');
    expect(projectedComplianceText).not.toContain('limitation-secret');
    expect(projectedComplianceText).not.toContain('persona-secret');
    expect(projectedComplianceText).not.toContain('requested-evidence-secret');
    expect(projectedComplianceText).not.toContain('check-secret');
    expect(projectedComplianceText).not.toContain('check-limitation-secret');
    expect(projectedComplianceText).not.toContain('evidence-secret');
    expect(projectedComplianceText).not.toContain('mapping-secret');
    expect(projectedComplianceText).not.toContain('prior-run-secret');
    expect(projectedComplianceText).toContain('[REDACTED]');

    const methodology = await readFile(join(workspaceDir, '.compliance', 'methodology.md'), 'utf8');
    expect(methodology).toContain('Do not put credentials');
    expect(methodology).toContain('record_control_check');
    expect(methodology).toContain('compliance-planning');
  });

  it('skips compliance workspace files when the run is not compliance-scoped', async () => {
    const workspaceDir = await makeTempWorkspace();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ workflowDiscipline: 'pentest' }]),
          })),
        })),
      })),
    } as never;
    const service = new WorkspaceProjectionService(db, {
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });

    const result = await service.projectRunWorkspace({
      orgId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspace: createLocalWorkspaceTarget({ runId: 'run-1', workspacePath: workspaceDir }),
      reason: 'unit_test',
      scopes: ['compliance'],
      assignedSkillSlugs: [],
    });

    expect(result.success).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.skipped).toContainEqual({ path: '.compliance/*', reason: 'run is not compliance-scoped' });
    expect(readinessServiceMock.getScopeReadiness).not.toHaveBeenCalled();
  });

  it('scores validation leads by security impact before recency', () => {
    const highImpact = scoreValidationLeadPriority({
      title: 'Admin tenant IDOR',
      confidence: 0.9,
      data: {
        priority: 'high',
        riskFamily: 'idor',
        target: '/admin/users/:id',
        evidenceRefs: ['.artifacts/phase-handoffs/recon.json'],
        source: 'phase-handoff:recon',
        status: 'open',
      },
    });

    const blockedLowImpact = scoreValidationLeadPriority({
      title: 'Marketing page header check',
      confidence: 0.2,
      data: {
        priority: 'low',
        riskFamily: 'headers',
        target: '/about',
        attempts: 3,
        status: 'blocked',
      },
    });

    expect(highImpact.band).toMatch(/critical|high/);
    expect(highImpact.score).toBeGreaterThan(blockedLowImpact.score);
    expect(highImpact.reasons).toEqual(expect.arrayContaining(['priority=high', 'risk=idor']));
    expect(blockedLowImpact.reasons).toEqual(expect.arrayContaining(['blocked', 'attempts=3']));
  });

  it('normalizes endpoint notes into a risk-signaled surface graph', () => {
    const endpoint = normalizeProjectedEndpoint({
      id: 'note-1',
      assetId: 'asset-1',
      data: {
        url: 'https://api.example.com/admin/users/{id}',
        method: 'POST',
        pathParams: ['id'],
        bodyParams: ['role'],
        authHint: 'none',
      },
      confidence: 0.8,
      evidence: [],
    });
    const graph = buildEndpointSurfaceGraph({
      assets: [{ id: 'asset-1', value: 'api.example.com' }],
      services: [],
      endpoints: [endpoint],
    });

    expect(endpoint).toMatchObject({
      host: 'api.example.com',
      method: 'POST',
    });
    expect(endpoint.riskSignals).toEqual(
      expect.arrayContaining(['path-parameter', 'sensitive-route', 'anonymous-state-change']),
    );
    expect(graph.endpointSummary.total).toBe(1);
    expect(graph.endpointSummary.risky).toHaveLength(1);
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'asset_has_endpoint' })]));
  });

  it('derives actionable coverage gaps from scanner observations and coverage notes', () => {
    const detail = deriveCoverageProjectionDetail({
      coverageNotes: [
        {
          data: {
            family: 'nuclei',
            status: 'blocked',
            reason: 'rate limit reached',
          },
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      scannerRows: [
        {
          parser: 'katana',
          observationType: 'endpoint',
          lastSeenAt: '2026-06-01T00:01:00.000Z',
        },
      ],
    });

    expect(detail.matrix).toEqual(expect.arrayContaining([expect.objectContaining({ family: 'katana', observations: 1 })]));
    expect(detail.blockers).toEqual(['rate limit reached']);
    expect(detail.gaps).toEqual(expect.arrayContaining(['katana produced observations but has no scan.coverage ledger note']));
  });

  it('builds a scan digest that points at summaries before raw artifacts', () => {
    const digest = buildScanDigest([
      {
        parser: 'nuclei',
        sourceTool: 'nuclei',
        observationType: 'exposure',
        severity: 'high',
        title: 'Exposed admin panel',
        artifactPath: '.artifacts/scans/nuclei/out.jsonl',
        data: {
          method: 'GET',
          url: 'https://app.example.com/admin',
          statusCode: 200,
        },
        lastSeenAt: '2026-06-01T00:00:00.000Z',
      },
      {
        parser: 'nuclei',
        sourceTool: 'nuclei',
        observationType: 'info',
        severity: 'info',
        title: 'Header observed',
        artifactPath: '.artifacts/scans/nuclei/out.jsonl',
        data: {
          method: 'GET',
          url: 'https://app.example.com/',
          status_code: 200,
        },
        lastSeenAt: '2026-06-01T00:00:01.000Z',
      },
    ], {
      recon: {
        endpoints: [
          {
            method: 'POST',
            host: 'app.example.com',
            path: '/admin/users',
            riskSignals: ['sensitive-route', 'anonymous-state-change'],
          },
        ],
        technologies: [
          {
            title: 'React detected',
            data: { name: 'react' },
          },
        ],
        endpointSummary: {
          total: 1,
          byHost: { 'app.example.com': 1 },
          byMethod: { POST: 1 },
          risky: [
            {
              method: 'POST',
              host: 'app.example.com',
              path: '/admin/users',
              riskSignals: ['sensitive-route', 'anonymous-state-change'],
            },
          ],
        },
      },
      coverage: {
        notes: [{ id: 'coverage-1' }],
        gaps: ['katana produced observations but has no scan.coverage ledger note'],
        matrix: [{ family: 'katana', observations: 3 }],
        blockers: [],
      },
    });

    expect(digest.totals).toMatchObject({
      observations: 2,
      artifactCount: 1,
      hostCount: 1,
      endpointCount: 2,
      projectedEndpointCount: 1,
      projectedTechnologyCount: 1,
      coverageNoteCount: 1,
      byHost: { 'app.example.com': 2 },
      byStatusCode: { '200': 2 },
    });
    expect(digest.highSignal).toEqual([expect.objectContaining({ severity: 'high' })]);
    expect(digest.topHosts).toEqual([
      expect.objectContaining({
        host: 'app.example.com',
        observations: 2,
      }),
    ]);
    expect(digest.topEndpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointKey: 'GET app.example.com /admin',
          observations: 1,
          highestSeverity: 'high',
        }),
      ]),
    );
    expect(digest.topArtifacts).toEqual([
      expect.objectContaining({
        artifactPath: '.artifacts/scans/nuclei/out.jsonl',
        observations: 2,
        highestSeverity: 'high',
      }),
    ]);
    expect(digest.projectedInventory).toMatchObject({
      riskyEndpoints: [
        expect.objectContaining({
          path: '/admin/users',
          riskSignals: ['sensitive-route', 'anonymous-state-change'],
        }),
      ],
      coverageGaps: ['katana produced observations but has no scan.coverage ledger note'],
    });
    expect(digest.rawReadPolicy).toContain('Prefer this digest');
  });
});
