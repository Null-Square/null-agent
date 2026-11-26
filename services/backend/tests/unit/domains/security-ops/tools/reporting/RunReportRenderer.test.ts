import { describe, expect, it } from 'vitest';

import type { ComplianceReadinessResponse } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import {
  RunReportRenderer,
  type ReportRendererCoverageSummary,
  type ReportRendererFindingRow,
  type ReportRendererNoteRow,
  type ReportRendererRunCompletion,
} from '@/domains/security-ops/tools/reporting/RunReportRenderer';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';

const finding = (overrides: Partial<ReportRendererFindingRow> = {}): ReportRendererFindingRow => ({
  id: 'finding-1',
  assetId: 'asset-1',
  title: 'Missing security header',
  severity: 'medium',
  state: 'confirmed',
  summary: 'The application response is missing a required security header.',
  businessImpact: 'Browsers have less protection against client-side abuse.',
  technicalAnalysis: 'The tested endpoint did not return the expected response header.',
  pocDescription: 'Request the endpoint and inspect response headers.',
  pocScriptCode: 'curl -I https://example.test',
  assumptions: 'The endpoint is in scope.',
  fixEffort: 'low',
  remediation: 'Set the missing response header at the edge or application layer.',
  cvssVector: null,
  cvssScore: null,
  confidenceScore: 0.9,
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
  dedupeKey: 'finding-1',
  evidence: [],
  ...overrides,
});

const note = (overrides: Partial<ReportRendererNoteRow>): ReportRendererNoteRow => ({
  ntype: 'run.digest',
  title: null,
  data: {},
  evidence: [],
  lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const readyCompletion: ReportRendererRunCompletion = {
  state: 'ready_for_finalization',
  ready: true,
  reasons: ['all plan steps completed and no promotable candidates remain'],
  incompletePlanSteps: [],
  unresolvedPromotableFindings: [],
  finalized: false,
};

describe('RunReportRenderer', () => {
  it('builds RunCompletion from plan state and promotable candidate evidence', () => {
    const renderer = new RunReportRenderer();

    const completion = renderer.buildRunCompletion({
      plan: [
        { id: 'discover', title: 'Discover surface', status: 'completed' },
        {
          id: 'report',
          title: 'Write report',
          status: 'running',
          mission: { assignedSkills: ['security-reporting'] },
        },
      ],
      findings: [
        finding({
          id: 'candidate-1',
          title: 'Candidate SQL injection',
          severity: 'high',
          state: 'potential',
        }),
      ],
      durableEvidenceFindingIds: new Set(['candidate-1']),
      finalized: false,
    });

    expect(completion.state).toBe('not_ready');
    expect(completion.incompletePlanSteps).toEqual([]);
    expect(completion.unresolvedPromotableFindings).toEqual([
      { id: 'candidate-1', title: 'Candidate SQL injection', severity: 'high' },
    ]);
  });

  it('summarizes coverage notes and scanner shell jobs', () => {
    const renderer = new RunReportRenderer();

    const coverage = renderer.buildFinalizerCoverageSummary({
      plan: [
        {
          id: 'scan',
          title: 'Scan',
          status: 'completed',
          mission: { question: 'What public HTTP surface exists?', assignedSkills: ['recon'] },
        },
      ],
      findings: [finding()],
      notes: [
        note({
          ntype: 'run.digest',
          data: {
            goal: 'Assess public web surface',
            outcome: 'No exploitable issue confirmed',
            completed_tasks: ['mapped public routes'],
          },
        }),
        note({
          ntype: 'scan.coverage',
          title: 'Nuclei scan',
          data: {
            family: 'template-scan',
            status: 'completed',
            toolset: ['nuclei'],
            stats: { endpointsDiscovered: '3', findingsCreated: 1 },
          },
        }),
        note({
          ntype: 'http.endpoint',
          data: { method: 'GET', url: 'https://example.test/', statusCode: 200, title: 'Home' },
        }),
        note({
          ntype: 'tech.fingerprint',
          data: { product: 'nginx', version: '1.25', confidence: 0.9 },
        }),
        note({
          ntype: 'approach.tried',
          data: { technique: 'header review', endpoint: '/', result: 'missing header confirmed' },
        }),
      ],
      runCompletion: readyCompletion,
      shellJobs: {
        nuclei: {
          jobId: 'shelljob-nuclei',
          command: 'nuclei -u https://example.test',
          status: 'completed',
          stdoutPath: '.artifacts/nuclei.jsonl',
        },
      },
    });

    expect(coverage.plan.completed).toBe(1);
    expect(coverage.missionQuestions).toEqual(['What public HTTP surface exists?']);
    expect(coverage.scanCoverage[0]).toMatchObject({
      title: 'Nuclei scan',
      toolset: ['nuclei'],
      stats: ['3 endpoints', '1 findings'],
    });
    expect(coverage.endpoints[0]).toMatchObject({ url: 'https://example.test/' });
    expect(coverage.technologies[0]).toMatchObject({ product: 'nginx', version: '1.25' });
    expect(coverage.scannerOutcomes[0]).toMatchObject({
      jobId: 'shelljob-nuclei',
      outcome: 'completed_no_reportable_output',
      stdoutPath: '.artifacts/nuclei.jsonl',
    });
  });

  it('renders reporter handoff context with compliance status counts', () => {
    const renderer = new RunReportRenderer();
    const coverage: ReportRendererCoverageSummary = {
      plan: { total: 1, completed: 1, blocked: 0, pending: 0, running: 0, error: 0 },
      missionQuestions: ['What public HTTP surface exists?'],
      missionSkills: ['recon'],
      noteCounts: [{ ntype: 'run.digest', count: 1 }],
      testedClasses: ['recon'],
      blockers: [],
      openDebts: [],
      runDigest: {
        goal: 'Assess public web surface',
        outcome: 'No exploitable issue confirmed',
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
    };
    const reportState = {
      organizationId: 'org-1',
      scopeId: 'scope-1',
      findings: [
        finding({
          validationProof: {
            schemaVersion: 1,
            proof: {
              claim: 'The tested endpoint omits the expected security header.',
              evidenceIds: ['http:header-proof'],
              replayAttempted: true,
              replayArtifact: '.artifacts/python-session/run/results/header-replay.json',
              replayReproduced: true,
            },
            obligations: [
              {
                id: 'primary-observable',
                observable: 'Response lacks the required header.',
                status: 'proven',
                evidenceIds: ['http:header-proof'],
              },
            ],
            advisoryTriage: {
              verdict: 'agree',
              reason: 'Proof is bound to replayed HTTP evidence.',
              triagedBy: 'inline_validation_advisory',
              evidenceIds: ['http:header-proof'],
              flags: [],
            },
          },
        }),
      ],
      notes: [],
      runCompletion: readyCompletion,
      coverage,
    };
    const complianceReadiness = {
      frameworks: [
        {
          key: 'soc2',
          label: 'SOC 2',
          selected: true,
          supported: true,
          score: 50,
          controls: [
            { id: 'CC1.1', status: 'passing', controlChecks: [{ id: 'check-1' }] },
            { id: 'CC1.2', status: 'missing', controlChecks: [] },
          ],
          statusCounts: {
            passing: 1,
            partial: 0,
            failing: 0,
            missing: 1,
            stale: 0,
            accepted_risk: 0,
            not_applicable: 0,
            not_supported: 0,
          },
          outcomeCounts: {
            passed: 1,
            failed: 0,
            needs_action: 2,
            not_checked: 24,
            excluded: 0,
          },
        },
      ],
    } as unknown as ComplianceReadinessResponse;

    const brief = renderer.renderReportContextBrief({
      reportState,
      reportable: reportState.findings,
      candidates: [],
      complianceReadiness,
      recommendedSections: ['executive-summary', 'compliance-readiness'],
    });

    expect(brief).toContain('# Reporter Handoff');
    expect(brief).toContain(COMPLIANCE_READINESS_BOUNDARY_SENTENCE);
    expect(brief).toContain('SOC 2: 1 passed, 0 failed.');
    expect(brief).toContain('This run assessed: 1/2 controls with direct agent check records.');
    expect(brief).toContain('Overall framework readiness: denominator 2; 2 need action; 24 not checked');
    expect(brief).not.toContain('% readiness');
    expect(brief).toContain('Passing=1');
    expect(brief).toContain('- executive-summary');
    expect(brief).toContain('## Validation Proof Trails');
    expect(brief).toContain('confirmed (reproduced)');
    expect(brief).toContain('Claim: The tested endpoint omits the expected security header.');
  });

  it('renders deterministic NIST CSF Function readiness without assigning an Implementation Tier', () => {
    const renderer = new RunReportRenderer();
    const outcomeCounts = { passed: 1, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 };
    const readiness = {
      frameworks: [{
        key: 'nist_csf',
        label: 'NIST CSF 2.0 Readiness',
        selected: true,
        supported: true,
        statusCounts: { passing: 1, partial: 0, failing: 0, missing: 0, stale: 0, accepted_risk: 0, not_applicable: 0, not_supported: 0 },
        outcomeCounts,
        controls: [{
          id: 'ID.AM',
          title: 'Asset management technical evidence',
          theme: 'Identify',
          verdict: 'pass',
          outcome: 'passed',
          basis: 'agent_tested',
          verdictReason: 'Current scoped inventory was reviewed.',
          evidence: [],
          coverageLimitations: ['Ownership was unavailable for one observed service.'],
          controlChecks: [],
          actionRequests: [],
        }],
        frameworkProfile: {
          kind: 'nist_csf_2_0',
          functions: ['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover'].map((functionName) => ({
            function: functionName,
            total: functionName === 'Identify' ? 1 : 0,
            monitored: functionName === 'Identify' ? 1 : 0,
            directCheckCount: 0,
            outcomeCounts: functionName === 'Identify'
              ? outcomeCounts
              : { passed: 0, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
          })),
          implementationTier: {
            status: 'not_determined',
            tier: null,
            reason: 'Implementation Tier is not derived from readiness counts.',
          },
        },
      }],
    } as unknown as ComplianceReadinessResponse;

    const section = renderer.renderCanonicalComplianceReportSection(readiness);

    expect(section).toContain('#### NIST CSF Function Readiness');
    expect(section).toContain('| Identify | 1/1 | 0 | 1 | 0 | 0 | 0 | 0 |');
    expect(section).toContain('Indicative Implementation Tier: not determined');
    expect(section).not.toMatch(/Implementation Tier:\s*(?:[1-4]|Partial|Risk Informed|Repeatable|Adaptive)/iu);
    expect(section).not.toContain('SOC 2');
    expect(section).not.toContain('ISO 27001');
  });

  it('renders HIPAA implementation specification metadata in canonical control dispositions', () => {
    const renderer = new RunReportRenderer();
    const readiness = {
      frameworks: [{
        key: 'hipaa',
        label: 'HIPAA Security Rule Readiness',
        selected: true,
        supported: true,
        statusCounts: { passing: 0, partial: 0, failing: 0, missing: 1, stale: 0, accepted_risk: 0, not_applicable: 0, not_supported: 0 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [
          {
            id: '164.308(a)(3)',
            title: 'Workforce security',
            theme: 'Administrative',
            supportLevel: 'manual_evidence_required',
            implementationSpec: 'addressable',
            verdict: 'not_attempted',
            outcome: 'not_checked',
            basis: null,
            verdictReason: 'No workforce authorization evidence was found.',
            evidence: [],
            coverageLimitations: [],
            controlChecks: [],
            actionRequests: [],
          },
        ],
      }],
    } as unknown as ComplianceReadinessResponse;

    const section = renderer.renderCanonicalComplianceReportSection(readiness);

    expect(section).toContain('### HIPAA Security Rule Readiness');
    expect(section).toContain('#### Administrative');
    expect(section).toContain('164.308(a)(3) - Workforce security');
    expect(section).toContain('HIPAA implementation specification: addressable');
    expect(section).not.toContain('SOC 2');
    expect(section).not.toContain('NIST CSF');
  });

  it('renders PCI DSS context metadata in canonical control dispositions', () => {
    const renderer = new RunReportRenderer();
    const readiness = {
      frameworks: [{
        key: 'pci_dss',
        label: 'PCI DSS v4.0.1 Readiness',
        selected: true,
        supported: true,
        statusCounts: { passing: 0, partial: 0, failing: 0, missing: 1, stale: 0, accepted_risk: 0, not_applicable: 0, not_supported: 0 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [
          {
            id: '11.6.1',
            title: 'Payment page change and tamper detection is in place',
            theme: 'Regularly Monitor and Test Networks',
            supportLevel: 'automated_testable',
            pciDssRequirement: '11',
            pciDssGoal: 'Regularly Monitor and Test Networks',
            pciDssApproach: 'defined',
            pciDssSaqTypes: ['A', 'A-EP', 'D-Merchant'],
            pciDssCdeScope: 'payment_page',
            pciDssAccountData: 'pan',
            verdict: 'not_attempted',
            outcome: 'not_checked',
            basis: null,
            verdictReason: 'No payment page monitoring evidence was found.',
            evidence: [],
            coverageLimitations: [],
            controlChecks: [],
            actionRequests: [],
          },
        ],
      }],
    } as unknown as ComplianceReadinessResponse;

    const section = renderer.renderCanonicalComplianceReportSection(readiness);

    expect(section).toContain('### PCI DSS v4.0.1 Readiness');
    expect(section).toContain('11.6.1 - Payment page change and tamper detection is in place');
    expect(section).toContain('PCI DSS context: requirement 11; approach defined; CDE scope payment page; account data PAN; SAQ A/A-EP/D-Merchant');
    expect(section).not.toContain('HIPAA');
    expect(section).not.toContain('NIST CSF');
  });

  it('renders GDPR boundary language in canonical control dispositions', () => {
    const renderer = new RunReportRenderer();
    const readiness = {
      frameworks: [{
        key: 'gdpr',
        label: 'GDPR Readiness',
        selected: true,
        supported: true,
        statusCounts: { passing: 0, partial: 0, failing: 0, missing: 1, stale: 0, accepted_risk: 0, not_applicable: 0, not_supported: 0 },
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
        controls: [
          {
            id: 'GDPR-DATA-ROPA',
            title: 'Record of processing activities evidence',
            theme: 'Processing Records and Legal Basis',
            supportLevel: 'manual_evidence_required',
            verdict: 'not_attempted',
            outcome: 'not_checked',
            basis: null,
            verdictReason: 'No RoPA or processing register was found.',
            evidence: [],
            coverageLimitations: [],
            controlChecks: [],
            actionRequests: [],
          },
        ],
      }],
    } as unknown as ComplianceReadinessResponse;

    const section = renderer.renderCanonicalComplianceReportSection(readiness);

    expect(section).toContain('### GDPR Readiness');
    expect(section).toContain(GDPR_READINESS_BOUNDARY_SENTENCE);
    expect(section).toContain('GDPR-DATA-ROPA - Record of processing activities evidence');
    expect(section).not.toContain('HIPAA');
    expect(section).not.toContain('PCI DSS');
  });

  it('renders fallback summary and report artifacts from the same report state', () => {
    const renderer = new RunReportRenderer();
    const coverage: ReportRendererCoverageSummary = {
      plan: { total: 1, completed: 1, blocked: 0, pending: 0, running: 0, error: 0 },
      missionQuestions: ['What public HTTP surface exists?'],
      missionSkills: ['recon'],
      noteCounts: [{ ntype: 'run.digest', count: 1 }],
      testedClasses: ['header review'],
      blockers: [],
      openDebts: [],
      runDigest: {
        goal: 'Assess public web surface',
        outcome: 'No exploitable issue confirmed',
        completedTasks: ['mapped public routes'],
        blockedTasks: [],
        nextPrerequisites: [],
      },
      approaches: [{ technique: 'header review', endpoint: '/', result: 'missing header confirmed' }],
      scanCoverage: [],
      endpoints: [{ method: 'GET', url: 'https://example.test/', statusCode: 200, title: 'Home' }],
      technologies: [],
      reportSections: [],
      scannerOutcomes: [],
    };

    const summary = renderer.renderSummaryArtifact({
      mode: 'interim',
      reason: 'operator requested closeout',
      runCompletion: readyCompletion,
      findings: [finding()],
      coverage,
    });
    const report = renderer.renderReportArtifact({
      mode: 'final',
      runCompletion: readyCompletion,
      findings: [
        finding({
          validationProof: {
            schemaVersion: 1,
            proof: {
              claim: 'The finding is non-idempotent but proven by captured evidence.',
              evidenceIds: [],
              replayAttempted: false,
              notReplayedReason: 'non_idempotent',
            },
            obligations: [
              {
                id: 'primary-observable',
                observable: 'State change was observed once and replay would be unsafe.',
                status: 'needs_context',
                evidenceIds: [],
              },
            ],
            advisoryTriage: {
              verdict: 'needs_context',
              reason: 'Replay is risky but the finding remains reportable.',
              triagedBy: 'inline_validation_advisory',
              evidenceIds: [],
              flags: ['risky_to_replay'],
            },
          },
        }),
      ],
      coverage,
    });

    expect(summary).toContain('# Run Summary (interim)');
    expect(summary).toContain('Reportable findings: 1 (1 medium)');
    expect(report).toContain('# Security Assessment Report - Assess public web surface');
    expect(report).toContain('## 5. Findings - Detailed Analysis');
    expect(report).toContain('### 1. Missing security header');
    expect(report).not.toContain('Confidence:');
    expect(report).not.toContain('- Confidence: 0.9');
    expect(report).toContain('confirmed (reproduction not applicable: non idempotent)');
    expect(report).toContain('#### Validation Proof');
    expect(report).toContain('## Appendix A - Evidence Index');
  });

  it('renders controlled exploitation impact and cleanup separately in final reports', () => {
    const renderer = new RunReportRenderer();
    const coverage: ReportRendererCoverageSummary = {
      plan: { total: 1, completed: 1, blocked: 0, pending: 0, running: 0, error: 0 },
      missionQuestions: ['Can command injection be demonstrated safely?'],
      missionSkills: ['controlled-exploitation'],
      noteCounts: [],
      testedClasses: ['command injection'],
      blockers: [],
      openDebts: [],
      runDigest: {
        goal: 'Assess command injection impact',
        outcome: 'Impact demonstrated with cleanup risk',
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
    };

    const report = renderer.renderReportArtifact({
      mode: 'final',
      runCompletion: readyCompletion,
      findings: [
        finding({
          title: 'Command injection reaches shell execution',
          severity: 'critical',
          validationProof: {
            schemaVersion: 1,
            proof: {
              claim: 'The vulnerable parameter changes command execution behavior.',
              evidenceIds: ['validation:http-diff'],
              replayAttempted: true,
              replayReproduced: true,
            },
            obligations: [
              {
                id: 'primary-observable',
                observable: 'Response includes a command-derived marker.',
                status: 'proven',
                evidenceIds: ['validation:http-diff'],
              },
            ],
            advisoryTriage: {
              verdict: 'agree',
              reason: 'The replayed marker is bound to the vulnerable endpoint.',
              triagedBy: 'inline_validation_advisory',
              evidenceIds: ['validation:http-diff'],
              flags: [],
            },
          },
          evidence: [
            {
              findingId: 'finding-1',
              kind: 'artifact',
              path: '/workspace/.artifacts/workers/attack/task-1/attack-result.json',
              displayPath: '/workspace/.artifacts/workers/attack/task-1/attack-result.json',
              label: 'Controlled exploitation result',
              excerpt: null,
              fileMissing: false,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              data: {
                schemaVersion: 1,
                missionId: 'task-1',
                validatedFindingIds: ['finding-1'],
                targetRef: 'https://xben.example.test/vulnerable?cmd=marker',
                objectiveFamily: 'demonstrate_command_execution',
                status: 'cleanup_failed',
                attempts: [
                  {
                    sequence: 1,
                    action: 'write bounded marker and read command output',
                    status: 'completed',
                    evidenceIds: ['impact:http-proof'],
                    changedState: true,
                  },
                ],
                proofClaim: 'Command execution created and returned marker NULLAI-B8.',
                evidenceIds: ['impact:http-proof'],
                changedStateSummary: 'Created marker file NULLAI-B8 in the isolated target.',
                cleanup: {
                  required: true,
                  status: 'failed',
                  actions: ['attempted marker deletion'],
                  evidenceIds: ['cleanup:delete-attempt'],
                  remainingRisk: 'Marker deletion endpoint returned 500.',
                },
                limitations: ['Target was isolated to the evaluation container.'],
                policySnapshot: {
                  featureEnabled: true,
                  organizationAllowlisted: true,
                  runTrigger: 'manual',
                  workflowDiscipline: 'pentest',
                  impactTolerance: 'full',
                  phaseKey: 'exploitation',
                  verifiedTarget: true,
                  requestBudget: 8,
                  toolBudget: 5,
                  timeBudgetSeconds: 120,
                  capturedAt: '2026-01-01T00:00:00.000Z',
                },
              },
            },
          ],
        }),
      ],
      coverage,
    });

    expect(report).toContain('#### Validation Proof - Validated Primitive');
    expect(report).toContain('Claim: The vulnerable parameter changes command execution behavior.');
    expect(report).toContain('#### Demonstrated Impact');
    expect(report).toContain('- Proof: Command execution created and returned marker NULLAI-B8.');
    expect(report).toContain('- Impact evidence: impact:http-proof');
    expect(report).toContain('#### Cleanup Status');
    expect(report).toContain('- **ATTENTION - CLEANUP FAILED: Marker deletion endpoint returned 500.**');
    expect(report).toContain('- Cleanup evidence: cleanup:delete-attempt');
    expect(report).toContain('- Remaining risk: Marker deletion endpoint returned 500.');
    expect(report).toContain('## Appendix A - Evidence Index');
    expect(report).toContain('Controlled exploitation result');
  });
});
