import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunReportFinalizer } from '@/domains/security-ops/tools/reporting/RunReportFinalizer';
import { RunReportRenderer } from '@/domains/security-ops/tools/reporting/RunReportRenderer';
import type { ComplianceReadinessResponse } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';
import { complianceControlChecks, complianceControlRequests, runs } from '@/db/schema';

// Minimal drizzle stub: returns table-specific rows for the chained select().from().where()[.limit()].
const makeFrameworkResolverDb = (config: {
  run?: string | null;
  checks?: string[];
  requests?: string[];
}) =>
  ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === runs
              ? config.run !== undefined
                ? [{ frameworkKey: config.run }]
                : []
              : table === complianceControlChecks
                ? (config.checks ?? []).map((frameworkKey) => ({ frameworkKey }))
                : table === complianceControlRequests
                  ? (config.requests ?? []).map((frameworkKey) => ({ frameworkKey }))
                  : [];
          const result = Promise.resolve(rows) as Promise<typeof rows> & {
            limit: (n: number) => Promise<typeof rows>;
          };
          result.limit = () => Promise.resolve(rows);
          return result;
        },
      }),
    }),
  }) as never;

const twoFrameworkReadiness = (): ComplianceReadinessResponse =>
  ({
    selectedFrameworks: [
      { key: 'soc2', label: 'SOC 2' },
      { key: 'iso27001', label: 'ISO 27001' },
    ],
    frameworks: ['soc2', 'iso27001'].map((key) => ({
      key,
      label: key === 'soc2' ? 'SOC 2' : 'ISO 27001',
      selected: true,
      supported: true,
      statusCounts: {
        missing: 0,
        partial: 0,
        passing: 1,
        failing: 0,
        stale: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 0,
      },
      outcomeCounts: { passed: 1, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
      controls: [
        {
          id: key === 'soc2' ? 'CC6.1' : 'ISO-A-TECH-IAM',
          title: key === 'soc2' ? 'Logical access' : 'Identity and access management',
          theme: 'Access Control',
          verdict: 'pass',
          outcome: 'passed',
          basis: 'agent_tested',
          verdictReason: 'tested',
          evidence: [],
          coverageLimitations: [],
          controlChecks: [],
          actionRequests: [],
        },
      ],
    })),
  }) as unknown as ComplianceReadinessResponse;

describe('RunReportFinalizer', () => {
  let workspaceDir: string;
  let finalizer: RunReportFinalizer;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'run-report-finalizer-'));
    finalizer = new RunReportFinalizer({} as never);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('reads authored summary and report files with warning metadata', async () => {
    await writeFile(join(workspaceDir, 'summary.md'), 'summary body');
    await writeFile(join(workspaceDir, 'report.md'), 'report body');

    await expect(
      finalizer.readAuthoredRunArtifactsWithWarning({
        workspaceDir,
        warning: 'fallback accepted',
      }),
    ).resolves.toEqual({
      summaryPath: join(workspaceDir, 'summary.md'),
      reportPath: join(workspaceDir, 'report.md'),
      summaryBytes: Buffer.byteLength('summary body', 'utf-8'),
      reportBytes: Buffer.byteLength('report body', 'utf-8'),
      warnings: ['fallback accepted'],
    });
  });

  it('throws for empty authored markdown and returns null for warning reads when files are missing', async () => {
    const summaryPath = join(workspaceDir, 'summary.md');
    await writeFile(summaryPath, '   ');

    await expect(finalizer.readAuthoredMarkdown(summaryPath, 'summary.md')).rejects.toThrow('summary.md is empty');
    await expect(
      finalizer.readAuthoredRunArtifactsWithWarning({
        workspaceDir,
        warning: 'fallback accepted',
      }),
    ).resolves.toBeNull();
  });

  it('focuses compliance readiness to a requested framework', () => {
    const readiness = {
      selectedFrameworks: [
        { key: 'soc2', label: 'SOC 2' },
        { key: 'iso27001', label: 'ISO 27001' },
      ],
      frameworks: [
        { key: 'soc2', label: 'SOC 2', selected: true, supported: true },
        { key: 'iso27001', label: 'ISO 27001', selected: true, supported: true },
      ],
    } as ComplianceReadinessResponse;

    expect(finalizer.focusComplianceReadinessForReportContext(readiness, 'soc2')).toEqual(
      expect.objectContaining({
        selectedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
        frameworks: [expect.objectContaining({ key: 'soc2', label: 'SOC 2' })],
      }),
    );
    expect(finalizer.focusComplianceReadinessForReportContext(readiness, 'missing')).toBe(readiness);
  });

  it('does not leak another framework into a focused compliance report section', () => {
    const focused = finalizer.focusComplianceReadinessForReportContext(twoFrameworkReadiness(), 'iso27001');
    expect(focused.frameworks.map((item) => item.key)).toEqual(['iso27001']);

    const section = new RunReportRenderer().renderCanonicalComplianceReportSection(focused);
    expect(section).toContain('### ISO 27001');
    expect(section).toContain('ISO-A-TECH-IAM');
    expect(section).not.toContain('SOC 2');
    expect(section).not.toContain('CC6.1');
  });

  it('rejects an authored NIST Implementation Tier when canonical context does not determine one', () => {
    const readiness = {
      frameworks: [{
        key: 'nist_csf',
        label: 'NIST CSF 2.0 Readiness',
        selected: true,
        supported: true,
        statusCounts: { missing: 1 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [{
          id: 'GV.OC',
          title: 'Organizational context evidence',
          status: 'missing',
          verdict: 'not_attempted',
          outcome: 'not_checked',
          controlChecks: [],
        }],
        frameworkProfile: {
          kind: 'nist_csf_2_0',
          functions: [],
          implementationTier: {
            status: 'not_determined',
            tier: null,
            reason: 'Organization-owned Profile evidence is required.',
          },
        },
      }],
    } as unknown as ComplianceReadinessResponse;

    expect(() => (finalizer as any).validateComplianceReportAgainstContext({
      report: 'Implementation Tier: Tier 2 (Risk Informed)\nGV.OC is not checked.',
      complianceContext: readiness,
    })).toThrow('assigns an Implementation Tier');
  });

  it('rejects HIPAA compliance and certification overclaims', () => {
    const readiness = {
      frameworks: [{
        key: 'hipaa',
        label: 'HIPAA Security Rule Readiness',
        selected: true,
        supported: true,
        statusCounts: { missing: 1 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [{
          id: '164.308(a)(1)',
          title: 'Security management process',
          status: 'missing',
          verdict: 'not_attempted',
          outcome: 'not_checked',
          controlChecks: [],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;

    expect(() => (finalizer as any).validateComplianceReportAgainstContext({
      report: 'This organization is HIPAA compliant.\n164.308(a)(1) is not checked.',
      complianceContext: readiness,
    })).toThrow('Cannot finalize HIPAA report');
  });

  it('requires GDPR boundary language and rejects GDPR overclaims', () => {
    const readiness = {
      frameworks: [{
        key: 'gdpr',
        label: 'GDPR Readiness',
        selected: true,
        supported: true,
        statusCounts: { missing: 1 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [{
          id: 'GDPR-DATA-ROPA',
          title: 'Record of processing activities evidence',
          status: 'missing',
          verdict: 'not_attempted',
          outcome: 'not_checked',
          controlChecks: [],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;

    expect(() => (finalizer as any).validateComplianceReportAgainstContext({
      report: 'GDPR-DATA-ROPA is not checked.',
      complianceContext: readiness,
    })).toThrow('must include this exact GDPR boundary sentence');

    for (const claim of [
      'The organization is GDPR compliant.',
      'The organization is GDPR certified.',
      'This is a legal opinion.',
      'The DPO approved this assessment.',
      'The supervisory authority approved the program.',
      'This report is regulator-ready.',
      'This is an audit attestation.',
    ]) {
      expect(() => (finalizer as any).validateComplianceReportAgainstContext({
        report: `${GDPR_READINESS_BOUNDARY_SENTENCE}\n${claim}\nGDPR-DATA-ROPA is not checked.`,
        complianceContext: readiness,
      })).toThrow('Cannot finalize GDPR report');
    }
  });

  it('rejects PCI DSS compliance, ASV, QSA, ROC, SAQ, and AOC overclaims', () => {
    const readiness = {
      frameworks: [{
        key: 'pci_dss',
        label: 'PCI DSS v4.0.1 Readiness',
        selected: true,
        supported: true,
        statusCounts: { missing: 1 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [{
          id: '11.3.2',
          title: 'External vulnerability scans are available for public CDE-facing systems',
          status: 'missing',
          verdict: 'not_attempted',
          outcome: 'not_checked',
          controlChecks: [],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;

    for (const claim of [
      'The environment is PCI DSS compliant.',
      'The ASV scan passed.',
      'The QSA approved this report.',
      'The ROC is complete.',
      'The SAQ is complete.',
      'The AOC was issued.',
    ]) {
      expect(() => (finalizer as any).validateComplianceReportAgainstContext({
        report: `${claim}\n11.3.2 is not checked.`,
        complianceContext: readiness,
      })).toThrow('Cannot finalize PCI DSS report');
    }
  });

  describe('resolveReportFramework', () => {
    it('prefers the explicit report-context framework without touching the database', async () => {
      const throwingDb = {
        select: () => {
          throw new Error('db should not be queried when context framework is present');
        },
      } as never;
      const resolver = new RunReportFinalizer(throwingDb);
      await expect(
        resolver.resolveReportFramework({ runId: 'run-1', contextFramework: 'iso27001' }),
      ).resolves.toBe('iso27001');
    });

    it('returns null when neither context framework nor runId is available', async () => {
      const resolver = new RunReportFinalizer({} as never);
      await expect(resolver.resolveReportFramework({})).resolves.toBeNull();
    });

    it('uses the run persisted framework when set', async () => {
      const resolver = new RunReportFinalizer(makeFrameworkResolverDb({ run: 'iso27001' }));
      await expect(resolver.resolveReportFramework({ runId: 'run-1' })).resolves.toBe('iso27001');
    });

    it('derives the framework from recorded control checks for legacy runs', async () => {
      const resolver = new RunReportFinalizer(
        makeFrameworkResolverDb({ run: null, checks: ['iso27001', 'iso27001', 'soc2'] }),
      );
      await expect(resolver.resolveReportFramework({ runId: 'run-1' })).resolves.toBe('iso27001');
    });

    it('falls back to control requests when a run recorded no checks', async () => {
      const resolver = new RunReportFinalizer(
        makeFrameworkResolverDb({ run: null, checks: [], requests: ['soc2'] }),
      );
      await expect(resolver.resolveReportFramework({ runId: 'run-1' })).resolves.toBe('soc2');
    });
  });

  it('does not write a compliance template when no selected supported framework exists', async () => {
    const readiness = {
      frameworks: [{ key: 'soc2', label: 'SOC 2', selected: false, supported: true }],
    } as ComplianceReadinessResponse;

    await expect(
      finalizer.writeComplianceTemplateIfApplicable({
        complianceReadiness: readiness,
        templatePath: join(workspaceDir, 'template.md'),
      }),
    ).resolves.toBe(false);
  });

  it('writes compliance templates from the compliance reporting skill', async () => {
    const templatePath = join(workspaceDir, 'template.md');
    const readiness = {
      frameworks: [{ key: 'soc2', label: 'SOC 2', selected: true, supported: true }],
    } as ComplianceReadinessResponse;

    await expect(
      finalizer.writeComplianceTemplateIfApplicable({
        complianceReadiness: readiness,
        templatePath,
      }),
    ).resolves.toBe(true);

    const body = await readFile(templatePath, 'utf8');
    expect(body).toContain('framework: soc2');
    expect(body).toContain('SOC 2 Security Readiness Template');
  });

  it('warns when a compliance report does not separate run coverage from framework readiness', async () => {
    const reportDir = join(workspaceDir, '.artifacts', 'report');
    await mkdir(reportDir, { recursive: true });
    const checkId = '11111111-1111-4111-8111-111111111111';
    const readiness = {
      frameworks: [{
        key: 'soc2',
        label: 'SOC 2',
        selected: true,
        supported: true,
        statusCounts: {
          missing: 0,
          partial: 0,
          passing: 1,
          failing: 0,
          stale: 0,
          accepted_risk: 0,
          not_applicable: 0,
          not_supported: 0,
        },
        outcomeCounts: {
          passed: 1,
          failed: 0,
          needs_action: 0,
          not_checked: 0,
          excluded: 0,
        },
        controls: [{
          id: 'CC6.1',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          controlChecks: [{ id: checkId }],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;
    await writeFile(join(reportDir, 'compliance-context.json'), JSON.stringify(readiness), 'utf8');
    await writeFile(
      join(workspaceDir, 'summary.md'),
      'Compliance summary covers the SOC 2 readiness result and evidence boundary in enough detail.',
    );
    await writeFile(
      join(workspaceDir, 'report.md'),
      [
        '# SOC 2 Readiness Report',
        '',
        COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
        '',
        'The SOC 2 readiness view shows one passed control based on backend context.',
        '',
        '| Control | Outcome | Check ID |',
        '| --- | --- | --- |',
        `| CC6.1 | Passed | ${checkId} |`,
        '',
        'This report includes enough supporting prose to pass minimum length while intentionally omitting the explicit split between run-assessed control checks and overall framework readiness counts. '.repeat(3),
      ].join('\n'),
    );

    const result = await finalizer.validateAuthoredRunArtifacts({
      workspaceDir,
      mode: 'final',
      findings: [],
      coverage: { runDigest: {}, openDebts: [] },
    });

    expect(
      result.warnings.some((warning) => warning.includes('separate run coverage from framework readiness')),
    ).toBe(true);
  });

  it('warns when a compliance report matrix uses control-range notation instead of explicit control IDs', async () => {
    const reportDir = join(workspaceDir, '.artifacts', 'report');
    await mkdir(reportDir, { recursive: true });
    const checkId = '11111111-1111-4111-8111-111111111111';
    const readiness = {
      frameworks: [{
        key: 'soc2',
        label: 'SOC 2',
        selected: true,
        supported: true,
        statusCounts: {
          missing: 0,
          partial: 0,
          passing: 1,
          failing: 0,
          stale: 0,
          accepted_risk: 0,
          not_applicable: 0,
          not_supported: 0,
        },
        outcomeCounts: {
          passed: 1,
          failed: 0,
          needs_action: 0,
          not_checked: 0,
          excluded: 0,
        },
        controls: [{
          id: 'CC6.1',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          controlChecks: [{ id: checkId }],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;
    await writeFile(join(reportDir, 'compliance-context.json'), JSON.stringify(readiness), 'utf8');
    await writeFile(
      join(workspaceDir, 'summary.md'),
      'Compliance summary covers the SOC 2 readiness result and evidence boundary in enough detail.',
    );
    await writeFile(
      join(workspaceDir, 'report.md'),
      [
        '# SOC 2 Readiness Report',
        '',
        COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
        '',
        'This run assessed 1/1 controls with direct agent check records.',
        'Overall framework readiness: denominator 1; 0 need action; 0 not checked.',
        '',
        '| Control | Outcome | Check ID |',
        '| --- | --- | --- |',
        `| CC6.1-CC6.2 | Passed | ${checkId} |`,
        '',
        'This report includes enough supporting prose to pass minimum length while intentionally using a range in the matrix. '.repeat(4),
      ].join('\n'),
    );

    const result = await finalizer.validateAuthoredRunArtifacts({
      workspaceDir,
      mode: 'final',
      findings: [],
      coverage: { runDigest: {}, openDebts: [] },
    });

    expect(
      result.warnings.some((warning) => warning.includes('control-range notation')),
    ).toBe(true);
  });

  it('rejects compliance reports that cite a check id under the wrong control', async () => {
    const reportDir = join(workspaceDir, '.artifacts', 'report');
    await mkdir(reportDir, { recursive: true });
    const correctCheckId = '11111111-1111-4111-8111-111111111111';
    const wrongCheckId = '22222222-2222-4222-8222-222222222222';
    const readiness = {
      frameworks: [{
        key: 'soc2',
        label: 'SOC 2',
        selected: true,
        supported: true,
        statusCounts: {
          missing: 0,
          partial: 0,
          passing: 1,
          failing: 0,
          stale: 0,
          accepted_risk: 0,
          not_applicable: 0,
          not_supported: 0,
        },
        outcomeCounts: {
          passed: 1,
          failed: 0,
          needs_action: 0,
          not_checked: 0,
          excluded: 0,
        },
        controls: [{
          id: 'CC6.1',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          controlChecks: [{ id: correctCheckId }],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;
    await writeFile(join(reportDir, 'compliance-context.json'), JSON.stringify(readiness), 'utf8');
    await writeFile(workspaceDir + '/summary.md', 'Compliance summary covers the SOC 2 readiness result and evidence boundary in enough detail.');
    await writeFile(
      workspaceDir + '/report.md',
      [
        '# SOC 2 Readiness Report',
        '',
        COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
        '',
        '| Control | Outcome | Check ID |',
        '| --- | --- | --- |',
        `| CC6.1 | Passed | ${wrongCheckId} |`,
        '',
        'This report includes enough supporting prose to pass minimum length while still citing the wrong check identifier. '.repeat(4),
      ].join('\n'),
    );

    await expect(finalizer.validateAuthoredRunArtifacts({
      workspaceDir,
      mode: 'final',
      findings: [],
      coverage: { runDigest: {}, openDebts: [] },
    })).rejects.toThrow('cites control-check id');
  });

  it('rejects compliance reports with an explicit invented report date', async () => {
    finalizer = new RunReportFinalizer({} as never, {
      now: () => new Date('2026-06-25T12:00:00.000Z'),
    });
    const reportDir = join(workspaceDir, '.artifacts', 'report');
    await mkdir(reportDir, { recursive: true });
    const checkId = '11111111-1111-4111-8111-111111111111';
    const readiness = {
      frameworks: [{
        key: 'soc2',
        label: 'SOC 2',
        selected: true,
        supported: true,
        statusCounts: {
          missing: 0,
          partial: 0,
          passing: 1,
          failing: 0,
          stale: 0,
          accepted_risk: 0,
          not_applicable: 0,
          not_supported: 0,
        },
        outcomeCounts: {
          passed: 1,
          failed: 0,
          needs_action: 0,
          not_checked: 0,
          excluded: 0,
        },
        controls: [{
          id: 'CC6.1',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          controlChecks: [{ id: checkId }],
        }],
      }],
    } as unknown as ComplianceReadinessResponse;
    await writeFile(join(reportDir, 'compliance-context.json'), JSON.stringify(readiness), 'utf8');
    await writeFile(
      join(workspaceDir, 'summary.md'),
      'Compliance summary covers the SOC 2 readiness result, evidence boundary, and explicit assessment limitations for this scope.',
    );
    await writeFile(
      join(workspaceDir, 'report.md'),
      [
        '# SOC 2 Readiness Report',
        '',
        'Assessment Date: 2025-06-25',
        '',
        COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
        '',
        'This run assessed 1/1 controls with direct agent check records.',
        'Overall framework readiness: denominator 1; 0 need action; 0 not checked.',
        '',
        '| Control | Outcome | Check ID |',
        '| --- | --- | --- |',
        `| CC6.1 | Passed | ${checkId} |`,
        '',
        'This report includes enough supporting prose to pass minimum length while still using the wrong explicit report date. '.repeat(4),
      ].join('\n'),
    );

    await expect(finalizer.validateAuthoredRunArtifacts({
      workspaceDir,
      mode: 'final',
      findings: [],
      coverage: { runDigest: {}, openDebts: [] },
    })).rejects.toThrow('explicit report date');
  });

  it('rejects authored pentest reports that contradict canonical finding severity', async () => {
    await writeFile(
      join(workspaceDir, 'summary.md'),
      [
        '# Run Summary',
        '',
        'Outcome: completed.',
        'Reportable findings: one low-severity issue was validated.',
        'Recommended next run: validate the authenticated admin workflow.',
      ].join('\n'),
    );
    await writeFile(
      join(workspaceDir, 'report.md'),
      [
        '# Security Assessment Report',
        '',
        '## Executive Summary',
        'The run produced one reportable finding that needs remediation.',
        '',
        '## Finding: Exposed internal README',
        'Severity: Low',
        'The report discusses finding-1 and describes the exposed internal README in enough detail for validation.',
        '',
        '## Evidence',
        'Evidence reference: finding-1 and /workspace/.artifacts/report/context.json.',
        '',
        '## Remediation',
        'Remove the exposed file, verify the deployment packaging rules, and retest the public path. '.repeat(5),
      ].join('\n'),
    );

    await expect(
      finalizer.validateAuthoredRunArtifacts({
        workspaceDir,
        mode: 'final',
        findings: [{
          id: 'finding-1',
          title: 'Exposed internal README',
          severity: 'medium',
          state: 'confirmed',
        }],
        coverage: { runDigest: {}, openDebts: [] },
      }),
    ).rejects.toThrow(/contradicts canonical severity.*expected medium.*saw low/);
  });
});
