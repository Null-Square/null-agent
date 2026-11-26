import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RunReportFinalizer } from '@/domains/security-ops/tools/reporting/RunReportFinalizer';
import { RunReportWorkflowService } from '@/domains/security-ops/tools/reporting/RunReportWorkflowService';

const tempDirs: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'null-ai-compliance-report-'));
  tempDirs.push(workspace);
  await mkdir(join(workspace, '.artifacts', 'report'), { recursive: true });
  return workspace;
};

const baseCoverage = () => ({
  plan: { total: 1, completed: 1, blocked: 0, pending: 0, running: 0, error: 0 },
  missionQuestions: [],
  missionSkills: [],
  noteCounts: [],
  testedClasses: [],
  blockers: [],
  openDebts: [],
  runDigest: {
    goal: 'compliance report',
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

const writeComplianceContext = async (workspace: string, status: string): Promise<void> => {
  const verdict =
    status === 'passing'
      ? 'pass'
      : status === 'failing'
        ? 'fail'
        : status === 'not_applicable'
          ? 'not_applicable'
          : status === 'not_supported'
            ? 'not_supported'
            : status === 'missing'
              ? 'not_attempted'
              : 'needs_evidence';
  const outcome =
    verdict === 'pass'
      ? 'passed'
      : verdict === 'fail'
        ? 'failed'
        : verdict === 'not_attempted'
          ? 'not_checked'
          : verdict === 'not_applicable' || verdict === 'not_supported'
            ? 'excluded'
            : 'needs_action';
  const statusCounts = {
    passing: status === 'passing' ? 1 : 0,
    partial: status === 'partial' ? 1 : 0,
    failing: status === 'failing' ? 1 : 0,
    missing: status === 'missing' ? 1 : 0,
    stale: status === 'stale' ? 1 : 0,
    not_applicable: status === 'not_applicable' ? 1 : 0,
    not_supported: status === 'not_supported' ? 1 : 0,
  };
  await writeFile(
    join(workspace, '.artifacts', 'report', 'compliance-context.json'),
    `${JSON.stringify(
      {
        selectedFrameworks: [{ key: 'soc2', label: 'SOC 2 Technical Readiness', sources: ['organization_profile'] }],
        frameworks: [
          {
            key: 'soc2',
            label: 'SOC 2 Technical Readiness',
            selected: true,
            supported: true,
            score: status === 'passing' ? 100 : 55,
            statusCounts,
            outcomeCounts: {
              passed: outcome === 'passed' ? 1 : 0,
              failed: outcome === 'failed' ? 1 : 0,
              needs_action: outcome === 'needs_action' ? 1 : 0,
              not_checked: outcome === 'not_checked' ? 1 : 0,
              excluded: outcome === 'excluded' ? 1 : 0,
            },
            controls: [
              {
                id: 'CC6.7',
                title: 'Transmission security and encryption',
                theme: 'Encryption',
                supportLevel: 'automated_testable',
                status,
                verdict,
                outcome,
                score: status === 'passing' ? 100 : 55,
                rationale: 'Transport evidence exists but is not yet fully reviewed.',
                evidence: [],
                gaps: [],
                coverageLimitations: [],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
};

const writeArtifacts = async (workspace: string, statusLine: string): Promise<void> => {
  await writeFile(
    join(workspace, 'summary.md'),
    [
      '# Summary',
      '',
      'SOC 2 readiness summary for operator review. Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(workspace, 'report.md'),
    [
      '# SOC 2 Technical Readiness',
      '',
      'Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.',
      '',
      '## SOC 2 Security Criteria Matrix',
      '',
      'Control CC6.7: Transmission security and encryption',
      statusLine,
      'Evidence citation: `.artifacts/report/compliance-context.json` and CC6.7.',
      '',
      'This section is intentionally concise for the unit test but long enough to satisfy authored report validation. The important behavior is that the finalizer must compare the status written in the report against the deterministic backend compliance context before publication.',
    ].join('\n'),
    'utf-8',
  );
};

type AuthoredArtifactValidator = {
  validateAuthoredRunArtifacts(input: {
    workspaceDir: string;
    mode: 'final';
    findings: unknown[];
    coverage: ReturnType<typeof baseCoverage>;
  }): Promise<unknown>;
};

type FinalizerPreflightHarness = {
  reportFinalizerPreflight: RunReportWorkflowService['reportFinalizerPreflight'];
  buildFinalizerReportState(input: unknown): Promise<unknown>;
};

const makeWorkflowService = (): RunReportWorkflowService => {
  const db = {} as unknown as ConstructorParameters<typeof RunReportWorkflowService>[0];
  return new RunReportWorkflowService(db, {
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    emitRunSystemEvent: async () => {},
  });
};

const makeFinalizer = (): RunReportFinalizer => {
  const db = {} as unknown as ConstructorParameters<typeof RunReportFinalizer>[0];
  return new RunReportFinalizer(db, { now: () => new Date('2026-06-12T00:00:00.000Z') });
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SecurityOpsToolService compliance report validation', () => {
  it('writes finalizer preflight with interim mode when reportable evidence is not durable', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflowService() as unknown as FinalizerPreflightHarness;
    service.buildFinalizerReportState = async () => ({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      findings: [
        {
          id: 'finding-1',
          title: 'Validated issue without durable evidence',
          severity: 'high',
          state: 'confirmed',
          evidence: [],
        },
      ],
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

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      input: {},
    });

    expect(result.canFinalizeFinal).toBe(false);
    expect(result.requiredMode).toBe('interim');
    expect(result.reportableCount).toBe(1);
    expect(result.missingDurableEvidenceBlockers).toEqual([
      expect.objectContaining({
        id: 'finding-1',
        reason: expect.stringContaining('no durable evidence'),
      }),
    ]);
    expect(result.findingWarnings).toEqual([
      'finding finding-1 (Validated issue without durable evidence) missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
    ]);
    expect(result.complianceBoundarySentence).toBe(
      'Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.',
    );

    const artifact = JSON.parse(
      await readFile(join(workspace, '.artifacts', 'report', 'finalizer-preflight.json'), 'utf-8'),
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        canFinalizeFinal: false,
        requiredMode: 'interim',
        preflightPath: '.artifacts/report/finalizer-preflight.json',
        findingWarnings: [
          'finding finding-1 (Validated issue without durable evidence) missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
        ],
      }),
    );
  });

  it('blocks final preflight when a validated finding is missing canonical report fields', async () => {
    const workspace = await makeWorkspace();
    const service = makeWorkflowService() as unknown as FinalizerPreflightHarness;
    service.buildFinalizerReportState = async () => ({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      findings: [
        {
          id: 'finding-1',
          title: 'Validated issue missing report fields',
          severity: 'high',
          state: 'confirmed',
          summary: 'Validated issue.',
          businessImpact: '',
          technicalAnalysis: '',
          pocDescription: '',
          assumptions: '',
          remediation: '',
          fixEffort: null,
          cweId: null,
          cweIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          evidence: [{ kind: 'http_exchange', fileMissing: false }],
        },
      ],
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

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir: workspace,
      input: {},
    });

    expect(result.canFinalizeFinal).toBe(false);
    expect(result.requiredMode).toBe('interim');
    expect(result.missingReportFieldBlockers).toEqual([
      expect.objectContaining({
        id: 'finding-1',
        missingReportFields: ['businessImpact', 'technicalAnalysis', 'pocDescription', 'assumptions', 'remediation'],
      }),
    ]);
    expect(result.finalizerBlockers).toEqual([
      'validated finding finding-1 missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
    ]);
  });

  it('accepts compliance reports whose control status matches compliance-context', async () => {
    const workspace = await makeWorkspace();
    await writeComplianceContext(workspace, 'partial');
    await writeArtifacts(workspace, '**Verdict**: Needs evidence');
    const service = makeFinalizer();

    await expect(
      (service as unknown as AuthoredArtifactValidator).validateAuthoredRunArtifacts({
        workspaceDir: workspace,
        mode: 'final',
        findings: [],
        coverage: baseCoverage(),
      }),
    ).resolves.toEqual(expect.objectContaining({ reportBytes: expect.any(Number) }));
  });

  it('rejects compliance reports that omit the exact boundary sentence with actionable guidance', async () => {
    const workspace = await makeWorkspace();
    await writeComplianceContext(workspace, 'partial');
    // No boundary/disclaimer sentence, and the report never mentions CC6.7 at all.
    await writeFile(
      join(workspace, 'summary.md'),
      '# Summary\n\nSOC 2 readiness summary for operator review describing the assessed public surface and evidence basis.',
      'utf-8',
    );
    await writeFile(
      join(workspace, 'report.md'),
      [
        '# SOC 2 Technical Readiness',
        '',
        '## Overview',
        'The assessed scope is a public marketing surface. This section is intentionally',
        'concise for the unit test but long enough to satisfy authored report length',
        'validation while deliberately omitting the disclaimer sentence and every control',
        'row from the prepared context so the de-gated finalizer behavior can be verified.',
      ].join('\n'),
      'utf-8',
    );
    const service = makeFinalizer();

    await expect(
      (service as unknown as AuthoredArtifactValidator).validateAuthoredRunArtifacts({
        workspaceDir: workspace,
        mode: 'final',
        findings: [],
        coverage: baseCoverage(),
      }),
    ).rejects.toThrow(
      /must include this exact boundary sentence: "Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion\."/,
    );
  });

  it('rejects compliance reports that contradict backend control status', async () => {
    const workspace = await makeWorkspace();
    await writeComplianceContext(workspace, 'partial');
    await writeArtifacts(workspace, '**Status**: Passing | **Score**: 100%');
    const service = makeFinalizer();

    await expect(
      (service as unknown as AuthoredArtifactValidator).validateAuthoredRunArtifacts({
        workspaceDir: workspace,
        mode: 'final',
        findings: [],
        coverage: baseCoverage(),
      }),
    ).rejects.toThrow(/contradicts compliance-context status.*CC6\.7 expected partial/);
  });

  it('rejects compliance reports whose aggregate status count table contradicts compliance-context', async () => {
    const workspace = await makeWorkspace();
    await writeComplianceContext(workspace, 'partial');
    await writeArtifacts(
      workspace,
      [
        '**Verdict**: Needs evidence',
        '',
        '| Status | Count |',
        '| --- | ---: |',
        '| Passing | 0 |',
        '| Partial | 1 |',
        '| Failing | 0 |',
        '| Missing | 0 |',
        '| Stale | 0 |',
        '| Not Applicable | 0 |',
        '| Not Supported | 9 |',
      ].join('\n'),
    );
    const service = makeFinalizer();

    await expect(
      (service as unknown as AuthoredArtifactValidator).validateAuthoredRunArtifacts({
        workspaceDir: workspace,
        mode: 'final',
        findings: [],
        coverage: baseCoverage(),
      }),
    ).rejects.toThrow(/contradicts compliance-context statusCounts.*Not Supported expected 0, report says 9/);
  });
  it('rejects compliance reports whose aggregate outcome table contradicts compliance-context', async () => {
    const workspace = await makeWorkspace();
    await writeComplianceContext(workspace, 'partial');
    await writeArtifacts(
      workspace,
      [
        '**Verdict**: Needs evidence',
        '',
        '| Outcome | Count |',
        '| --- | ---: |',
        '| Passed | 0 |',
        '| Failed | 0 |',
        '| Needs action | 0 |',
        '| Not checked | 0 |',
        '| Excluded | 0 |',
      ].join('\n'),
    );
    const service = makeFinalizer();

    await expect(
      (service as unknown as AuthoredArtifactValidator).validateAuthoredRunArtifacts({
        workspaceDir: workspace,
        mode: 'final',
        findings: [],
        coverage: baseCoverage(),
      }),
    ).rejects.toThrow(/needs action expected 1, report says 0/);
  });
});
