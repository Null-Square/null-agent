import { describe, expect, it } from 'vitest';

import {
  buildComplianceReadinessSnapshot,
  extractSelectedComplianceFrameworks,
  type ComplianceReadinessBuildInput,
} from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { RecordControlRequestSchema } from '@/domains/security-ops/compliance/ComplianceControlRequestService';

const baseInput = (): ComplianceReadinessBuildInput => ({
  generatedAt: new Date('2026-05-14T00:00:00.000Z'),
  organizationId: 'org-1',
  scopeId: 'scope-1',
  runId: 'run-1',
  selectedFrameworks: [
    {
      key: 'soc2',
      label: 'SOC 2 Technical Readiness',
      sources: ['organization_context'],
    },
  ],
  facts: {
    findings: [],
    notes: [],
    scannerObservations: [],
    assets: [],
    services: [],
    acceptedRisks: [],
    completedRunCount: 0,
    latestCompletedRunId: null,
  },
});

const monitorControls = (
  input: ComplianceReadinessBuildInput,
  frameworkKey: ComplianceReadinessBuildInput['selectedFrameworks'][number]['key'],
  ...controlIds: string[]
): void => {
  input.facts = {
    ...input.facts,
    controlStates: [
      ...(input.facts.controlStates ?? []),
      ...controlIds.map((controlId) => ({
        frameworkKey,
        controlId,
        state: 'monitored' as const,
        exclusionReason: null,
        assignedToUserId: null,
        assignedByUserId: null,
        assignedAt: null,
        updatedAt: '2026-05-14T00:00:00.000Z',
      })),
    ],
  };
};

describe('ComplianceReadinessService rules', () => {
  it('extracts selected frameworks from the scope compliance profile', () => {
    const selected = extractSelectedComplianceFrameworks({
      scopeComplianceFrameworks: ['soc2', 'hipaa', 'nist_csf', 'iso27001'],
    });

    expect(selected.map((item) => item.key)).toEqual([
      'soc2',
      'hipaa',
      'iso27001',
      'nist_csf',
    ]);
    expect(selected.every((item) => item.sources.includes('scope_profile'))).toBe(true);
  });

  it('does not auto-select frameworks from empty or invalid scope profile values', () => {
    const selected = extractSelectedComplianceFrameworks({
      scopeComplianceFrameworks: ['unknown', '', null],
    });

    expect(selected).toEqual([]);
  });

  it('uses structured scope compliance profile as the selected framework source', () => {
    const selected = extractSelectedComplianceFrameworks({
      scopeComplianceFrameworks: ['iso27001'],
    });

    expect(selected).toEqual([
      {
        key: 'iso27001',
        label: 'ISO 27001 Readiness',
        sources: ['scope_profile'],
      },
    ]);
  });

  it('deduplicates scope compliance profile values and preserves framework order', () => {
    const selected = extractSelectedComplianceFrameworks({
      scopeComplianceFrameworks: ['pci_dss', 'soc2', 'soc2'],
    });

    expect(selected.map((item) => item.key)).toEqual(['soc2', 'pci_dss']);
    expect(selected.every((item) => item.sources.includes('scope_profile'))).toBe(true);
  });

  it('keeps inactive controls visible but removes them from the active readiness denominator', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      controlStates: [
        {
          frameworkKey: 'soc2',
          controlId: 'CC6.1',
          state: 'excluded',
          exclusionReason: 'The selected scope has no customer-facing auth boundary.',
          assignedToUserId: 'user-2',
          assignedByUserId: 'user-1',
          assignedAt: '2026-06-24T00:00:00.000Z',
          updatedAt: '2026-06-24T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const framework = snapshot.frameworks[0]!;
    const excludedControl = framework.controls.find((control) => control.id === 'CC6.1')!;
    const activeTechnicalControls = framework.controls.filter(
      (control) => control.supportLevel === 'automated_testable' && control.monitoring.state === 'monitored',
    );

    expect(excludedControl.monitoring).toEqual({
      state: 'excluded',
      source: 'explicit',
      exclusionReason: 'The selected scope has no customer-facing auth boundary.',
      updatedAt: '2026-06-24T00:00:00.000Z',
    });
    expect(excludedControl.assignment.assignedToUserId).toBe('user-2');
    expect(excludedControl.status).toBe('not_applicable');
    expect(excludedControl.outcome).toBe('excluded');
    expect(excludedControl.reasonCode).toBe('control_excluded');
    expect(snapshot.scorecards.agentProvenTechnical.total).toBe(activeTechnicalControls.length);
  });

  it('keeps an untouched monitored manual control neutral (not_attempted / not_checked)', () => {
    const input = baseInput();
    monitorControls(input, 'soc2', 'CC1.1');

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc11 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC1.1');
    // No observation yet: the verdict stays neutral (not_attempted) and the outcome is not_checked.
    // supportLevel never manufactures a needs_evidence verdict for a control nobody has assessed.
    expect(cc11?.verdict).toBe('not_attempted');
    expect(cc11?.outcome).toBe('not_checked');
    // It still counts as missing customer evidence in the scorecard.
    expect(snapshot.scorecards.customerEvidence.missing).toBeGreaterThan(0);
  });

  it('builds SOC 2 readiness from scan coverage, inventory, and auth findings', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      services: [
        {
          id: 'service-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      notes: [
        {
          ntype: 'scan.coverage',
          title: 'Broad scan complete',
          data: { status: 'completed', family: 'broad-surface-scan' },
          evidence: [{ path: '.artifacts/scanners/httpx.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'approach.tried',
          title: 'Authorization boundary checked',
          data: { technique: 'idor replay', endpoint: '/api/users/{id}', result: 'blocked by access control' },
          evidence: [{ path: '.artifacts/poc/auth-boundary.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: { outcome: 'completed' },
          evidence: [],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      findings: [
        {
          id: 'finding-1',
          title: 'Validated IDOR exposes tenant records',
          severity: 'high',
          state: 'confirmed',
          summary: 'Broken object authorization allows cross-tenant access.',
          businessImpact: null,
          technicalAnalysis: 'IDOR authorization failure.',
          remediation: null,
          cweId: 'CWE-639',
          cweIds: ['CWE-639'],
          owaspCategory: 'A01:2021-Broken Access Control',
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:finding-1',
              displayPath: 'HTTP exchange finding-1',
              label: 'replay',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const soc2 = snapshot.frameworks[0]!;

    expect(soc2.key).toBe('soc2');
    expect(soc2.supported).toBe(true);
    expect(soc2.controls.some((control) => control.id === 'CC7.2' && control.status === 'partial')).toBe(true);
    expect(soc2.controls.find((control) => control.id === 'CC7.2')?.verdict).toBe('not_attempted');
    expect(soc2.controls.find((control) => control.id === 'CC7.2')?.supportLevel).toBe('automated_testable');
    const cc61 = soc2.controls.find((control) => control.id === 'CC6.1');
    expect(cc61?.status).toBe('partial');
    expect(cc61?.verdict).toBe('not_attempted');
    expect(cc61?.verdictReason).toContain('direct control verdict still needs a fresh control check');
    expect(snapshot.reportRequest.canStart).toBe(true);
  });

  it('requires a completed run before readiness report sessions can start', () => {
    const snapshot = buildComplianceReadinessSnapshot(baseInput());

    expect(snapshot.reportRequest.canStart).toBe(false);
    expect(snapshot.reportRequest.reason).toContain('Run a technical control assessment');
  });

  it('represents the full SOC 2 Security common-criteria matrix and tracks user-evidence controls as missing until approved', () => {
    const snapshot = buildComplianceReadinessSnapshot(baseInput());
    const soc2 = snapshot.frameworks[0]!;
    const controlIds = soc2.controls.map((control) => control.id);

    expect(controlIds).toHaveLength(33);
    expect(controlIds[0]).toBe('CC1.1');
    expect(controlIds).toContain('CC8.1');
    expect(controlIds[controlIds.length - 1]).toBe('CC9.2');
    expect(soc2.controls.find((control) => control.id === 'CC1.1')?.status).toBe('missing');
    expect(soc2.controls.find((control) => control.id === 'CC9.2')?.status).toBe('missing');
  });

  it('keeps accepted risk separate from passing readiness', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      acceptedRisks: [
        {
          id: 'risk-1',
          frameworkKey: 'soc2',
          controlId: 'CC6.1',
          evidenceItemId: null,
          owner: 'CISO',
          rationale: 'Temporary exception while a compensating control is deployed.',
          status: 'active',
          approvedBy: 'reviewer-1',
          approvedAt: '2026-05-14T00:00:00.000Z',
          expiresAt: '2026-08-14T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc61 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.1');
    expect(cc61?.status).toBe('accepted_risk');
    expect(snapshot.frameworks[0]?.statusCounts.accepted_risk).toBe(1);
    expect(snapshot.frameworks[0]?.statusCounts.passing).toBe(0);
  });

  const validatedNegativeFinding = (severity: 'critical' | 'high' | 'medium') => ({
    id: `finding-${severity}`,
    title: `Validated IDOR (${severity}) exposes tenant records`,
    severity,
    state: 'confirmed' as const,
    summary: 'Broken object authorization allows cross-tenant access.',
    businessImpact: null,
    technicalAnalysis: 'IDOR authorization failure.',
    remediation: null,
    cweId: 'CWE-639',
    cweIds: ['CWE-639'],
    owaspCategory: 'A01:2021-Broken Access Control',
    assetValue: 'app.example.com',
    lastSeenAt: '2026-05-13T00:00:00.000Z',
    evidence: [
      {
        kind: 'http_exchange',
        path: `http_exchange:finding-${severity}`,
        displayPath: `HTTP exchange finding-${severity}`,
        label: 'replay',
        fileMissing: false,
        createdAt: '2026-05-13T00:00:00.000Z',
      },
    ],
  });

  const acceptedRiskOnCc61 = {
    id: 'risk-1',
    frameworkKey: 'soc2' as const,
    controlId: 'CC6.1',
    evidenceItemId: null,
    owner: 'CISO',
    rationale: 'Temporary exception while a compensating control is deployed.',
    status: 'active' as const,
    approvedBy: 'reviewer-1',
    approvedAt: '2026-05-14T00:00:00.000Z',
    expiresAt: '2026-08-14T00:00:00.000Z',
  };

  it('keeps accepted risk separate from related finding hints until a direct control check fails', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      acceptedRisks: [acceptedRiskOnCc61],
      findings: [validatedNegativeFinding('high')],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc61 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.1');
    expect(cc61?.status).toBe('accepted_risk');
    expect(snapshot.frameworks[0]?.statusCounts.accepted_risk).toBe(1);
  });

  it('still honors accepted risk over a medium-only validated negative', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      acceptedRisks: [acceptedRiskOnCc61],
      findings: [validatedNegativeFinding('medium')],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc61 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.1');
    expect(cc61?.status).toBe('accepted_risk');
  });

  it('does not allow keyword-only finding matches to pass a control', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      findings: [
        {
          id: 'finding-keyword-1',
          title: 'Authorization review evidence',
          severity: 'low',
          state: 'resolved',
          summary: 'Authorization remediation was checked.',
          businessImpact: null,
          technicalAnalysis: null,
          remediation: null,
          cweId: null,
          cweIds: null,
          owaspCategory: null,
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:finding-keyword-1',
              displayPath: 'HTTP exchange finding-keyword-1',
              label: 'resolved',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
          skillSlugs: [],
        },
        {
          id: 'finding-keyword-2',
          title: 'Access control remediation evidence',
          severity: 'low',
          state: 'resolved',
          summary: 'Access control behavior was reviewed.',
          businessImpact: null,
          technicalAnalysis: null,
          remediation: null,
          cweId: null,
          cweIds: null,
          owaspCategory: null,
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:finding-keyword-2',
              displayPath: 'HTTP exchange finding-keyword-2',
              label: 'resolved',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
          skillSlugs: [],
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc61 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.1');

    expect(cc61?.status).toBe('partial');
    expect(cc61?.evidence).toHaveLength(2);
    expect(cc61?.evidence.every((evidence) => evidence.mappingConfidence === 'low')).toBe(true);
  });

  it('does not mark fresh scanner evidence as passing without reviewed support', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      notes: [
        {
          ntype: 'scan.coverage',
          title: 'Scanner coverage complete',
          data: { status: 'completed' },
          evidence: [{ path: '.artifacts/scanners/nuclei.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      scannerObservations: [
        {
          id: 'obs-1',
          parser: 'nuclei',
          observationType: 'template_match',
          title: 'Potential security header finding',
          severity: 'low',
          artifactPath: '.artifacts/scanners/nuclei.jsonl',
          findingId: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          id: 'obs-2',
          parser: 'trivy',
          observationType: 'dependency',
          title: 'Dependency scan observation',
          severity: 'medium',
          artifactPath: '.artifacts/scanners/trivy.jsonl',
          findingId: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc71 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC7.1');

    expect(cc71?.status).toBe('partial');
  });

  it('does not treat potential Risks as positive control evidence', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      findings: [
        {
          id: 'risk-potential',
          title: 'Possible IDOR exposes tenant records',
          severity: 'high',
          state: 'potential',
          summary: 'Authorization may be missing.',
          businessImpact: null,
          technicalAnalysis: 'Potential IDOR authorization failure.',
          remediation: null,
          cweId: 'CWE-639',
          cweIds: ['CWE-639'],
          owaspCategory: 'A01:2021-Broken Access Control',
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:risk-potential',
              displayPath: 'HTTP exchange risk-potential',
              label: 'candidate',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc61 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.1');

    expect(cc61?.status).toBe('missing');
    expect(cc61?.evidence).toEqual([]);
  });

  it('does not credit no-auth-surface notes as access-control readiness evidence', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      notes: [
        {
          ntype: 'approach.tried',
          title: 'Authentication and Authorization Surface Testing - SOC 2 CC6.1-CC6.5',
          data: {
            result:
              'No login forms, no API responses, no OAuth configuration, and no testable authentication or authorization mechanisms were discovered on the public surface.',
          },
          evidence: [{ path: '.artifacts/phases/validation/auth-surface.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'scan.coverage',
          title: 'SOC 2 CC6.1-CC6.7 Control Testing Coverage - Validation Phase',
          data: {
            status: 'completed',
            summary:
              'The scope is marketing-only with no authentication surfaces, no API endpoints, and third-party services outside direct scope.',
          },
          evidence: [{ path: '.artifacts/phases/validation/coverage.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'run.digest',
          title: 'SOC 2 Control Evidence Inventory Complete',
          data: {
            outcome: 'completed',
            next_prerequisites: ['Operator-provided credentials for the tenant admin surface'],
            blocked_prerequisite_work: ['Authenticated admin surface testing for CC6.1-CC6.6'],
          },
          evidence: [],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const controls = snapshot.frameworks[0]!.controls;

    for (const controlId of ['CC6.1', 'CC6.2', 'CC6.3', 'CC6.6']) {
      const control = controls.find((entry) => entry.id === controlId);
      expect(control?.status).toBe('missing');
      expect(control?.evidence).toEqual([]);
    }
  });

  it('does not credit endpoint-only rows as SOC 2 access-control readiness evidence', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      notes: [
        {
          ntype: 'http.endpoint',
          title: 'GET https://app.example.com/login',
          data: {
            url: 'https://app.example.com/login',
            status: 200,
          },
          evidence: [{ path: '.artifacts/scanners/ffuf.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'http.endpoint',
          title: 'GET https://app.example.com/api/users',
          data: {
            url: 'https://app.example.com/api/users',
            status: 302,
          },
          evidence: [{ path: '.artifacts/scanners/ffuf.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const controls = snapshot.frameworks[0]!.controls;

    for (const controlId of ['CC6.1', 'CC6.2']) {
      const control = controls.find((entry) => entry.id === controlId);
      expect(control?.status).toBe('missing');
      expect(control?.evidence).toEqual([]);
    }
  });

  it('supports HIPAA technical safeguards and maps validated access-control failures', () => {
    const input = baseInput();
    input.selectedFrameworks = [
      {
        key: 'hipaa',
        label: 'HIPAA Security Rule Readiness',
        sources: ['organization_profile'],
      },
    ];
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      findings: [
        {
          id: 'finding-hipaa-idor',
          title: 'Validated IDOR exposes patient record references',
          severity: 'high',
          state: 'confirmed',
          summary: 'Broken object authorization allows cross-user access.',
          businessImpact: null,
          technicalAnalysis: 'IDOR authorization failure.',
          remediation: null,
          cweId: 'CWE-639',
          cweIds: ['CWE-639'],
          owaspCategory: 'A01:2021-Broken Access Control',
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:finding-hipaa-idor',
              displayPath: 'HTTP exchange finding-hipaa-idor',
              label: 'validated',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const hipaa = snapshot.frameworks[0]!;

    expect(snapshot.supportedFrameworks).toEqual([
      'soc2',
      'gdpr',
      'hipaa',
      'pci_dss',
      'iso27001',
      'nist_csf',
    ]);
    expect(hipaa.supported).toBe(true);
    expect(hipaa.label).toBe('HIPAA Security Rule Readiness');
    expect(hipaa.controls).toHaveLength(26);
    expect(hipaa.controls.find((control) => control.id === '164.308(a)(1)')?.implementationSpec).toBe('required');
    expect(hipaa.controls.find((control) => control.id === '164.308(a)(3)')?.implementationSpec).toBe('addressable');
    expect(hipaa.controls.find((control) => control.id === '164.308(a)(7)')?.implementationSpec).toBe('mixed');
    expect(hipaa.controls.map((control) => control.id)).toContain('164.312(e)(2)(ii)');
    const accessControl = hipaa.controls.find((control) => control.id === '164.312(a)(1)');
    expect(accessControl?.status).toBe('partial');
    expect(accessControl?.verdict).toBe('not_attempted');
    expect(hipaa.controls.find((control) => control.id === '164.312(a)(2)(i)')?.status).toBe('missing');
  });

  it('supports PCI DSS, ISO, and NIST CSF evidence without runtime forks', () => {
    const input = baseInput();
    input.selectedFrameworks = [
      {
        key: 'pci_dss',
        label: 'PCI DSS v4.0.1 Readiness',
        sources: ['organization_profile'],
      },
      {
        key: 'iso27001',
        label: 'ISO 27001 Readiness',
        sources: ['organization_profile'],
      },
      {
        key: 'nist_csf',
        label: 'NIST CSF 2.0 Readiness',
        sources: ['organization_profile'],
      },
    ];
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'payments.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      services: [
        {
          id: 'service-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      notes: [
        {
          ntype: 'scan.coverage',
          title: 'Broad scan complete',
          data: { status: 'completed', family: 'broad-surface-scan' },
          evidence: [{ path: '.artifacts/scanners/httpx.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      scannerObservations: [
        {
          id: 'obs-httpx',
          parser: 'httpx',
          observationType: 'tls_endpoint',
          title: 'TLS endpoint observed',
          severity: 'info',
          artifactPath: '.artifacts/scanners/httpx.jsonl',
          findingId: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          id: 'obs-nmap',
          parser: 'nmap',
          observationType: 'open_service',
          title: 'HTTPS service observed',
          severity: 'info',
          artifactPath: '.artifacts/scanners/nmap.xml',
          findingId: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    };

    monitorControls(input, 'pci_dss', '11.3.1');
    monitorControls(input, 'iso27001', 'ISO-A-ORG-ASSETS');
    monitorControls(input, 'nist_csf', 'ID.AM');

    const snapshot = buildComplianceReadinessSnapshot(input);
    const pci = snapshot.frameworks.find((framework) => framework.key === 'pci_dss')!;
    const iso = snapshot.frameworks.find((framework) => framework.key === 'iso27001')!;
    const nist = snapshot.frameworks.find((framework) => framework.key === 'nist_csf')!;

    expect(pci.supported).toBe(true);
    expect(iso.supported).toBe(true);
    expect(nist.supported).toBe(true);
    expect(pci.controls.length).toBeGreaterThanOrEqual(35);
    expect(iso.controls.some((control) => control.id === 'ISO-A-ORG-ASSETS')).toBe(true);
    expect(nist.controls).toHaveLength(22);
    expect(pci.controls.find((control) => control.id === '11.3.1')?.status).toBe('partial');
    expect(pci.controls.find((control) => control.id === '11.3.1')?.pciDssRequirement).toBe('11');
    expect(pci.controls.find((control) => control.id === '11.3.1')?.pciDssCdeScope).toBe('cde');
    expect(pci.controls.find((control) => control.id === '12.3.2')?.pciDssApproach).toBe('customized_eligible');
    expect(pci.controls.find((control) => control.id === '3.3')?.pciDssAccountData).toBe('sad');
    expect(iso.controls.find((control) => control.id === 'ISO-A-ORG-ASSETS')?.status).toBe('partial');
    expect(nist.controls.find((control) => control.id === 'ID.AM')?.status).toBe('partial');
    expect(nist.controls.find((control) => control.id === 'GV.PO')?.status).toBe('missing');
    expect(nist.controls.find((control) => control.id === 'GV.PO')?.requiredEvidence).toContain('approved cybersecurity policies');
    expect(nist.frameworkProfile).toMatchObject({
      kind: 'nist_csf_2_0',
      implementationTier: {
        status: 'not_determined',
        tier: null,
      },
    });
    expect(nist.frameworkProfile?.functions.map((item) => item.function)).toEqual([
      'Govern',
      'Identify',
      'Protect',
      'Detect',
      'Respond',
      'Recover',
    ]);
    expect(nist.frameworkProfile?.functions.reduce((total, item) => total + item.total, 0)).toBe(22);
    expect(pci.controls.find((control) => control.id === '12.1')?.status).toBe('missing');
  });

  it('does not let agent-authored notes alone push a control to passing', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      notes: [
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: { outcome: 'completed', recommendation: 'continue coverage' },
          evidence: [{ path: '.artifacts/notes/run-digest.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'report.section',
          title: 'Monitoring section',
          data: { section: 'methodology', body: 'observation coverage achieved' },
          evidence: [{ path: '.artifacts/notes/report-section.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
        {
          ntype: 'approach.tried',
          title: 'Monitoring sweep',
          data: { technique: 'broad monitor', endpoint: 'app.example.com', result: 'coverage observed' },
          evidence: [{ path: '.artifacts/notes/monitor.md' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc41 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC4.1');

    expect(cc41?.evidence.length).toBeGreaterThan(0);
    expect(cc41?.evidence.every((item) => item.kind === 'note')).toBe(true);
    expect(cc41?.status).toBe('partial');
  });

  it('keeps a control unproven when only a validated resolved finding backs it', () => {
    const input = baseInput();
    input.facts = {
      ...input.facts,
      completedRunCount: 1,
      latestCompletedRunId: 'run-1',
      notes: [
        {
          ntype: 'scan.coverage',
          title: 'TLS sweep complete',
          data: { status: 'completed', family: 'broad-surface-scan' },
          evidence: [{ path: '.artifacts/scanners/httpx.jsonl' }],
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      scannerObservations: [
        {
          id: 'obs-httpx',
          parser: 'httpx',
          observationType: 'tls_endpoint',
          title: 'TLS endpoint observed',
          severity: 'info',
          artifactPath: '.artifacts/scanners/httpx.jsonl',
          findingId: null,
          lastSeenAt: '2026-05-13T00:00:00.000Z',
        },
      ],
      findings: [
        {
          id: 'finding-tls-resolved',
          title: 'Transport boundary verified',
          severity: 'low',
          state: 'resolved',
          summary: 'TLS configuration was reviewed and accepted.',
          businessImpact: null,
          technicalAnalysis: null,
          remediation: null,
          cweId: 'CWE-319',
          cweIds: ['CWE-319'],
          owaspCategory: null,
          assetValue: 'app.example.com',
          lastSeenAt: '2026-05-13T00:00:00.000Z',
          evidence: [
            {
              kind: 'http_exchange',
              path: 'http_exchange:finding-tls-resolved',
              displayPath: 'HTTP exchange finding-tls-resolved',
              label: 'validated',
              fileMissing: false,
              createdAt: '2026-05-13T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    const snapshot = buildComplianceReadinessSnapshot(input);
    const cc67 = snapshot.frameworks[0]?.controls.find((control) => control.id === 'CC6.7');

    expect(cc67?.status).toBe('partial');
    expect(cc67?.verdict).toBe('not_attempted');
    expect(cc67?.evidence.some((item) => item.kind === 'finding')).toBe(true);
  });

  it('marks an automated control passed from a fresh direct control check', () => {
    const input = baseInput();
    input.facts.controlChecks = [{
      id: 'check-1',
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      verdict: 'pass',
      reasonCode: 'control_operating',
      reason: 'Authentication and tenant authorization rejected every unauthorized request in the tested endpoint set.',
      proofObligationId: 'soc2-cc6.1-authz-v1',
      method: 'HTTP differential test',
      toolName: 'http_differential',
      skillSlug: 'idor',
      targetRef: 'https://app.example.com/api/admin',
      evidenceRefs: ['http:authz-check-1'],
      findingIds: [],
      artifactIds: [],
      proof: { claim: 'Unauthorized identities cannot access protected resources.', evidenceIds: ['http:authz-check-1'], replayAttempted: true, replayArtifact: 'evidence/authz.json', replayReproduced: true },
      limitations: ['Only the selected admin endpoints were tested.'],
      freshUntil: '2026-08-12T00:00:00.000Z',
      runId: 'run-1',
      sessionId: 'session-1',
      createdAt: '2026-05-14T00:00:00.000Z',
    }];

    const control = buildComplianceReadinessSnapshot(input).frameworks[0]?.controls.find((item) => item.id === 'CC6.1');

    expect(control).toMatchObject({ status: 'passing', verdict: 'pass', outcome: 'passed' });
    expect(control?.controlChecks[0]).toMatchObject({ id: 'check-1', fresh: true });
  });

  it('lets a fresh failed check outrank a fresh pass', () => {
    const input = baseInput();
    const baseCheck = {
      id: 'check-pass', frameworkKey: 'soc2' as const, controlId: 'CC6.1', verdict: 'pass' as const,
      reasonCode: 'control_operating', reason: 'Authorization rejected unauthorized access in the first tested endpoint set.',
      proofObligationId: 'soc2-cc6.1-authz-v1', method: 'HTTP differential test', toolName: null, skillSlug: 'idor',
      targetRef: 'https://app.example.com/api', evidenceRefs: ['http:pass-check'], findingIds: [], artifactIds: [],
      proof: { claim: 'Authorization rejected unauthorized access.', evidenceIds: ['http:pass-check'], replayAttempted: true },
      limitations: [], freshUntil: '2026-08-12T00:00:00.000Z', runId: 'run-1', sessionId: 'session-1', createdAt: '2026-05-13T00:00:00.000Z',
    };
    input.facts.controlChecks = [baseCheck, {
      ...baseCheck,
      id: 'check-fail',
      verdict: 'fail',
      reasonCode: 'control_failed',
      reason: 'A lower-privilege identity accessed another tenant resource during the second test.',
      evidenceRefs: ['http:fail-check'],
      proof: { claim: 'Cross-tenant access was possible.', evidenceIds: ['http:fail-check'], replayAttempted: true },
      createdAt: '2026-05-14T00:00:00.000Z',
    }];

    const control = buildComplianceReadinessSnapshot(input).frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control).toMatchObject({ status: 'failing', verdict: 'fail', outcome: 'failed' });
  });

  it('surfaces remediation request hints as the failed control next action', () => {
    const input = baseInput();
    input.facts.controlChecks = [{
      id: 'check-fail',
      frameworkKey: 'soc2',
      controlId: 'CC6.7',
      verdict: 'fail',
      reasonCode: 'control_failed',
      reason: 'HTTP serves content without redirecting to HTTPS.',
      proofObligationId: 'soc2-cc6.7-transport-encryption-v1',
      method: 'HTTP/HTTPS comparison',
      toolName: null,
      skillSlug: 'compliance-technical-readiness',
      targetRef: 'https://app.example.com',
      evidenceRefs: ['http:transport-check'],
      findingIds: [],
      artifactIds: [],
      proof: {
        claim: 'Cleartext HTTP served content.',
        evidenceIds: ['http:transport-check'],
        replayAttempted: true,
      },
      limitations: [],
      freshUntil: '2026-08-12T00:00:00.000Z',
      runId: 'run-1',
      sessionId: 'session-1',
      createdAt: '2026-05-14T00:00:00.000Z',
    }];
    input.facts.controlRequests = [{
      id: 'request-remediation',
      frameworkKey: 'soc2',
      controlId: 'CC6.7',
      requestType: 'remediation',
      priority: 'high',
      status: 'open',
      title: 'Enforce HTTPS transport',
      reason: 'The control failed because HTTP serves the same application content.',
      requestedEvidence: ['HTTP to HTTPS redirect proof', 'HSTS response header evidence'],
      remediationHint: 'Redirect port 80 to HTTPS, enable HSTS on HTTPS responses, then rerun the transport check.',
      assignedToUserId: null,
      dueAt: null,
      fulfillmentEvidenceItemId: null,
      fulfillmentNote: null,
      fulfilledByUserId: null,
      fulfilledAt: null,
      reviewControlCheckId: null,
      reviewNote: null,
      reviewedByActorType: null,
      reviewedByActorId: null,
      reviewedAt: null,
      nextReverificationAt: null,
      runId: 'run-1',
      sessionId: 'session-1',
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    }];

    const control = buildComplianceReadinessSnapshot(input).frameworks[0]?.controls.find((item) => item.id === 'CC6.7');

    expect(control).toMatchObject({ status: 'failing', verdict: 'fail', outcome: 'needs_action' });
    expect(control?.nextAction).toContain('Redirect port 80 to HTTPS');
  });

  it('requires remediation requests to include a concrete remediation hint', () => {
    const result = RecordControlRequestSchema.safeParse({
      frameworkKey: 'soc2',
      controlId: 'CC6.7',
      requestType: 'remediation',
      title: 'Fix transport encryption',
      reason: 'The current transport behavior failed the control check.',
      requestedEvidence: ['Retest output showing redirect and HSTS'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'remediationHint')).toBe(true);
  });

  it('derives check freshness at read time', () => {
    const input = baseInput();
    input.facts.controlChecks = [{
      id: 'check-stale', frameworkKey: 'soc2', controlId: 'CC6.1', verdict: 'pass', reasonCode: 'control_operating',
      reason: 'Authentication and authorization passed when the endpoint set was tested.',
      proofObligationId: 'soc2-cc6.1-authz-v1', method: 'HTTP differential test', toolName: null, skillSlug: 'idor',
      targetRef: 'https://app.example.com/api', evidenceRefs: ['http:old-check'], findingIds: [], artifactIds: [],
      proof: { claim: 'Unauthorized access was rejected.', evidenceIds: ['http:old-check'], replayAttempted: true },
      limitations: [], freshUntil: '2026-05-13T23:59:59.000Z', runId: 'run-1', sessionId: 'session-1', createdAt: '2026-02-01T00:00:00.000Z',
    }];

    const control = buildComplianceReadinessSnapshot(input).frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control).toMatchObject({ status: 'stale', verdict: 'needs_evidence', outcome: 'needs_action' });
  });
});
