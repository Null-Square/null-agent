import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComplianceReadinessResponse } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';
import { RunReportWorkflowService } from '@/domains/security-ops/tools/reporting/RunReportWorkflowService';

const tempDirs: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'null-ai-report-workflow-'));
  tempDirs.push(workspace);
  await mkdir(join(workspace, '.artifacts', 'report'), { recursive: true });
  return workspace;
};

const baseCoverage = () => ({
  plan: { total: 1, completed: 1, blocked: 0, pending: 0, running: 0, error: 0 },
  missionQuestions: ['What public HTTP surface exists?'],
  missionSkills: ['security-reporting'],
  noteCounts: [],
  testedClasses: [],
  blockers: [],
  openDebts: [],
  runDigest: {
    goal: 'Assess public web surface',
    outcome: 'completed',
    completedTasks: [],
    blockedTasks: [],
    nextPrerequisites: [],
  },
  approaches: [],
  scanCoverage: [],
  endpoints: [],
  technologies: [],
  reportSections: [],
  scannerOutcomes: [],
});

const baseReportState = () => ({
  organizationId: 'org-1',
  scopeId: 'scope-1',
  findings: [],
  notes: [],
  runCompletion: {
    state: 'ready_for_finalization',
    ready: true,
    reasons: ['all plan steps completed and no promotable candidates remain'],
    incompletePlanSteps: [],
    unresolvedPromotableFindings: [],
    finalized: false,
  },
  coverage: baseCoverage(),
});

const makeWorkflow = (
  options: {
    runWorkflowDiscipline?: 'pentest' | 'compliance' | null;
    reportingHandoffRef?: string | null;
    findings?: unknown[];
    unresolvedCoveragePhases?: Array<{
      phaseKey: string;
      status: string;
      stepIds: string[];
      lastError?: string | null;
    }>;
  } = {},
): RunReportWorkflowService => {
  const db = {
    select: vi.fn(() => {
      const rows = options.unresolvedCoveragePhases ?? (options.runWorkflowDiscipline || options.reportingHandoffRef
        ? [{
            workflowDiscipline: options.runWorkflowDiscipline,
            handoffOutRef: options.reportingHandoffRef,
          }]
        : []);
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }),
  };
  const service = new RunReportWorkflowService(db as never, {
    now: () => new Date('2026-06-25T00:00:00.000Z'),
    emitRunSystemEvent: async () => {},
  });
  vi.spyOn(service as unknown as { buildFinalizerReportState: () => Promise<unknown> }, 'buildFinalizerReportState')
    .mockResolvedValue({ ...baseReportState(), findings: options.findings ?? [] });
  vi.spyOn(service as unknown as { markRunCompleted: () => Promise<void> }, 'markRunCompleted')
    .mockResolvedValue(undefined);
  return service;
};

const stubComplianceReadiness = (
  service: RunReportWorkflowService,
  readiness: ComplianceReadinessResponse,
): void => {
  const finalizer = (service as unknown as {
    runReportFinalizer: {
      buildComplianceReadinessForReportContext: (...args: unknown[]) => Promise<ComplianceReadinessResponse>;
      focusComplianceReadinessForReportContext: (
        input: ComplianceReadinessResponse,
        requestedFramework?: string | null,
      ) => ComplianceReadinessResponse;
    };
  }).runReportFinalizer;
  vi.spyOn(finalizer, 'buildComplianceReadinessForReportContext').mockResolvedValue(readiness);
  vi.spyOn(finalizer, 'focusComplianceReadinessForReportContext').mockImplementation(
    (input: ComplianceReadinessResponse) => input,
  );
};

const writePassingComplianceReport = async (workspace: string): Promise<void> => {
  await writeFile(
    join(workspace, 'summary.md'),
    'SOC 2 readiness summary covers the assessed controls, evidence boundary, and closeout result in enough detail.',
    'utf-8',
  );
  await writeFile(
    join(workspace, 'report.md'),
    [
      '# SOC 2 Technical Readiness',
      '',
      COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
      '',
      'This run assessed 0/0 direct control checks because this unit test only validates closeout context persistence.',
      'Overall framework readiness: denominator 1; 0 need action; 0 not checked.',
      '',
      'The report body is intentionally concise but long enough for authored report validation. It explains that the',
      'backend compliance context is the source of truth and that the closeout bundle must carry a durable point-in-time',
      'snapshot even when the agent did not explicitly prepare the report context before finalization. '.repeat(3),
    ].join('\n'),
    'utf-8',
  );
};

const complianceReadiness = (): ComplianceReadinessResponse => ({
  generatedAt: '2026-06-25T00:00:00.000Z',
  organizationId: 'org-1',
  scopeId: 'scope-1',
  runId: 'run-1',
  selectedFrameworks: [{ key: 'soc2', label: 'SOC 2 Technical Readiness', sources: ['organization_profile'] }],
  supportedFrameworks: ['soc2'],
  latestCompletedRunId: 'run-1',
  scorecards: {
    agentProvenTechnical: { total: 1, passed: 1, failed: 0, needsContext: 0, notAttempted: 0, stale: 0 },
    customerEvidence: { total: 0, approved: 0, missing: 0, stale: 0, integrationRequired: 0, acceptedRisk: 0 },
    outcomes: { passed: 1, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
  },
  reviewSummary: {
    total: 0,
    unreviewed: 0,
    confirmed: 0,
    rejected: 0,
    retestRequired: 0,
  },
  reportRequest: {
    canStart: true,
    scopeId: 'scope-1',
    latestCompletedRunId: 'run-1',
    reason: null,
  },
  frameworks: [
    {
      key: 'soc2',
      label: 'SOC 2 Technical Readiness',
      selected: true,
      supported: true,
      score: 100,
      statusCounts: {
        passing: 1,
        partial: 0,
        failing: 0,
        missing: 0,
        stale: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 0,
      },
      outcomeCounts: { passed: 1, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
      verdictCounts: {
        pass: 1,
        fail: 0,
        needs_context: 0,
        not_attempted: 0,
        accepted_risk: 0,
        needs_evidence: 0,
        not_applicable: 0,
        not_supported: 0,
      },
      controls: [
        {
          id: 'CC6.7',
          title: 'Transmission security and encryption',
          theme: 'Logical and Physical Access Controls',
          supportLevel: 'automated_testable',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          reasonCode: 'control_operating',
          basis: 'agent_tested',
          verdictReason: 'TLS 1.3 is enforced and HSTS is not set.',
          score: 100,
          rationale: 'Transport encryption was verified with HTTP evidence.',
          evidence: [],
          gaps: [],
          coverageLimitations: ['HSTS header is not present.'],
          catalogRef: 'soc2:CC6.7',
          proofObligation: { id: 'soc2-cc6.7-transport-encryption-v1', statement: 'Verify encrypted transport.' },
          requiredEvidence: [],
          nextAction: 'Add HSTS as a hardening improvement.',
          evidenceFreshness: { freshestAt: '2026-06-25T00:00:00.000Z', stale: false },
          monitoring: { state: 'monitored', source: 'default', exclusionReason: null, updatedAt: null },
          assignment: { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
          actionRequests: [],
          controlChecks: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              basis: 'agent_tested',
              verdict: 'pass',
              reasonCode: 'control_operating',
              reason: 'TLS 1.3 is enforced. HSTS header is not present and is recorded as a hardening limitation.',
              proofObligationId: 'soc2-cc6.7-transport-encryption-v1',
              method: 'HTTP/TLS probes',
              toolName: 'http_payload',
              skillSlug: 'compliance-technical-readiness',
              targetRef: 'https://example.com',
              evidenceRefs: ['/workspace/.artifacts/phases/control_assessment/tls.json'],
              findingIds: [],
              artifactIds: [],
              proof: {
                claim: 'Transport is encrypted for observed HTTPS endpoints.',
                evidenceIds: ['/workspace/.artifacts/phases/control_assessment/tls.json'],
                replayAttempted: false,
                notReplayedReason: 'other',
              },
              limitations: ['HSTS header is not present.'],
              freshUntil: '2026-09-25T00:00:00.000Z',
              runId: 'run-1',
              sessionId: 'session-1',
              createdAt: '2026-06-25T00:00:00.000Z',
              fresh: true,
              eligible: true,
              reviewStatus: 'unreviewed',
              latestReview: null,
              reviewHistory: [],
            },
          ],
        },
      ],
      gaps: [],
      coverageLimitations: [],
    },
  ],
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RunReportWorkflowService prepareReportContext', () => {
  it('does not generate compliance context for normal pentest reporting', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();

    const result = await service.prepareReportContext({
      userId: 'user-1',
      workspaceDir: workspace,
      context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
      input: {},
    });

    expect(result.complianceContextPath).toBeUndefined();
    expect(result.complianceTemplatePath).toBeUndefined();
    expect(result.complianceFrameworks).toEqual([]);
    expect(result.recommendedSections).not.toContain('compliance-readiness');
    expect(existsSync(join(workspace, '.artifacts', 'report', 'compliance-context.json'))).toBe(false);
    expect(existsSync(join(workspace, '.artifacts', 'report', 'compliance-template.md'))).toBe(false);

    const context = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'context.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(context).not.toHaveProperty('complianceReadiness');
    expect(context.authoringContract).not.toHaveProperty('complianceReportBoundary');
    await expect(readFile(join(workspace, '.artifacts', 'report', 'brief.md'), 'utf-8'))
      .resolves.not.toContain('Compliance Readiness');
  });

  it('generates compliance context only when the reporting phase is compliance-scoped', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    vi.spyOn(
      (service as unknown as {
        runReportFinalizer: { writeComplianceTemplateIfApplicable: () => Promise<boolean> };
      }).runReportFinalizer,
      'writeComplianceTemplateIfApplicable',
    ).mockResolvedValue(false);

    const result = await service.prepareReportContext({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        complianceReport: { framework: 'soc2', source: 'assessment-run' },
      },
      input: {},
    });

    expect(result.complianceContextPath).toBe(join(workspace, '.artifacts', 'report', 'compliance-context.json'));
    expect(result.complianceFrameworks).toEqual(['SOC 2 Technical Readiness']);
    expect(result.recommendedSections).toContain('compliance-readiness');
    expect(existsSync(join(workspace, '.artifacts', 'report', 'compliance-context.json'))).toBe(true);
    await expect(readFile(join(workspace, '.artifacts', 'report', 'brief.md'), 'utf-8'))
      .resolves.toContain('Compliance Readiness');
  });

  it('adds the GDPR framework boundary to report authoring context', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();
    const readiness = complianceReadiness();
    readiness.selectedFrameworks = [{ key: 'gdpr', label: 'GDPR Readiness', sources: ['organization_profile'] }];
    readiness.supportedFrameworks = ['gdpr'];
    const framework = readiness.frameworks[0];
    framework.key = 'gdpr';
    framework.label = 'GDPR Readiness';
    stubComplianceReadiness(service, readiness);

    const result = await service.prepareReportContext({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        complianceReport: { framework: 'gdpr', source: 'assessment-run' },
      },
      input: {},
    });

    expect(result.complianceTemplatePath).toBe(join(workspace, '.artifacts', 'report', 'compliance-template.md'));
    const context = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'context.json'), 'utf-8'),
    ) as {
      authoringContract: {
        complianceReportBoundary?: string;
        complianceFrameworkBoundaries?: Record<string, string>;
      };
    };
    expect(context.authoringContract.complianceReportBoundary).toBe(COMPLIANCE_READINESS_BOUNDARY_SENTENCE);
    expect(context.authoringContract.complianceFrameworkBoundaries).toEqual({
      gdpr: GDPR_READINESS_BOUNDARY_SENTENCE,
    });
    await expect(readFile(join(workspace, '.artifacts', 'report', 'compliance-template.md'), 'utf-8'))
      .resolves.toContain(GDPR_READINESS_BOUNDARY_SENTENCE);
  });

  it('generates compliance context when the run row is compliance-scoped', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({ runWorkflowDiscipline: 'compliance' });
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    vi.spyOn(
      (service as unknown as {
        runReportFinalizer: { writeComplianceTemplateIfApplicable: () => Promise<boolean> };
      }).runReportFinalizer,
      'writeComplianceTemplateIfApplicable',
    ).mockResolvedValue(false);

    const result = await service.prepareReportContext({
      userId: 'user-1',
      workspaceDir: workspace,
      context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
      input: {},
    });

    expect(result.complianceContextPath).toBe(join(workspace, '.artifacts', 'report', 'compliance-context.json'));
    const context = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'context.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(context).toHaveProperty('complianceReadiness');
  });
});

describe('RunReportWorkflowService compliance closeout snapshots', () => {
  it('persists compliance-context during finalization even when report context was not prepared', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    await writePassingComplianceReport(workspace);

    expect(existsSync(join(workspace, '.artifacts', 'report', 'compliance-context.json'))).toBe(false);

    const result = await service.finalizeRunArtifacts({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        complianceReport: { framework: 'soc2', source: 'assessment-run' },
      },
      input: { mode: 'final' },
    });

    expect(result.mode).toBe('final');
    expect(result.runCompletion).toMatchObject({
      state: 'completed',
      ready: true,
      finalized: true,
    });
    const terminalPreflight = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'finalizer-preflight.json'), 'utf-8'),
    ) as {
      finalized: boolean;
      canFinalizeFinal: boolean;
      canFinalizeInterim: boolean;
      requiredMode: string;
      intendedMode: string;
      runCompletion: { state: string; ready: boolean; finalized: boolean };
    };
    expect(terminalPreflight).toMatchObject({
      finalized: true,
      canFinalizeFinal: false,
      canFinalizeInterim: false,
      requiredMode: 'final',
      intendedMode: 'final',
      runCompletion: {
        state: 'completed',
        ready: true,
        finalized: true,
      },
    });
    const closeoutContext = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'compliance-context.json'), 'utf-8'),
    ) as ComplianceReadinessResponse;
    expect(closeoutContext.generatedAt).toBe(readiness.generatedAt);
    expect(closeoutContext.frameworks[0]?.key).toBe('soc2');
  });

  it('replaces authored compliance control dispositions with the canonical backend section before finalization', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    await writeFile(
      join(workspace, 'summary.md'),
      'SOC 2 readiness summary covers the assessed controls, evidence boundary, and closeout result in enough detail.',
      'utf-8',
    );
    await writeFile(
      join(workspace, 'report.md'),
      [
        '# SOC 2 Technical Readiness',
        '',
        COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
        '',
        '## Methodology',
        '',
        'This report was authored by the reporting agent and includes enough context for validation. '.repeat(4),
        '',
        '## Control Dispositions',
        '',
        '### CC6 - Logical and Physical Access Controls',
        '',
        '#### CC6.7 - Transmission security and encryption',
        '- **Verdict:** Pass',
        '- **Summary:** HSTS is enabled and no plaintext redirects were observed.',
        '',
        '## Evidence Index',
        '',
        '- Evidence is retained in the closeout bundle.',
      ].join('\n'),
      'utf-8',
    );

    await service.finalizeRunArtifacts({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        complianceReport: { framework: 'soc2', source: 'assessment-run' },
      },
      input: { mode: 'final' },
    });

    const report = await readFile(join(workspace, 'report.md'), 'utf-8');
    expect(report).toContain('<!-- nullsquare:canonical-compliance:start -->');
    expect(report).toContain('This run assessed: 1/1 controls with direct agent check records.');
    expect(report).toContain('Overall framework readiness: denominator 1; 0 need action; 0 not checked');
    expect(report).toContain('HSTS header is not present and is recorded as a hardening limitation.');
    expect(report).not.toContain('HSTS is enabled and no plaintext redirects were observed.');
  });

  it('persists compliance-context during finalization when only the run row carries compliance discipline', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({ runWorkflowDiscipline: 'compliance' });
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    await writePassingComplianceReport(workspace);

    const result = await service.finalizeRunArtifacts({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      },
      input: { mode: 'final' },
    });

    expect(result.mode).toBe('final');
    await expect(readFile(join(workspace, '.artifacts', 'report', 'compliance-context.json'), 'utf-8'))
      .resolves.toContain('"latestCompletedRunId": "run-1"');
  });

  it('persists compliance-context during closeout reconciliation for already completed runs', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();
    const readiness = complianceReadiness();
    stubComplianceReadiness(service, readiness);
    vi.spyOn(service as unknown as { buildFinalizerReportState: () => Promise<unknown> }, 'buildFinalizerReportState')
      .mockResolvedValue({
        ...baseReportState(),
        runCompletion: {
          ...baseReportState().runCompletion,
          state: 'completed',
          ready: false,
          finalized: true,
        },
      });

    const result = await service.reconcileAutomatedRunCloseout({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        complianceReport: { framework: 'soc2', source: 'assessment-run' },
      },
    });

    expect(result.outcome).toBe('finalized');
    await expect(readFile(join(workspace, '.artifacts', 'report', 'compliance-context.json'), 'utf-8'))
      .resolves.toContain('"latestCompletedRunId": "run-1"');
  });
});

describe('RunReportWorkflowService reporting handoff authority', () => {
  const writeReportingHandoff = async (
    workspace: string,
    closeoutOutcome: 'no_findings_after_coverage' | 'interim_blocked' | 'needs_operator_input',
  ): Promise<string> => {
    const relativePath = join('.artifacts', 'phase-handoffs', 'reporting.json').replace(/\\/gu, '/');
    await mkdir(join(workspace, '.artifacts', 'phase-handoffs'), { recursive: true });
    await writeFile(
      join(workspace, relativePath),
      `${JSON.stringify({ closeoutOutcome })}\n`,
      'utf-8',
    );
    return relativePath;
  };

  it.each(['interim_blocked', 'needs_operator_input'] as const)(
    'requires interim mode when the durable reporting handoff says %s',
    async (closeoutOutcome) => {
      const workspace = await makeWorkspace();
      const reportingHandoffRef = await writeReportingHandoff(workspace, closeoutOutcome);
      const service = makeWorkflow({ reportingHandoffRef });

      const result = await service.reportFinalizerPreflight({
        userId: 'user-1',
        workspaceDir: workspace,
        context: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          workflowDiscipline: 'pentest',
        },
        input: {},
      });

      expect(result.canFinalizeFinal).toBe(false);
      expect(result.requiredMode).toBe('interim');
      expect(result.reportingCloseoutOutcome).toBe(closeoutOutcome);
      expect(result.finalizerBlockers).toContain(
        `reporting handoff requires interim closeout: ${closeoutOutcome}`,
      );
    },
  );

  it('rejects final mode when the durable reporting handoff requires interim closeout', async () => {
    const workspace = await makeWorkspace();
    const reportingHandoffRef = await writeReportingHandoff(workspace, 'interim_blocked');
    const service = makeWorkflow({ reportingHandoffRef });

    await expect(service.finalizeRunArtifacts({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: { mode: 'final' },
    })).rejects.toThrow('reporting handoff requires interim closeout (interim_blocked)');
  });

  it('requires interim closeout while a non-reporting phase is unresolved', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      unresolvedCoveragePhases: [{
        phaseKey: 'enumeration',
        status: 'blocked',
        stepIds: ['mission-enum-1'],
        lastError: 'target did not respond',
      }],
    });

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: {},
    });

    expect(result.canFinalizeFinal).toBe(false);
    expect(result.requiredMode).toBe('interim');
    expect(result.finalizerBlockers).toContain(
      'coverage phase enumeration is blocked for mission(s) mission-enum-1: target did not respond',
    );

    await expect(service.finalizeRunArtifacts({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: { mode: 'final' },
    })).rejects.toThrow('coverage phase enumeration is blocked');
  });

  it('keeps final mode available for a completed zero-finding coverage handoff', async () => {
    const workspace = await makeWorkspace();
    const reportingHandoffRef = await writeReportingHandoff(workspace, 'no_findings_after_coverage');
    const service = makeWorkflow({ reportingHandoffRef });

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: {},
    });

    expect(result.canFinalizeFinal).toBe(true);
    expect(result.requiredMode).toBe('final');
    expect(result.reportingCloseoutOutcome).toBe('no_findings_after_coverage');
  });

  it('recomputes required mode when authored final artifacts fail validation', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow();

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: { intendedMode: 'final', checkAuthoredFiles: true },
    });

    expect(result.canFinalizeFinal).toBe(false);
    expect(result.requiredMode).toBe('interim');
    expect(result.authoredArtifactCheck.canPass).toBe(false);
  });

  it('fails closed when a recorded reporting handoff cannot be read', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      reportingHandoffRef: '.artifacts/phase-handoffs/missing.json',
    });

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: {},
    });

    expect(result.canFinalizeFinal).toBe(false);
    expect(result.requiredMode).toBe('interim');
    expect(result.finalizerBlockers).toContain(
      'reporting handoff could not be read for closeout authority',
    );
  });
});

/**
 * D19 and D25 — the two ways run r1's report said more than the run had proven.
 *
 * D19: recon saw a version string on a public Grafana login page and filed a Medium, CVSS
 * 5.3 customer finding. Nothing downstream recalibrated it, and 3.1 had called the same
 * observation Info. D25: the CORS finding's lifecycle state stayed honest at `verifying`,
 * but its prose asserted that the victim's bearer token is sent cross-origin — which browser
 * storage being origin-scoped makes untrue, and which nothing in its evidence showed.
 *
 * The report is where both become claims to a customer, so it is where they are checked.
 */
const reportFinding = (overrides: Record<string, unknown> = {}) => ({
  id: 'finding-1',
  assetId: 'asset-1',
  title: 'Publicly exposed Grafana monitoring panel with version disclosure',
  severity: 'medium',
  state: 'potential',
  summary: 'The Grafana login page is reachable without authentication and discloses a version.',
  businessImpact: null,
  technicalAnalysis: null,
  pocDescription: null,
  pocScriptCode: null,
  assumptions: null,
  fixEffort: null,
  remediation: null,
  cvssVector: null,
  cvssScore: 5.3,
  confidenceScore: null,
  cweId: null,
  cveId: null,
  cweIds: null,
  cveIds: null,
  owaspCategory: null,
  endpointId: null,
  serviceId: null,
  codeLocations: null,
  firstSeenAt: null,
  lastSeenAt: null,
  dedupeKey: 'dedupe-1',
  evidence: [],
  ...overrides,
});

const httpEvidence = (overrides: Record<string, unknown> = {}) => ({
  findingId: 'finding-1',
  kind: 'http_exchange',
  path: 'evidence.json',
  displayPath: null,
  label: null,
  excerpt: null,
  fileMissing: false,
  data: null,
  createdAt: null,
  ...overrides,
});

const readContextFindings = async (workspace: string): Promise<Array<Record<string, unknown>>> => {
  const context = JSON.parse(
    await readFile(join(workspace, '.artifacts', 'report', 'context.json'), 'utf-8'),
  ) as { findings: Array<Record<string, unknown>> };
  return context.findings;
};

const prepareContext = async (workspace: string, service: RunReportWorkflowService): Promise<void> => {
  await service.prepareReportContext({
    userId: 'user-1',
    workspaceDir: workspace,
    context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
    input: {},
  });
};

describe('RunReportWorkflowService severity and impact claims', () => {
  it('caps an unvalidated severity at what an unevidenced claim may say', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({ findings: [reportFinding()] });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    expect(finding.severity).toBe('low');
    expect(finding.declaredSeverity).toBe('medium');
    expect(finding.severityLabel).toBe('low (provisional; medium claimed, awaiting validation)');
  });

  it('leaves a validated severity exactly as validation set it', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({ state: 'confirmed', severity: 'high' })],
    });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    expect(finding.severity).toBe('high');
    expect(finding.severityLabel).toBe('high');
  });

  it('allows a higher provisional claim once the finding carries evidence', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({ severity: 'medium', evidence: [httpEvidence()] })],
    });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    expect(finding.severity).toBe('medium');
  });

  it('catches the r1 bearer-token sentence against the evidence the finding carries', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({
        title: 'CORS misconfiguration allows credentialed cross-origin reads',
        state: 'verifying',
        technicalAnalysis:
          'A sibling subdomain using credentials: include causes the browser to send the '
          + 'victim bearer token and session cookie to the attacker origin.',
        evidence: [httpEvidence({
          label: 'preflight response',
          excerpt: 'access-control-allow-origin: https://evil.example',
        })],
      })],
    });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    const claims = finding.unsupportedImpactClaims as Array<{ mechanism: string }>;
    expect(claims.map((claim) => claim.mechanism)).toContain('bearer_token_exfiltration');
  });

  it('says nothing when the evidence shows the header the prose claims', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({
        state: 'verifying',
        technicalAnalysis: 'The exchange shows the bearer token reaching the attacker origin.',
        evidence: [httpEvidence({
          data: { request: { headers: { authorization: 'Bearer eyJ' } } },
        })],
      })],
    });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    expect(finding.unsupportedImpactClaims).toEqual([]);
  });

  it('does not second-guess a finding validation already confirmed', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({
        state: 'confirmed',
        severity: 'high',
        technicalAnalysis: 'The chain results in account takeover.',
        evidence: [httpEvidence()],
      })],
    });

    await prepareContext(workspace, service);

    const [finding] = await readContextFindings(workspace);
    expect(finding.unsupportedImpactClaims).toEqual([]);
  });

  it('tells the reporting phase about both while it can still repair the prose', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflow({
      findings: [reportFinding({
        technicalAnalysis: 'An attacker achieves full account compromise.',
      })],
    });

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        workflowDiscipline: 'pentest',
      },
      input: {},
    });

    expect(result.findingWarnings.some((warning) => warning.includes('until validation raises it'))).toBe(true);
    expect(result.findingWarnings.some((warning) => warning.includes('account takeover'))).toBe(true);
  });
});
