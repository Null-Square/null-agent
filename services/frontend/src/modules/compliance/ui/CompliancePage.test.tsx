/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { AppPathProvider, DEFAULT_APP_PATHS } from '@shared/contexts/AppPathContext';
import { ScopeContextProvider } from '@shared/contexts/ScopeContext';
import type { ComplianceReadinessResponse } from '@/modules/security-ops/types';
import CompliancePage from './CompliancePage';

// The page reads through the real query hooks; only the HTTP layer is stubbed,
// answering the paths each test sets and refusing every other one.
const apiRoutes = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@shared/api', async () => {
  const actual = await vi.importActual<typeof import('@shared/api')>('@shared/api');
  return {
    ...actual,
    fetchApi: {
      ...actual.fetchApi,
      get: vi.fn(async (url: string) => {
        if (url in apiRoutes.current) {
          return { data: apiRoutes.current[url], status: 200, statusText: 'OK' };
        }
        throw new Error(`No test response for ${url}`);
      }),
    },
  };
});

const readiness: ComplianceReadinessResponse = {
  generatedAt: '2026-05-14T00:00:00.000Z',
  organizationId: 'org-1',
  scopeId: 'scope-1',
  runId: null,
  selectedFrameworks: [
    {
      key: 'soc2',
      label: 'SOC 2 Technical Readiness',
      sources: ['organization_context'],
    },
  ],
  supportedFrameworks: ['soc2'],
  latestCompletedRunId: 'run-1',
  scorecards: {
    agentProvenTechnical: { total: 1, passed: 0, failed: 1, needsContext: 0, notAttempted: 0, stale: 0 },
    customerEvidence: { total: 1, approved: 0, missing: 1, stale: 0, integrationRequired: 0, acceptedRisk: 0 },
    outcomes: { passed: 0, failed: 1, needs_action: 0, not_checked: 0, excluded: 1 },
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
      score: 67,
      statusCounts: {
        passing: 1,
        partial: 1,
        failing: 1,
        missing: 1,
        stale: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 1,
      },
      outcomeCounts: { passed: 0, failed: 1, needs_action: 0, not_checked: 0, excluded: 1 },
      verdictCounts: { pass: 0, fail: 1, needs_evidence: 0, needs_context: 0, not_attempted: 0, accepted_risk: 0, not_applicable: 0, not_supported: 1 },
      gaps: ['No TLS evidence was found.'],
      coverageLimitations: ['User-evidence controls are tracked but excluded from scoring.'],
      controls: [
        {
          id: 'CC6.1',
          title: 'Logical access control and authentication',
          theme: 'Access Control',
          supportLevel: 'automated_testable',
          status: 'failing',
          verdict: 'fail',
          outcome: 'failed',
          reasonCode: 'validated_finding',
          verdictReason: 'A validated cross-tenant read proves the access-control boundary failed.',
          score: 20,
          rationale: '1 validated open finding indicates this control needs remediation.',
          evidence: [
            {
              id: 'finding:finding-1',
              kind: 'finding',
              title: 'Cross tenant object read',
              source: 'validated open finding',
              sourceRef: 'HTTP exchange finding-1',
              lastSeenAt: '2026-05-13T00:00:00.000Z',
              findingId: 'finding-1',
              severity: 'high',
              validationState: 'validated',
              negative: true,
              mappingSource: 'skill',
              mappingConfidence: 'high',
              skillSlugs: ['idor'],
              quality: {
                traceable: true,
                fresh: true,
                trustedSource: true,
                scopeComplete: true,
                humanReviewed: true,
                score: 100,
              },
            },
          ],
          gaps: ['Validated open findings must be remediated or accepted as risk.'],
          coverageLimitations: [],
          catalogRef: 'soc2:CC6.1',
          proofObligation: { id: 'soc2-cc6.1-authz-v1', statement: 'Unauthorized identities cannot access protected resources across the tested scope.' },
          requiredEvidence: ['authorized request', 'unauthorized request'],
          nextAction: 'Remediate the cross-tenant access, then run the control check again.',
          evidenceFreshness: { freshestAt: '2026-05-13T00:00:00.000Z', stale: false },
          monitoring: { state: 'monitored', source: 'default', exclusionReason: null, updatedAt: null },
          assignment: { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
          actionRequests: [],
          controlChecks: [
            {
              id: 'check-1',
              verdict: 'fail',
              reasonCode: 'control_failed',
              reason: 'Cross-tenant replay reproduced unauthorized object access.',
              proofObligationId: 'soc2-cc6.1-authz-v1',
              method: 'HTTP differential replay',
              toolName: 'http-replay',
              skillSlug: 'idor',
              targetRef: 'GET /api/objects/:id',
              evidenceRefs: ['finding:finding-1'],
              findingIds: ['finding-1'],
              artifactIds: [],
              proof: {
                claim: 'A second tenant could retrieve the protected object.',
                evidenceIds: ['finding:finding-1'],
                replayAttempted: true,
                replayArtifact: 'finding:finding-1',
                replayReproduced: true,
              },
              limitations: ['One object type was tested.'],
              freshUntil: '2026-08-12T00:00:00.000Z',
              runId: 'run-1',
              sessionId: 'session-1',
              createdAt: '2026-05-13T00:00:00.000Z',
              fresh: true,
              eligible: true,
              reviewStatus: 'unreviewed',
              latestReview: null,
              reviewHistory: [],
            },
          ],
        },
        {
          id: 'CC1.1',
          title: 'Integrity and ethical values',
          theme: 'Control Environment',
          supportLevel: 'manual_evidence_required',
          status: 'not_supported',
          verdict: 'not_supported',
          outcome: 'excluded',
          reasonCode: 'not_supported',
          verdictReason: 'This control requires organization-owned process or policy evidence.',
          score: 0,
          rationale: 'This control requires organization-owned process or policy evidence.',
          evidence: [],
          gaps: [],
          coverageLimitations: ['Tracked but excluded from agent-proven readiness scoring.'],
          catalogRef: 'soc2:CC1.1',
          proofObligation: null,
          requiredEvidence: [],
          nextAction: 'No agent request is open for this control yet.',
          evidenceFreshness: { freshestAt: null, stale: false },
          monitoring: {
            state: 'excluded',
            source: 'default',
            exclusionReason: 'Not in the agent-testable scope for this framework.',
            updatedAt: null,
          },
          assignment: { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
          actionRequests: [],
          controlChecks: [],
        },
      ],
    },
  ],
};

const renderPage = (readinessOverride: ComplianceReadinessResponse = readiness) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  apiRoutes.current = {
    '/app/dashboard/compliance-readiness': readinessOverride,
    '/app/compliance/reports': {
      reports: [
        {
          runId: 'run-report-1',
          displayId: '#r42',
          title: 'SOC 2 Technical Readiness Report',
          framework: 'soc2',
          frameworkLabel: 'SOC 2 Technical Readiness',
          source: 'dashboard-readiness',
          sourceRunId: 'run-1',
          status: 'completed',
          createdAt: '2026-05-14T00:00:00.000Z',
          updatedAt: '2026-05-14T00:00:00.000Z',
          completedAt: '2026-05-14T00:10:00.000Z',
        },
      ],
    },
    '/app/compliance/evidence': { evidence: [] },
    '/app/compliance/missing-evidence': { missing: [] },
  };

  return render(
    <QueryClientProvider client={queryClient}>
      <AppPathProvider value={DEFAULT_APP_PATHS}>
        <ScopeContextProvider
          value={{
            activeScopeId: 'scope-1',
            setActiveScopeId: vi.fn(),
            scopes: [{ id: 'scope-1', name: 'Production', description: null, status: 'active' }],
            isLoading: false,
          }}
        >
          <MemoryRouter>
            <CompliancePage />
          </MemoryRouter>
        </ScopeContextProvider>
      </AppPathProvider>
    </QueryClientProvider>,
  );
};

// Control groups are folded by default; expand every collapsed group so control rows render.
// Scoped to the group toggles so it never trips the query bar's facet triggers,
// which carry aria-expanded too.
const expandAllGroups = () => {
  document
    .querySelectorAll('button[data-group-toggle][aria-expanded="false"]')
    .forEach((button) => fireEvent.click(button));
};

// The monitoring lane is a facet of the shared query bar, not a row of buttons.
const selectMonitoringLane = (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: /monitoring lane/i }));
  fireEvent.click(screen.getByRole('option', { name }));
};

describe('CompliancePage', () => {
  it('renders SOC 2 readiness controls with evidence mapping details', async () => {
    renderPage();
    await screen.findAllByText('SOC 2 Technical Readiness');
    expandAllGroups();

    expect(screen.getByText('Control Readiness')).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 monitored controls have an agent-readable outcome/i)).toBeInTheDocument();
    expect(screen.queryByText('67%')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run soc 2 readiness/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate report/i })).not.toBeInTheDocument();
    // Default Monitored view shows the monitored control.
    expect(screen.getByText('CC6.1')).toBeInTheDocument();
    expect(screen.getAllByText(/validated cross-tenant read proves/i)).not.toHaveLength(0);
    expect(screen.getAllByText('Monitored')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /CC6\.1/i })).toHaveTextContent('1 mapped');
    expect(screen.queryByText('Evidence required')).not.toBeInTheDocument();
    // The excluded control is not in the default Monitored view; it appears under the Excluded filter.
    expect(screen.queryByText('CC1.1')).not.toBeInTheDocument();
    selectMonitoringLane(/excluded/i);
    expandAllGroups();
    expect(screen.getByText('CC1.1')).toBeInTheDocument();
  });

  it('filters controls by monitoring view', async () => {
    renderPage();
    await screen.findAllByText('SOC 2 Technical Readiness');

    // Excluded view shows the excluded control, hides the monitored one.
    selectMonitoringLane(/excluded/i);
    expandAllGroups();
    expect(screen.getByText('CC1.1')).toBeInTheDocument();
    expect(screen.queryByText('CC6.1')).not.toBeInTheDocument();

    // Monitored view (default) shows the monitored control, hides the excluded one.
    selectMonitoringLane(/^Monitored/i);
    expandAllGroups();
    expect(screen.getByText('CC6.1')).toBeInTheDocument();
    expect(screen.queryByText('CC1.1')).not.toBeInTheDocument();
  });

  it('shows setup action when no framework is selected', async () => {
    renderPage({
      ...readiness,
      selectedFrameworks: [],
      frameworks: [],
      reportRequest: {
        canStart: false,
        scopeId: 'scope-1',
        latestCompletedRunId: 'run-1',
        reason: 'No compliance framework selected.',
      },
    });

    expect(await screen.findByText('No compliance framework selected')).toBeInTheDocument();
    // Frameworks are chosen per scope now, not on the organization.
    expect(screen.getByRole('button', { name: /choose frameworks on a scope/i })).toBeInTheDocument();
  });

  it('keeps assessment and report actions out of the compliance list before the first completed run', async () => {
    renderPage({
      ...readiness,
      latestCompletedRunId: null,
      reportRequest: {
        ...readiness.reportRequest,
        canStart: false,
        latestCompletedRunId: null,
        reason: 'Run a technical control assessment before starting a compliance readiness report session.',
      },
    });

    expect(await screen.findByText('Control Readiness')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run soc 2 readiness/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate report/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start baseline assessment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run gap assessment/i })).not.toBeInTheDocument();
  });

  it('normalizes an older readiness response without outcome fields', async () => {
    const legacyReadiness = structuredClone(readiness);
    const legacyFramework = legacyReadiness.frameworks[0] as Partial<
      ComplianceReadinessResponse['frameworks'][number]
    >;
    delete legacyFramework.outcomeCounts;
    delete legacyFramework.verdictCounts;

    for (const control of legacyFramework.controls ?? []) {
      const legacyControl = control as Partial<typeof control>;
      delete legacyControl.verdict;
      delete legacyControl.outcome;
      delete legacyControl.reasonCode;
      delete legacyControl.verdictReason;
      delete legacyControl.catalogRef;
      delete legacyControl.proofObligation;
      delete legacyControl.requiredEvidence;
      delete legacyControl.nextAction;
      delete legacyControl.evidenceFreshness;
      delete legacyControl.controlChecks;
    }

    renderPage(legacyReadiness);

    expect(await screen.findByText(/1 of 1 monitored controls have an agent-readable outcome/i)).toBeInTheDocument();
    expandAllGroups();
    expect(screen.getByText('CC6.1')).toBeInTheDocument();
    expect(screen.getAllByText(/validated open finding indicates/i)).not.toHaveLength(0);
  });

  it('renders NIST CSF like other frameworks without the extra function-readiness table', async () => {
    const nistReadiness = structuredClone(readiness);
    nistReadiness.selectedFrameworks = [{ key: 'nist_csf', label: 'NIST CSF 2.0 Readiness', sources: ['organization_context'] }];
    nistReadiness.supportedFrameworks = ['nist_csf'];
    const framework = nistReadiness.frameworks[0];
    framework.key = 'nist_csf';
    framework.label = 'NIST CSF 2.0 Readiness';
    framework.frameworkProfile = {
      kind: 'nist_csf_2_0',
      functions: ['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover'].map((functionName) => ({
        function: functionName,
        total: 1,
        monitored: 1,
        directCheckCount: 0,
        outcomeCounts: { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 },
      })),
      implementationTier: {
        status: 'not_determined',
        tier: null,
        reason: 'Implementation Tier is not derived from readiness counts.',
      },
    };

    renderPage(nistReadiness);
    await screen.findAllByText('NIST CSF 2.0 Readiness');

    // NIST must match every other framework — the function-readiness table is gone.
    expect(screen.queryByRole('heading', { name: 'Function readiness' })).not.toBeInTheDocument();
    expect(screen.queryByText('Implementation Tier not determined')).not.toBeInTheDocument();
  });

  it('renders GDPR readiness controls as first-class framework controls', async () => {
    const gdprReadiness = structuredClone(readiness);
    gdprReadiness.selectedFrameworks = [{ key: 'gdpr', label: 'GDPR Readiness', sources: ['organization_context'] }];
    gdprReadiness.supportedFrameworks = ['gdpr'];
    const framework = gdprReadiness.frameworks[0];
    framework.key = 'gdpr';
    framework.label = 'GDPR Readiness';
    framework.controls = [
      {
        ...framework.controls[0],
        id: 'GDPR-DATA-ROPA',
        title: 'Records of processing activities',
        theme: 'Processing Records and Legal Basis',
        supportLevel: 'manual_evidence_required',
        status: 'partial',
        verdict: 'needs_evidence',
        outcome: 'needs_action',
        reasonCode: 'evidence_required',
        verdictReason: 'A current RoPA extract is required to map processing purposes, categories, and recipients.',
        score: 35,
        rationale: 'RoPA evidence is incomplete for the selected scope.',
        evidence: [
          {
            id: 'evidence:ropa-extract',
            kind: 'user_evidence',
            title: 'Processing inventory extract',
            source: 'customer upload',
            sourceRef: 'ropa.xlsx',
            lastSeenAt: '2026-05-13T00:00:00.000Z',
            negative: false,
            mappingSource: 'user_evidence',
            mappingConfidence: 'medium',
            quality: {
              traceable: true,
              fresh: true,
              trustedSource: true,
              scopeComplete: false,
              humanReviewed: false,
              score: 70,
            },
          },
        ],
        gaps: ['Confirm processing purposes and recipient categories for all in-scope systems.'],
        catalogRef: 'gdpr:GDPR-DATA-ROPA',
        proofObligation: null,
        requiredEvidence: ['RoPA extract', 'lawful basis register'],
        nextAction: 'Upload the current RoPA extract and lawful-basis register for agent review.',
        evidenceFreshness: { freshestAt: '2026-05-13T00:00:00.000Z', stale: false },
        controlChecks: [],
      },
    ];
    framework.outcomeCounts = { passed: 0, failed: 0, needs_action: 1, not_checked: 0, excluded: 0 };

    renderPage(gdprReadiness);
    await screen.findAllByText('GDPR Readiness');
    expandAllGroups();

    expect(screen.getByText('GDPR-DATA-ROPA')).toBeInTheDocument();
    expect(screen.getByText('Records of processing activities')).toBeInTheDocument();
    expect(screen.getAllByText(/current RoPA extract is required/i)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /GDPR-DATA-ROPA/i })).toHaveTextContent('1 mapped');
  });

  it('shows HIPAA Required and Addressable implementation spec badges', async () => {
    const hipaaReadiness = structuredClone(readiness);
    hipaaReadiness.selectedFrameworks = [{ key: 'hipaa', label: 'HIPAA Security Rule Readiness', sources: ['organization_context'] }];
    hipaaReadiness.supportedFrameworks = ['hipaa'];
    const framework = hipaaReadiness.frameworks[0];
    framework.key = 'hipaa';
    framework.label = 'HIPAA Security Rule Readiness';
    framework.controls = [
      {
        ...framework.controls[0],
        id: '164.308(a)(3)',
        title: 'Workforce security',
        theme: 'Administrative',
        supportLevel: 'manual_evidence_required',
        implementationSpec: 'addressable',
        catalogRef: 'hipaa:164.308(a)(3)',
        proofObligation: null,
        requiredEvidence: ['workforce authorization procedure'],
      },
    ];
    framework.outcomeCounts = { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 };

    renderPage(hipaaReadiness);
    await screen.findAllByText('HIPAA Security Rule Readiness');
    expandAllGroups();

    expect(screen.getByText('164.308(a)(3)')).toBeInTheDocument();
    expect(screen.getByText('Addressable')).toBeInTheDocument();
  });

  it('shows PCI DSS approach, requirement, CDE, and account-data badges', async () => {
    const pciReadiness = structuredClone(readiness);
    pciReadiness.selectedFrameworks = [{ key: 'pci_dss', label: 'PCI DSS v4.0.1 Readiness', sources: ['organization_context'] }];
    pciReadiness.supportedFrameworks = ['pci_dss'];
    const framework = pciReadiness.frameworks[0];
    framework.key = 'pci_dss';
    framework.label = 'PCI DSS v4.0.1 Readiness';
    framework.controls = [
      {
        ...framework.controls[0],
        id: '3.3',
        title: 'Sensitive authentication data is not retained after authorization',
        theme: 'Protect Account Data',
        supportLevel: 'manual_evidence_required',
        pciDssRequirement: '3',
        pciDssGoal: 'Protect Account Data',
        pciDssApproach: 'defined',
        pciDssSaqTypes: ['D-Merchant', 'D-Service Provider'],
        pciDssCdeScope: 'cde',
        pciDssAccountData: 'sad',
        catalogRef: 'pci-dss:3.3',
        proofObligation: null,
        requiredEvidence: ['SAD retention prohibition policy'],
      },
    ];
    framework.outcomeCounts = { passed: 0, failed: 0, needs_action: 0, not_checked: 1, excluded: 0 };

    renderPage(pciReadiness);
    await screen.findAllByText('PCI DSS v4.0.1 Readiness');
    expandAllGroups();

    expect(screen.getByText('3.3')).toBeInTheDocument();
    expect(screen.getByText('Req 3')).toBeInTheDocument();
    expect(screen.getByText('Defined')).toBeInTheDocument();
    expect(screen.getByText('CDE')).toBeInTheDocument();
    expect(screen.getByText('SAD')).toBeInTheDocument();
  });
});
