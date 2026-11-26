import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import {
  FinalizeRunArtifacts,
  IngestScanArtifact,
  PrepareReportContext,
  PromoteFinding,
  QueryComplianceEvidence,
  QueryComplianceMissingEvidence,
  QueryComplianceProofPackage,
  QueryComplianceReadiness,
  QueryInventory,
  RecordControlCheck,
  RecordControlRequest,
  ReviewControlRequest,
  ReportService,
  ReportFinding,
  ReportFinalizerPreflight,
  ReportNote,
  SubmitValidationLeadOutcome,
  SubmitValidationOutcome,
  isReportingHandoffRecorded,
} from '@/domains/agent-brain/adapters/tools/builtins/securityops';
import type { ToolContext } from '@/domains/agent-brain/application/tools';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const {
  finalizeRunArtifactsMock,
  ingestScanArtifactMock,
  prepareReportContextMock,
  reportFinalizerPreflightMock,
  promoteFindingMock,
  queryComplianceEvidenceMock,
  queryComplianceMissingEvidenceMock,
  queryComplianceProofPackageMock,
  queryComplianceReadinessMock,
  queryInventoryMock,
  recordControlCheckMock,
  recordControlRequestMock,
  reviewControlRequestMock,
  reportFindingMock,
  reportNoteMock,
  reportServiceMock,
  submitValidationOutcomeMock,
  submitValidationLeadOutcomeMock,
  phaseListByRunIdMock,
  phaseUpdateStatusMock,
  validationQueueEnqueueMock,
  validationQueueCompleteFindingMock,
} = vi.hoisted(() => ({
  finalizeRunArtifactsMock: vi.fn(),
  ingestScanArtifactMock: vi.fn(),
  prepareReportContextMock: vi.fn(),
  reportFinalizerPreflightMock: vi.fn(),
  promoteFindingMock: vi.fn(),
  queryComplianceEvidenceMock: vi.fn(),
  queryComplianceMissingEvidenceMock: vi.fn(),
  queryComplianceProofPackageMock: vi.fn(),
  queryComplianceReadinessMock: vi.fn(),
  queryInventoryMock: vi.fn(),
  recordControlCheckMock: vi.fn(),
  recordControlRequestMock: vi.fn(),
  reviewControlRequestMock: vi.fn(),
  reportFindingMock: vi.fn(),
  reportNoteMock: vi.fn(),
  reportServiceMock: vi.fn(),
  submitValidationOutcomeMock: vi.fn(),
  submitValidationLeadOutcomeMock: vi.fn(),
  phaseListByRunIdMock: vi.fn(),
  phaseUpdateStatusMock: vi.fn().mockResolvedValue(null),
  validationQueueEnqueueMock: vi.fn(),
  validationQueueCompleteFindingMock: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {},
}));

vi.mock('@/domains/security-ops/runs/RunPhaseRepository', () => ({
  RunPhaseRepository: class {
    listByRunId = phaseListByRunIdMock;
    updateStatus = phaseUpdateStatusMock;
  },
}));

vi.mock('@/domains/security-ops/runs/ValidationQueueRepository', () => ({
  ValidationQueueRepository: class {
    enqueue = validationQueueEnqueueMock;
    completeFinding = validationQueueCompleteFindingMock;
  },
}));

vi.mock('@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry', () => ({
  getSecurityOpsService: () => ({
    finalizeRunArtifacts: finalizeRunArtifactsMock,
    ingestScanArtifact: ingestScanArtifactMock,
    prepareReportContext: prepareReportContextMock,
    reportFinalizerPreflight: reportFinalizerPreflightMock,
    promoteFinding: promoteFindingMock,
    queryComplianceEvidence: queryComplianceEvidenceMock,
    queryComplianceMissingEvidence: queryComplianceMissingEvidenceMock,
    queryComplianceProofPackage: queryComplianceProofPackageMock,
    queryComplianceReadiness: queryComplianceReadinessMock,
    queryInventory: queryInventoryMock,
    recordComplianceControlCheck: recordControlCheckMock,
    recordComplianceControlRequest: recordControlRequestMock,
    reviewComplianceControlRequest: reviewControlRequestMock,
    reportFinding: reportFindingMock,
    reportNote: reportNoteMock,
    reportService: reportServiceMock,
    submitValidationLeadOutcome: submitValidationLeadOutcomeMock,
    submitValidationOutcome: submitValidationOutcomeMock,
  }),
}));

describe('SecurityOps builtins', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    vi.spyOn(store, 'recordSessionCompletedAsync').mockResolvedValue(true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.shutdown();
  });

  const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      sessionId: 'session-1',
      workspaceDir: '/tmp/workspace',
      sandbox: {
        readFile: vi.fn(),
        statFile: vi.fn(),
      } as any,
      sessionStore: store,
      streamBroker: { emit: vi.fn() } as any,
      trace: undefined,
      approvals: { require: vi.fn().mockResolvedValue(undefined) },
      checkpoints: undefined,
      guards: {
        pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
        cmdGuard: { validate: vi.fn() } as any,
      },
      policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
      flags: {},
      planRuntime: {} as any,
      abortSignal: new AbortController().signal,
      ...overrides,
    }) as ToolContext;

  it('warns on zero-finding pentest run digests but not compliance run digests', async () => {
    const pentestSession = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-pentest',
          reportFindingCount: 0,
        },
      },
      scopeId: 'scope-1',
    });
    reportNoteMock.mockResolvedValueOnce({ created: true, noteId: 'note-pentest' });

    const pentestResult = await ReportNote.run(
      {
        ntype: 'run.digest',
        title: 'Run digest',
        data: { goal: 'Assess app', outcome: 'completed' },
      },
      makeContext({
        sessionId: pentestSession.id,
        workspaceDir: pentestSession.workspaceDir,
        flags: pentestSession.flags ?? {},
      }),
    );

    expect(pentestResult.ok).toBe(true);
    expect(pentestResult.data).toEqual(expect.objectContaining({
      warning: expect.stringContaining('Zero findings filed'),
    }));

    const complianceSession = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-compliance',
          reportFindingCount: 0,
          workflowDiscipline: 'compliance',
        },
      },
      scopeId: 'scope-1',
    });
    reportNoteMock.mockResolvedValueOnce({ created: true, noteId: 'note-compliance' });

    const complianceResult = await ReportNote.run(
      {
        ntype: 'run.digest',
        title: 'Run digest',
        data: { workflowDiscipline: 'compliance', goal: 'Assess SOC 2 readiness', outcome: 'completed' },
      },
      makeContext({
        sessionId: complianceSession.id,
        workspaceDir: complianceSession.workspaceDir,
        flags: complianceSession.flags ?? {},
      }),
    );

    expect(complianceResult.ok).toBe(true);
    expect(complianceResult.data).not.toEqual(expect.objectContaining({
      warning: expect.stringContaining('Zero findings filed'),
    }));
    expect(reportNoteMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({ workflowDiscipline: 'compliance' }),
        }),
      }),
    );
  });

  it('records finding ids on session flags after a successful report_finding call', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });

    reportFindingMock.mockResolvedValueOnce({
      findingId: 'finding-1',
      created: true,
      dedupeKey: 'dedupe-1',
    });

    const result = await ReportFinding.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Cross-tenant IDOR',
        severity: 'high',
        summary: 'User A can access User B records.',
        businessImpact: 'An attacker can exfiltrate other tenant data.',
        technicalAnalysis: 'The handler accepts arbitrary user ids without ownership checks.',
        pocDescription: 'Authenticate as user A, then request user B data by id.',
        pocScriptCode: 'curl https://api.example.com/users/42',
        assumptions: 'Attacker holds a valid low-privilege account.',
        fixEffort: 'medium',
        remediation: 'Enforce ownership checks on object fetches.',
        cvss: {
          attackVector: 'N',
          attackComplexity: 'L',
          privilegesRequired: 'L',
          userInteraction: 'N',
          scope: 'U',
          confidentiality: 'H',
          integrity: 'L',
          availability: 'N',
        },
        cweIds: ['CWE-639'],
        evidence: [
          {
            kind: 'http',
            request: {
              method: 'GET',
              url: 'https://api.example.com/users/42',
            },
            response: {
              statusCode: 200,
              body: '{"id":42}',
            },
          },
        ],
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(reportFindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        workerTasks: expect.any(Array),
      }),
    );

    const updated = store.get(session.id)!;
    const securityops = updated.flags?.securityops as Record<string, unknown>;
    expect(securityops.reportedFindingIds).toEqual(['finding-1']);
    expect(securityops.reportFindingCount).toBe(1);
    expect(securityops.candidateFindingIds).toEqual(['finding-1']);
    expect(securityops.candidateFindingCount).toBe(1);
    expect(securityops.lastReportedFindingId).toBe('finding-1');
  });

  it('rejects report_finding when a markdown field contains a broken mermaid diagram', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: { securityops: { organizationId: 'org-1', runId: 'run-1' } },
      scopeId: 'scope-1',
    });

    const result = await ReportFinding.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Cross-tenant IDOR',
        severity: 'high',
        summary: 'User A can access User B records.',
        businessImpact: 'An attacker can exfiltrate other tenant data.',
        technicalAnalysis: [
          'The handler accepts arbitrary user ids without ownership checks.',
          '',
          '```mermaid',
          'graph TD',
          '  A--->>BROKEN[',
          '```',
        ].join('\n'),
        pocDescription: 'Authenticate as user A, then request user B data by id.',
        pocScriptCode: 'curl https://api.example.com/users/42',
        assumptions: 'Attacker holds a valid low-privilege account.',
        fixEffort: 'medium',
        remediation: 'Enforce ownership checks on object fetches.',
        cvss: {
          attackVector: 'N',
          attackComplexity: 'L',
          privilegesRequired: 'L',
          userInteraction: 'N',
          scope: 'U',
          confidentiality: 'H',
          integrity: 'L',
          availability: 'N',
        },
        cweIds: ['CWE-639'],
        evidence: [],
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(String((result.data as { error?: string }).error)).toMatch(/Mermaid/);
    expect(String((result.data as { error?: string }).error)).toMatch(/technicalAnalysis/);
    expect(reportFindingMock).not.toHaveBeenCalled();
  });

  it('accepts report_finding when mermaid diagrams in markdown fields are valid', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: { securityops: { organizationId: 'org-1', runId: 'run-1' } },
      scopeId: 'scope-1',
    });

    reportFindingMock.mockResolvedValueOnce({
      findingId: 'finding-2',
      created: true,
      dedupeKey: 'dedupe-2',
    });

    const result = await ReportFinding.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Cross-tenant IDOR',
        severity: 'high',
        summary: 'User A can access User B records.',
        businessImpact: 'An attacker can exfiltrate other tenant data.',
        technicalAnalysis: [
          'Exploit chain:',
          '',
          '```mermaid',
          'sequenceDiagram',
          '  participant Attacker',
          '  participant API',
          '  Attacker->>API: GET /users/42',
          '  API-->>Attacker: 200 OK',
          '```',
        ].join('\n'),
        pocDescription: 'Authenticate as user A, then request user B data by id.',
        pocScriptCode: 'curl https://api.example.com/users/42',
        assumptions: 'Attacker holds a valid low-privilege account.',
        fixEffort: 'medium',
        remediation: 'Enforce ownership checks on object fetches.',
        cvss: {
          attackVector: 'N',
          attackComplexity: 'L',
          privilegesRequired: 'L',
          userInteraction: 'N',
          scope: 'U',
          confidentiality: 'H',
          integrity: 'L',
          availability: 'N',
        },
        cweIds: ['CWE-639'],
        evidence: [],
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(reportFindingMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a report.section note when its content contains a broken mermaid diagram', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: { securityops: { organizationId: 'org-1', runId: 'run-1' } },
      scopeId: 'scope-1',
    });

    const result = await ReportNote.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'report.section',
        data: {
          section: 'technical',
          heading: 'Architecture',
          content: '```mermaid\ngraph TD\n  A--->>B[oops\n```',
          status: 'draft',
        },
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(String((result.data as { error?: string }).error)).toMatch(/Mermaid/);
    expect(reportNoteMock).not.toHaveBeenCalled();
  });

  it('does not validate mermaid for non-report.section notes', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: { securityops: { organizationId: 'org-1', runId: 'run-1' } },
      scopeId: 'scope-1',
    });

    reportNoteMock.mockResolvedValueOnce({ noteId: 'note-1', created: true });

    const result = await ReportNote.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'http.endpoint',
        data: {
          url: 'https://api.example.com/x',
          summary: '```mermaid\nA--->>B[broken but irrelevant\n```',
        },
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(reportNoteMock).toHaveBeenCalledTimes(1);
  });

  it('defaults query_inventory tool calls to compact digest mode', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'planner',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
        },
      },
      scopeId: 'scope-1',
    });
    queryInventoryMock.mockResolvedValueOnce({
      assets: [],
      totalCount: 0,
      leadCount: 0,
    });

    const result = await QueryInventory.run(
      {},
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result).toEqual({
      ok: true,
      data: {
        assets: [],
        totalCount: 0,
        leadCount: 0,
      },
    });
    expect(queryInventoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        context: expect.objectContaining({ organizationId: 'org-1', scopeId: 'scope-1' }),
        input: { mode: 'digest', limit: 100 },
      }),
    );
  });

  it('exposes read-only compliance tools with the current SecurityOps context', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'interactive',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          assistantMode: 'read_only_chat',
        },
      },
      scopeId: 'scope-1',
    });
    queryComplianceReadinessMock.mockResolvedValueOnce({
      frameworks: [],
      selectedFrameworks: [],
      supportedFrameworks: ['soc2'],
    });
    queryComplianceEvidenceMock.mockResolvedValueOnce({
      evidence: [],
      totalCount: 0,
    });
    queryComplianceProofPackageMock.mockResolvedValueOnce({
      framework: { key: 'soc2', label: 'SOC 2', selected: true },
      control: { id: 'CC6.1', verdict: 'pass', outcome: 'passed' },
      checks: [],
    });
    queryComplianceMissingEvidenceMock.mockResolvedValueOnce({
      missing: [],
      totalCount: 0,
    });
    const ctx = makeContext({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      flags: session.flags ?? {},
    });

    await expect(QueryComplianceReadiness.run({ framework: 'soc2' }, ctx)).resolves.toMatchObject({
      ok: true,
    });
    await expect(QueryComplianceEvidence.run({ framework: 'soc2', status: 'approved' }, ctx)).resolves.toMatchObject({
      ok: true,
    });
    await expect(QueryComplianceProofPackage.run({ framework: 'soc2', controlId: 'CC6.1' }, ctx)).resolves.toMatchObject({
      ok: true,
    });
    await expect(QueryComplianceMissingEvidence.run({ framework: 'soc2' }, ctx)).resolves.toMatchObject({
      ok: true,
    });

    expect(queryComplianceReadinessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        context: expect.objectContaining({ organizationId: 'org-1', scopeId: 'scope-1' }),
        input: { framework: 'soc2' },
      }),
    );
    expect(queryComplianceEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        context: expect.objectContaining({ organizationId: 'org-1', scopeId: 'scope-1' }),
        input: { framework: 'soc2', status: 'approved' },
      }),
    );
    expect(queryComplianceProofPackageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        context: expect.objectContaining({ organizationId: 'org-1', scopeId: 'scope-1' }),
        input: { framework: 'soc2', controlId: 'CC6.1' },
      }),
    );
    expect(queryComplianceMissingEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        context: expect.objectContaining({ organizationId: 'org-1', scopeId: 'scope-1' }),
        input: { framework: 'soc2' },
      }),
    );
  });

  it('records a compliance control check with the current run context', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });
    recordControlCheckMock.mockResolvedValueOnce({
      checkId: 'check-1',
      created: true,
      verdict: 'pass',
      freshUntil: '2026-09-20T00:00:00.000Z',
    });
    const input = {
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      verdict: 'pass',
      reasonCode: 'control_operating',
      reason: 'Unauthorized requests were denied across the tested endpoint set.',
      proofObligationId: 'soc2-cc6.1-authz-v1',
      evidenceRefs: ['.artifacts/authz-proof.json'],
      targetRef: 'https://app.example.com/api/admin',
      method: 'HTTP differential replay',
      proof: {
        claim: 'Unauthorized identities cannot access protected resources.',
        evidenceIds: ['.artifacts/authz-proof.json'],
        replayAttempted: true,
        replayArtifact: '.artifacts/authz-proof.json',
        replayReproduced: true,
      },
    };

    const result = await RecordControlCheck.run(input, makeContext({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      flags: session.flags ?? {},
    }));

    expect(result).toMatchObject({ ok: true, data: { checkId: 'check-1', created: true } });
    expect(recordControlCheckMock).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceDir: session.workspaceDir,
      sessionId: session.id,
      context: expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      }),
      input,
    });
  });

  it('records and reviews compliance control requests with the current run context', async () => {
    expect(RecordControlRequest.meta.schema.required).toEqual(expect.arrayContaining(['requestedEvidence']));

    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });
    const requestInput = {
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      requestType: 'evidence',
      title: 'Upload access review export',
      reason: 'The agent needs the current access review export to review this control.',
      requestedEvidence: ['current access review export'],
    };
    recordControlRequestMock.mockResolvedValueOnce({
      requestId: '00000000-0000-4000-8000-000000000001',
      created: true,
      status: 'open',
    });
    reviewControlRequestMock.mockResolvedValueOnce({
      requestId: '00000000-0000-4000-8000-000000000001',
      status: 'reviewed',
      controlCheckId: '00000000-0000-4000-8000-000000000002',
      nextReverificationAt: '2026-09-20T00:00:00.000Z',
    });

    await expect(RecordControlRequest.run(requestInput, makeContext({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      flags: session.flags ?? {},
    }))).resolves.toMatchObject({
      ok: true,
      data: { requestId: '00000000-0000-4000-8000-000000000001', status: 'open' },
    });
    const reviewInput = {
      requestId: '00000000-0000-4000-8000-000000000001',
      outcome: 'reviewed',
      controlCheckId: '00000000-0000-4000-8000-000000000002',
      note: 'The uploaded evidence was reviewed and supports the selected control period.',
    };
    await expect(ReviewControlRequest.run(reviewInput, makeContext({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      flags: session.flags ?? {},
    }))).resolves.toMatchObject({
      ok: true,
      data: { status: 'reviewed' },
    });

    expect(recordControlRequestMock).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: session.id,
      context: expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      }),
      input: requestInput,
    });
    expect(reviewControlRequestMock).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: session.id,
      context: expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      }),
      input: reviewInput,
    });
  });

  it('ingests a supported scanner artifact through SecurityOps service', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });

    await fs.mkdir(path.join(session.workspaceDir, '.artifacts'), { recursive: true });
    await fs.writeFile(
      path.join(session.workspaceDir, '.artifacts', 'httpx.jsonl'),
      '{"url":"https://api.example.com","port":443}\n',
      'utf8',
    );

    ingestScanArtifactMock.mockResolvedValueOnce({
      parser: 'httpx',
      artifactPath: '.artifacts/httpx.jsonl',
      assetsCreated: 1,
      assetsTouched: 0,
      servicesCreated: 1,
      servicesTouched: 0,
      endpointNotesCreated: 1,
      endpointNotesTouched: 0,
      techNotesCreated: 1,
      techNotesTouched: 0,
      skipped: 0,
    });

    const result = await IngestScanArtifact.run(
      {
        parser: 'httpx',
        artifactPath: '.artifacts/httpx.jsonl',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(ingestScanArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        input: {
          parser: 'httpx',
          artifactPath: '.artifacts/httpx.jsonl',
        },
      }),
    );

    const updated = store.get(session.id)!;
    const progress = (updated.flags?.securityops as Record<string, any>)?.inventoryProgress;
    expect(progress?.ingestedParsers).toEqual(['httpx']);
    expect(progress?.servicesCreated).toBe(1);
    expect(progress?.lastUpdatedAt).toEqual(expect.any(String));
  });

  it('hydrates a runner-backed scanner artifact into the local workspace before ingest', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          executionTarget: 'scope_runner',
          runnerId: 'runner-1',
        },
      },
      scopeId: 'scope-1',
    });

    const remoteContent = Buffer.from('{"url":"https://api.example.com/login","port":443}\n', 'utf8');
    const sandbox = {
      statFile: vi.fn(async (_session: unknown, targetPath: string) => ({
        exists: targetPath === '/workspace/.artifacts/httpx.jsonl',
        isFile: targetPath === '/workspace/.artifacts/httpx.jsonl',
        sizeBytes: remoteContent.byteLength,
        mtimeMs: 0,
      })),
      readFile: vi.fn(async (_session: unknown, targetPath: string) => {
        if (targetPath !== '/workspace/.artifacts/httpx.jsonl') {
          throw new Error(`missing:${targetPath}`);
        }
        return remoteContent;
      }),
    } as any;

    ingestScanArtifactMock.mockResolvedValueOnce({
      parser: 'httpx',
      artifactPath: '.artifacts/httpx.jsonl',
      assetsCreated: 1,
      assetsTouched: 0,
      servicesCreated: 1,
      servicesTouched: 0,
      endpointNotesCreated: 1,
      endpointNotesTouched: 0,
      techNotesCreated: 1,
      techNotesTouched: 0,
      skipped: 0,
    });

    const result = await IngestScanArtifact.run(
      {
        parser: 'httpx',
        artifactPath: '/workspace/.artifacts/httpx.jsonl',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        sandbox,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(
      (sandbox.statFile as any).mock.calls.some(
        ([sessionArg, targetPath]: [any, string]) =>
          sessionArg?.id === session.id && targetPath === '/workspace/.artifacts/httpx.jsonl',
      ),
    ).toBe(true);
    expect(
      (sandbox.readFile as any).mock.calls.some(
        ([sessionArg, targetPath]: [any, string]) =>
          sessionArg?.id === session.id && targetPath === '/workspace/.artifacts/httpx.jsonl',
      ),
    ).toBe(true);

    const localArtifact = await fs.readFile(
      path.join(session.workspaceDir, '.artifacts', 'httpx.jsonl'),
      'utf8',
    );
    expect(localArtifact).toContain('api.example.com');
  });

  it('hydrates a container-backed scanner artifact before ingest without a scope runner binding', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });

    const remoteContent = Buffer.from('{"url":"https://api.example.com","port":443}\n', 'utf8');
    const sandbox = {
      statFile: vi.fn(async (_session: unknown, targetPath: string) => ({
        exists: targetPath === '/workspace/.artifacts/httpx-container.jsonl',
        isFile: targetPath === '/workspace/.artifacts/httpx-container.jsonl',
        sizeBytes: remoteContent.byteLength,
        mtimeMs: 0,
      })),
      readFile: vi.fn(async (_session: unknown, targetPath: string) => {
        if (targetPath !== '/workspace/.artifacts/httpx-container.jsonl') {
          throw new Error(`missing:${targetPath}`);
        }
        return remoteContent;
      }),
    } as any;

    ingestScanArtifactMock.mockResolvedValueOnce({
      parser: 'httpx',
      artifactPath: '.artifacts/httpx-container.jsonl',
      assetsCreated: 1,
      assetsTouched: 0,
      servicesCreated: 1,
      servicesTouched: 0,
      endpointNotesCreated: 1,
      endpointNotesTouched: 0,
      techNotesCreated: 0,
      techNotesTouched: 0,
      skipped: 0,
    });

    const result = await IngestScanArtifact.run(
      {
        parser: 'httpx',
        artifactPath: '/workspace/.artifacts/httpx-container.jsonl',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        sandbox,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(sandbox.readFile).toHaveBeenCalledWith(session, '/workspace/.artifacts/httpx-container.jsonl');
    await expect(
      fs.readFile(path.join(session.workspaceDir, '.artifacts', 'httpx-container.jsonl'), 'utf8'),
    ).resolves.toContain('api.example.com');
  });

  it('tracks unresolved ingest failures until the same parser succeeds', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });

    const failingSandbox = {
      statFile: vi.fn(async () => ({
        exists: false,
        isFile: false,
        sizeBytes: 0,
        mtimeMs: 0,
      })),
      readFile: vi.fn(async () => {
        throw new Error('missing artifact');
      }),
    } as any;

    const failed = await IngestScanArtifact.run(
      {
        parser: 'httpx',
        artifactPath: '/workspace/.artifacts/httpx-retry.jsonl',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        sandbox: failingSandbox,
        flags: session.flags ?? {},
      }),
    );

    expect(failed.ok).toBe(false);
    let updated = store.get(session.id)!;
    let progress = (updated.flags?.securityops as Record<string, any>)?.inventoryProgress;
    expect(progress?.failedIngestParsers).toEqual(['httpx']);
    expect(progress?.unresolvedIngestFailureCount).toBe(1);
    expect(progress?.lastIngestError).toContain('Unable to hydrate workspace file');

    await fs.mkdir(path.join(session.workspaceDir, '.artifacts'), { recursive: true });
    await fs.writeFile(
      path.join(session.workspaceDir, '.artifacts', 'httpx-retry.jsonl'),
      '{"url":"https://api.example.com","port":443}\n',
      'utf8',
    );
    ingestScanArtifactMock.mockResolvedValueOnce({
      parser: 'httpx',
      artifactPath: '.artifacts/httpx-retry.jsonl',
      assetsCreated: 1,
      assetsTouched: 0,
      servicesCreated: 1,
      servicesTouched: 0,
      endpointNotesCreated: 1,
      endpointNotesTouched: 0,
      techNotesCreated: 0,
      techNotesTouched: 0,
      skipped: 0,
    });

    const succeeded = await IngestScanArtifact.run(
      {
        parser: 'httpx',
        artifactPath: '/workspace/.artifacts/httpx-retry.jsonl',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        sandbox: {
          statFile: vi.fn(),
          readFile: vi.fn(),
        } as any,
        flags: session.flags ?? {},
      }),
    );

    expect(succeeded.ok).toBe(true);
    updated = store.get(session.id)!;
    progress = (updated.flags?.securityops as Record<string, any>)?.inventoryProgress;
    expect(progress?.failedIngestParsers).toEqual([]);
    expect(progress?.unresolvedIngestFailureCount).toBe(0);
    expect(progress?.lastIngestError).toBeUndefined();
    expect(progress?.lastIngestFailureParser).toBeUndefined();
  });

  it('hydrates runner-backed evidence files before report_service persists canonical service inventory', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          executionTarget: 'scope_runner',
          runnerId: 'runner-1',
        },
      },
      scopeId: 'scope-1',
    });

    const remoteContent = Buffer.from('api.example.com:8443\n', 'utf8');
    const sandbox = {
      statFile: vi.fn(async (_session: unknown, targetPath: string) => ({
        exists: targetPath === '/workspace/.artifacts/broad/ports.txt',
        isFile: targetPath === '/workspace/.artifacts/broad/ports.txt',
        sizeBytes: remoteContent.byteLength,
        mtimeMs: 0,
      })),
      readFile: vi.fn(async (_session: unknown, targetPath: string) => {
        if (targetPath !== '/workspace/.artifacts/broad/ports.txt') {
          throw new Error(`missing:${targetPath}`);
        }
        return remoteContent;
      }),
    } as any;

    reportServiceMock.mockResolvedValueOnce({
      serviceId: 'service-1',
      created: true,
    });

    const result = await ReportService.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        protocol: 'https',
        port: 8443,
        evidence: [
          {
            path: '/workspace/.artifacts/broad/ports.txt',
            label: 'naabu artifact',
          },
        ],
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        sandbox,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(reportServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        input: expect.objectContaining({
          evidence: [
            expect.objectContaining({
              path: '/workspace/.artifacts/broad/ports.txt',
              label: 'naabu artifact',
            }),
          ],
        }),
      }),
    );
    expect(
      (sandbox.readFile as any).mock.calls.some(
        ([sessionArg, targetPath]: [any, string]) =>
          sessionArg?.id === session.id && targetPath === '/workspace/.artifacts/broad/ports.txt',
      ),
    ).toBe(true);

    const localArtifact = await fs.readFile(
      path.join(session.workspaceDir, '.artifacts', 'broad', 'ports.txt'),
      'utf8',
    );
    expect(localArtifact).toContain('api.example.com:8443');

    const updated = store.get(session.id)!;
    const progress = (updated.flags?.securityops as Record<string, any>)?.inventoryProgress;
    expect(progress?.servicesCreated).toBe(1);
  });

  it('downgrades completed scan coverage when scanner jobs are still active', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
        shellJobs: {
          'shelljob-1': {
            jobId: 'shelljob-1',
            command: 'katana -u https://api.example.com -o /workspace/.artifacts/katana.txt',
            status: 'running',
            commandFinished: false,
          },
        },
      },
      scopeId: 'scope-1',
    });
    reportNoteMock.mockResolvedValueOnce({
      noteId: 'note-1',
      created: true,
    });

    const result = await ReportNote.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'scan.coverage',
        title: 'Broad surface scan completed',
        data: {
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          toolset: ['katana'],
        },
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      warning: expect.stringContaining('downgraded to blocked'),
    });
    expect(reportNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({
            status: 'blocked',
            reason: expect.stringContaining('shelljob-1'),
          }),
        }),
      }),
    );
  });

  it('does not downgrade scan coverage for an unrelated active scanner target', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
        shellJobs: {
          'shelljob-1': {
            jobId: 'shelljob-1',
            command: 'katana -u https://other.example.com -o /workspace/.artifacts/katana.txt',
            status: 'running',
            commandFinished: false,
          },
        },
      },
      scopeId: 'scope-1',
    });
    reportNoteMock.mockResolvedValueOnce({
      noteId: 'note-1',
      created: true,
    });

    const result = await ReportNote.run(
      {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'scan.coverage',
        title: 'Broad surface scan completed',
        data: {
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          toolset: ['katana'],
        },
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.data).not.toMatchObject({
      warning: expect.any(String),
    });
    expect(reportNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({
            status: 'completed',
          }),
        }),
      }),
    );
  });

  it('moves promoted findings from candidate to reportable flags', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          candidateFindingIds: ['finding-1'],
          candidateFindingCount: 1,
          reportedFindingIds: ['finding-1'],
        },
      },
      scopeId: 'scope-1',
    });

    promoteFindingMock.mockResolvedValueOnce({
      findingId: 'finding-1',
      promoted: true,
      state: 'confirmed',
      lifecycleStage: 'reportable',
      dedupeKey: 'dedupe-1',
    });

    const result = await PromoteFinding.run(
      {
        findingId: 'finding-1',
        rationale: 'HTTP request and response demonstrate the issue.',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(promoteFindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        input: expect.objectContaining({ findingId: 'finding-1' }),
      }),
    );

    const updated = store.get(session.id)!;
    const securityops = updated.flags?.securityops as Record<string, unknown>;
    expect(securityops.candidateFindingIds).toEqual([]);
    expect(securityops.candidateFindingCount).toBe(0);
    expect(securityops.reportableFindingIds).toEqual(['finding-1']);
    expect(securityops.reportableFindingCount).toBe(1);
    expect(securityops.lastPromotedFindingId).toBe('finding-1');
  });

  it('queues promoted under-review findings into the validation phase instead of spawning a worker', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          candidateFindingIds: ['finding-1'],
          candidateFindingCount: 1,
          reportedFindingIds: ['finding-1'],
        },
      },
      scopeId: 'scope-1',
    });
    promoteFindingMock.mockResolvedValueOnce({
      findingId: 'finding-1',
      promoted: false,
      validationPending: true,
      state: 'verifying',
      lifecycleStage: 'candidate',
      dedupeKey: 'dedupe-1',
      durableEvidenceCount: 1,
    });
    phaseListByRunIdMock.mockResolvedValueOnce([
      {
        id: 'phase-validation',
        phaseKey: 'validation',
        status: 'pending',
      },
    ]);
    validationQueueEnqueueMock.mockResolvedValueOnce({
      id: 'queue-1',
      runId: 'run-1',
      findingId: 'finding-1',
      phaseId: 'phase-validation',
      status: 'queued',
    });
    const spawnWorker = vi.fn().mockResolvedValue({
      task: { taskId: 'task-worker', status: 'running' },
      sessionId: 'worker-session',
    });

    const result = await PromoteFinding.run(
      {
        findingId: 'finding-1',
        rationale: 'Durable HTTP exchange demonstrates the issue.',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
        workers: { spawnWorker } as any,
      }),
    );

    expect(result.ok).toBe(true);
    expect(validationQueueEnqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        phaseId: 'phase-validation',
        findingId: 'finding-1',
        requestedBySessionId: session.id,
      }),
    );
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        validationQueue: expect.objectContaining({
          queued: true,
          queueId: 'queue-1',
          validationPhaseId: 'phase-validation',
        }),
      }),
    );
  });

  it('allows validation phase sessions to submit validation outcomes and closes the queue item', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
          validationQueueFindingIds: ['finding-1'],
        },
      },
      scopeId: 'scope-1',
    });
    submitValidationOutcomeMock.mockResolvedValueOnce({
      findingId: 'finding-1',
      outcome: 'validated',
      promoted: true,
      alreadyReportable: false,
      state: 'confirmed',
      lifecycleStage: 'reportable',
      dedupeKey: 'dedupe-1',
      durableEvidenceCount: 2,
      workerEvidenceCount: 1,
    });
    validationQueueCompleteFindingMock.mockResolvedValueOnce({
      id: 'queue-1',
      status: 'validated',
    });

    const result = await SubmitValidationOutcome.run(
      {
        findingId: 'finding-1',
        outcome: 'validated',
        reason: 'Fresh request reproduced cross-tenant access.',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(submitValidationOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        input: expect.objectContaining({ findingId: 'finding-1', outcome: 'validated' }),
      }),
    );
    expect(validationQueueCompleteFindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        findingId: 'finding-1',
        outcome: 'validated',
        sessionId: session.id,
      }),
    );
    expect(store.get(session.id)?.completed).not.toBe(true);
  });

  it('treats validator_worker submit_validation_outcome as terminal and idempotent', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'validator_worker',
        expectedArtifactType: 'validation_outcome',
      },
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
        },
      },
      scopeId: 'scope-1',
    });
    submitValidationOutcomeMock.mockResolvedValueOnce({
      findingId: 'finding-1',
      outcome: 'validated',
      promoted: true,
      alreadyReportable: false,
      state: 'confirmed',
      lifecycleStage: 'reportable',
      dedupeKey: 'dedupe-1',
      durableEvidenceCount: 2,
      workerEvidenceCount: 1,
    });
    validationQueueCompleteFindingMock.mockResolvedValueOnce({
      id: 'queue-1',
      status: 'validated',
    });
    const ctx = makeContext({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      flags: session.flags ?? {},
    });

    const first = await SubmitValidationOutcome.run(
      {
        findingId: 'finding-1',
        outcome: 'validated',
        reason: 'Fresh request reproduced cross-tenant access.',
      },
      ctx,
    );
    const second = await SubmitValidationOutcome.run(
      {
        findingId: 'finding-1',
        outcome: 'validated',
        reason: 'duplicate call',
      },
      ctx,
    );

    expect(first.ok).toBe(true);
    const updated = store.get(session.id)!;
    expect(updated.completed).toBe(true);
    expect((updated.flags.session as Record<string, unknown> | undefined)?.completed).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.data).toEqual(
      expect.objectContaining({
        alreadySubmitted: true,
        terminal: true,
        nextAction: 'stop',
      }),
    );
    expect(submitValidationOutcomeMock).toHaveBeenCalledTimes(1);
  });

  it('allows validation phase sessions to close rendered validation leads', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
        },
      },
      scopeId: 'scope-1',
    });
    submitValidationLeadOutcomeMock.mockResolvedValueOnce({
      leadId: '11111111-1111-4111-8111-111111111111',
      outcome: 'false_positive',
      requestedOutcome: 'false_positive',
      promptSha256: 'a'.repeat(64),
      attempts: 0,
      autoDeferred: false,
      remainingOpenLeadIds: [],
    });

    const result = await SubmitValidationLeadOutcome.run(
      {
        leadId: '11111111-1111-4111-8111-111111111111',
        outcome: 'false_positive',
        observations: [{ technique: 'paired request', result: 'contradicted' }],
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(submitValidationLeadOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          leadId: '11111111-1111-4111-8111-111111111111',
          outcome: 'false_positive',
        }),
      }),
    );
    expect((submitValidationLeadOutcomeMock.mock.calls[0]?.[0] as any).input).not.toHaveProperty('promptSha256');
  });

  it('rejects rendered validation lead outcome outside validation contexts', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseKey: 'recon',
        },
      },
      scopeId: 'scope-1',
    });

    const result = await SubmitValidationLeadOutcome.run(
      {
        leadId: '11111111-1111-4111-8111-111111111111',
        promptSha256: 'a'.repeat(64),
        outcome: 'blocked',
        blockerCode: 'needs-auth',
      },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('submit_validation_lead_outcome is restricted'),
      }),
    );
    expect(submitValidationLeadOutcomeMock).not.toHaveBeenCalled();
  });

  it('prepares report context from canonical run state', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          reportedFindingIds: ['finding-1'],
        },
      },
      scopeId: 'scope-1',
    });
    session.plan = [{ id: 'task-final', title: 'Write report', status: 'running' }];
    await store.setAsync(session.id, session, 'test.plan');

    prepareReportContextMock.mockResolvedValueOnce({
      detail: 'brief',
      contextPath: `${session.workspaceDir}/.artifacts/report/context.json`,
      briefPath: `${session.workspaceDir}/.artifacts/report/brief.md`,
      runCompletion: {
        state: 'ready_for_finalization',
        ready: true,
        reasons: ['all plan steps completed and no promotable candidates remain'],
        incompletePlanSteps: [],
        unresolvedPromotableFindings: [],
        finalized: false,
      },
      findingCount: 1,
      reportableFindingCount: 1,
      candidateFindingCount: 0,
      recommendedSections: ['executive-summary', 'findings-narrative'],
    });

    const result = await PrepareReportContext.run(
      { detail: 'brief' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(prepareReportContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        plan: session.plan,
        reportedFindingIds: ['finding-1'],
      }),
    );
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        detail: 'brief',
        contextPath: '/workspace/.artifacts/report/context.json',
        briefPath: '/workspace/.artifacts/report/brief.md',
        runCompletionState: 'ready_for_finalization',
        findingCount: 1,
        reportableFindingCount: 1,
        candidateFindingCount: 0,
        recommendedSections: ['executive-summary', 'findings-narrative'],
      }),
    );
  });

  it('records report finalizer preflight before report drafting', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          reportedFindingIds: ['finding-1'],
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
        },
        shellJobs: {
          'shelljob-1': { status: 'completed' },
        },
      },
      scopeId: 'scope-1',
    });
    session.plan = [{ id: 'task-final', title: 'Write report', status: 'running' }];
    await store.setAsync(session.id, session, 'test.plan');

    reportFinalizerPreflightMock.mockResolvedValueOnce({
      generatedAt: '2026-05-26T00:00:00.000Z',
      preflightPath: `${session.workspaceDir}/.artifacts/report/finalizer-preflight.json`,
      canFinalizeFinal: false,
      canFinalizeInterim: true,
      requiredMode: 'interim',
      intendedMode: 'interim',
      runCompletion: {
        state: 'not_ready',
        ready: false,
        reasons: ['1 finding candidate(s) have durable evidence but are not promoted'],
        incompletePlanSteps: [],
        unresolvedPromotableFindings: [
          { id: 'finding-1', title: 'Candidate finding', severity: 'high' },
        ],
        finalized: false,
      },
      findingCount: 1,
      candidateCount: 1,
      reportableCount: 0,
      validatingCount: 0,
      unpromotedCandidateBlockers: [
        { id: 'finding-1', title: 'Candidate finding', severity: 'high' },
      ],
      missingDurableEvidenceBlockers: [],
      finalizerBlockers: ['1 finding candidate(s) have durable evidence but are not promoted'],
      complianceBoundarySentence:
        'Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.',
      exportExpectations: {
        summaryPath: 'summary.md',
        reportPath: 'report.md',
        validationPath: '.artifacts/report/validation.json',
        contextPath: '.artifacts/report/context.json',
        preflightPath: '.artifacts/report/finalizer-preflight.json',
      },
      authoredArtifactCheck: { checked: false },
    });

    const result = await ReportFinalizerPreflight.run(
      {},
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(reportFinalizerPreflightMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        plan: session.plan,
        reportedFindingIds: ['finding-1'],
        shellJobs: { 'shelljob-1': { status: 'completed' } },
        alreadyFinalized: false,
      }),
    );
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        preflightPath: '/workspace/.artifacts/report/finalizer-preflight.json',
        canFinalizeFinal: false,
        canFinalizeInterim: true,
        requiredMode: 'interim',
        runCompletionState: 'not_ready',
        candidateCount: 1,
        reportableCount: 0,
        unpromotedCandidateBlockerCount: 1,
        complianceBoundarySentence:
          'Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.',
      }),
    );

    const updated = store.get(session.id)!;
    const securityops = updated.flags?.securityops as Record<string, unknown>;
    expect(securityops.runCompletion).toEqual(expect.objectContaining({ state: 'not_ready' }));
    expect(securityops.reportFinalizerPreflight).toEqual(
      expect.objectContaining({
        canFinalizeFinal: false,
        requiredMode: 'interim',
        runCompletionState: 'not_ready',
        blockerCount: 1,
      }),
    );
  });

  it('records RunCompletion after finalize_run_artifacts succeeds', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          reportedFindingIds: ['finding-1'],
          reportableFindingIds: ['finding-1'],
          reportableFindingCount: 1,
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: true,
        },
      },
      scopeId: 'scope-1',
    });
    session.plan = [{ id: 'task-1', title: 'Validate finding', status: 'completed' }];
    await store.setAsync(session.id, session, 'test.plan');

    finalizeRunArtifactsMock.mockResolvedValueOnce({
      mode: 'final',
      summaryPath: `${session.workspaceDir}/summary.md`,
      reportPath: `${session.workspaceDir}/report.md`,
      runCompletion: {
        state: 'completed',
        ready: false,
        reasons: ['finalize_run_artifacts completed successfully'],
        incompletePlanSteps: [],
        unresolvedPromotableFindings: [],
        finalized: true,
      },
      findingCount: 1,
      reportableFindingCount: 1,
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'final' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(finalizeRunArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        plan: session.plan,
        reportedFindingIds: ['finding-1'],
        alreadyFinalized: false,
      }),
    );

    const updated = store.get(session.id)!;
    const securityops = updated.flags?.securityops as Record<string, unknown>;
    expect(updated.completed).toBe(true);
    expect((updated.flags.session as Record<string, unknown> | undefined)?.completed).toBe(true);
    expect(securityops.runCompletion).toEqual(
      expect.objectContaining({ state: 'completed', finalized: true }),
    );
    expect(securityops.finalizedMode).toBe('final');
    expect(typeof securityops.artifactsFinalizedAt).toBe('string');
    expect(typeof securityops.finalizedAt).toBe('string');
    expect(phaseUpdateStatusMock).toHaveBeenCalledWith({
      phaseId: 'phase-reporting',
      status: 'completed',
    });
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        mode: 'final',
        summaryPath: '/workspace/summary.md',
        reportPath: '/workspace/report.md',
        runCompletionState: 'completed',
        finalized: true,
        findingCount: 1,
        reportableFindingCount: 1,
        warningCount: 0,
      }),
    );
  });

  it('finalize_run_artifacts is idempotent after run completion is recorded on session flags', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: true,
          finalizedMode: 'interim',
          artifactsFinalizedAt: '2026-05-28T00:00:00.000Z',
          runCompletion: {
            state: 'completed',
            finalized: true,
          },
        },
      },
      scopeId: 'scope-1',
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'interim', reason: 'duplicate call' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        alreadySubmitted: true,
        terminal: true,
        finalized: true,
        mode: 'interim',
        runCompletionState: 'completed',
        nextAction: 'stop',
      }),
    );
    expect(finalizeRunArtifactsMock).not.toHaveBeenCalled();
  });

  it('passes report-only run identity from session securityops flags when context flags are empty', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-report-only',
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: true,
        },
      },
      scopeId: 'scope-1',
    });

    finalizeRunArtifactsMock.mockResolvedValueOnce({
      mode: 'final',
      summaryPath: `${session.workspaceDir}/summary.md`,
      reportPath: `${session.workspaceDir}/report.md`,
      runCompletion: {
        state: 'completed',
        ready: false,
        reasons: ['finalize_run_artifacts completed successfully'],
        incompletePlanSteps: [],
        unresolvedPromotableFindings: [],
        finalized: true,
      },
      findingCount: 0,
      reportableFindingCount: 0,
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'final' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(finalizeRunArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-report-only',
        }),
      }),
    );
  });

  it('does not downgrade a completed reporting handoff after interim finalization succeeds', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: true,
          phaseHandoffStatus: 'completed',
        },
      },
      scopeId: 'scope-1',
    });
    session.plan = [{ id: 'task-final', title: 'Write interim report', status: 'completed' }];
    await store.setAsync(session.id, session, 'test.plan');

    finalizeRunArtifactsMock.mockResolvedValueOnce({
      mode: 'interim',
      summaryPath: `${session.workspaceDir}/summary.md`,
      reportPath: `${session.workspaceDir}/report.md`,
      runCompletion: {
        state: 'completed',
        ready: false,
        reasons: [
          'finalize_run_artifacts completed interim closeout',
          'operator credentials are required before final validation',
        ],
        incompletePlanSteps: [],
        unresolvedPromotableFindings: [],
        finalized: true,
      },
      findingCount: 0,
      reportableFindingCount: 0,
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'interim', reason: 'operator credentials required' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(phaseUpdateStatusMock).not.toHaveBeenCalled();
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        mode: 'interim',
        summaryPath: '/workspace/summary.md',
        reportPath: '/workspace/report.md',
        runCompletionState: 'completed',
        finalized: true,
      }),
    );
  });

  it('requires reporting phase handoff before finalizing from a reporting phase session', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: false,
        },
      },
      scopeId: 'scope-1',
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'final' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('requires submit_phase_handoff'),
      }),
    );
    expect(finalizeRunArtifactsMock).not.toHaveBeenCalled();
  });

  it('finalizes when the in-memory handoff flag is lost but the DB recorded the reporting handoff', async () => {
    // Authoritative DB fallback: reporting phase recorded handoff_out_ref even though
    // the in-memory phaseHandoffSubmitted flag was lost across the model-call boundary.
    phaseListByRunIdMock.mockResolvedValueOnce([
      { id: 'phase-enum', phaseKey: 'enumeration', handoffOutRef: '.artifacts/phase-handoffs/enum.json' },
      { id: 'phase-reporting', phaseKey: 'reporting', handoffOutRef: '.artifacts/phase-handoffs/report.json' },
    ]);
    finalizeRunArtifactsMock.mockResolvedValueOnce({
      summaryPath: '/workspace/summary.md',
      reportPath: '/workspace/report.md',
      mode: 'final',
      runCompletionState: 'completed',
      finalized: true,
    });

    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: false,
        },
      },
      scopeId: 'scope-1',
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'final' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(true);
    expect(finalizeRunArtifactsMock).toHaveBeenCalledTimes(1);
    const updated = store.get(session.id)!;
    expect((updated.flags?.securityops as Record<string, unknown>).phaseHandoffSubmitted).toBe(true);
    expect(phaseUpdateStatusMock).toHaveBeenCalledWith({
      phaseId: 'phase-reporting',
      status: 'completed',
    });
  });

  it('still rejects when only a non-reporting phase handed off (stale activePhaseId)', async () => {
    // Stale activePhaseId points at a handed-off enumeration phase; the reporting phase
    // has NOT handed off. The gate must not authorize finalize off the enumeration handoff.
    phaseListByRunIdMock.mockResolvedValueOnce([
      { id: 'phase-enum', phaseKey: 'enumeration', handoffOutRef: '.artifacts/phase-handoffs/enum.json' },
      { id: 'phase-reporting', phaseKey: 'reporting', handoffOutRef: null },
    ]);

    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          activePhaseId: 'phase-enum',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: false,
        },
      },
      scopeId: 'scope-1',
    });

    const result = await FinalizeRunArtifacts.run(
      { mode: 'final' },
      makeContext({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        flags: session.flags ?? {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('requires submit_phase_handoff'),
      }),
    );
    expect(finalizeRunArtifactsMock).not.toHaveBeenCalled();
  });
});

describe('isReportingHandoffRecorded (finalize gate authoritative source)', () => {
  it('accepts when the reporting phase has a handoff_out_ref', () => {
    const phases = [
      { id: 'p-enum', phaseKey: 'enumeration', handoffOutRef: '.artifacts/phase-handoffs/enum.json' },
      { id: 'p-report', phaseKey: 'reporting', handoffOutRef: '.artifacts/phase-handoffs/report.json' },
    ];
    expect(isReportingHandoffRecorded(phases, 'p-report')).toBe(true);
    // Matches by phaseKey even when the active phase id is not supplied.
    expect(isReportingHandoffRecorded(phases)).toBe(true);
  });

  it('rejects when the reporting phase has no handoff_out_ref yet', () => {
    const phases = [
      { id: 'p-report', phaseKey: 'reporting', handoffOutRef: null },
    ];
    expect(isReportingHandoffRecorded(phases, 'p-report')).toBe(false);
    expect(isReportingHandoffRecorded([{ id: 'p-report', phaseKey: 'reporting' }], 'p-report')).toBe(false);
    expect(isReportingHandoffRecorded([{ id: 'p-report', phaseKey: 'reporting', handoffOutRef: '   ' }])).toBe(false);
  });

  it('does not accept a non-reporting phase handoff as the reporting handoff', () => {
    const phases = [
      { id: 'p-enum', phaseKey: 'enumeration', handoffOutRef: '.artifacts/phase-handoffs/enum.json' },
    ];
    // Even when a stale activePhaseId points at the (handed-off) enumeration phase,
    // only a reporting handoff may authorize finalize.
    expect(isReportingHandoffRecorded(phases, 'p-enum')).toBe(false);
    expect(isReportingHandoffRecorded(phases, 'p-report')).toBe(false);
    expect(isReportingHandoffRecorded(phases)).toBe(false);
  });

  it('accepts the lone reporting handoff even when the supplied id is stale or missing', () => {
    const phases = [
      { id: 'p-report-current', phaseKey: 'reporting', handoffOutRef: '.artifacts/phase-handoffs/report.json' },
    ];
    // The flag-loss case: activePhaseId may be stale/absent, but the single reporting
    // phase recorded a handoff, so finalize is authorized.
    expect(isReportingHandoffRecorded(phases, 'p-report-stale')).toBe(true);
    expect(isReportingHandoffRecorded(phases)).toBe(true);
  });

  it('defensively requires an id match only when multiple reporting phases handed off', () => {
    const phases = [
      { id: 'p-report-old', phaseKey: 'reporting', handoffOutRef: '.artifacts/phase-handoffs/old.json' },
      { id: 'p-report-new', phaseKey: 'reporting', handoffOutRef: '.artifacts/phase-handoffs/new.json' },
    ];
    expect(isReportingHandoffRecorded(phases, 'p-report-new')).toBe(true);
    // An older reporting handoff must not authorize the current finalize without a match.
    expect(isReportingHandoffRecorded(phases, 'p-report-unknown')).toBe(false);
    expect(isReportingHandoffRecorded(phases)).toBe(false);
  });
});
