/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppPathProvider, DEFAULT_APP_PATHS } from '@shared/contexts/AppPathContext';
import { ScopeContextProvider } from '@shared/contexts/ScopeContext';
import type { ComplianceEvidenceItem, ComplianceReadinessResponse } from '@/modules/security-ops/types';
import ComplianceControlPage from './ComplianceControlPage';

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
  generatedAt: '2026-06-23T00:00:00.000Z',
  organizationId: 'org-1',
  scopeId: 'scope-1',
  runId: null,
  selectedFrameworks: [{ key: 'soc2', label: 'SOC 2', sources: ['organization_profile'] }],
  supportedFrameworks: ['soc2'],
  latestCompletedRunId: 'run-1',
  scorecards: {
    agentProvenTechnical: { total: 1, passed: 1, failed: 0, needsContext: 0, notAttempted: 0, stale: 0 },
    customerEvidence: { total: 0, approved: 0, missing: 0, stale: 0, integrationRequired: 0, acceptedRisk: 0 },
    outcomes: { passed: 1, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
  },
  reportRequest: { canStart: true, scopeId: 'scope-1', latestCompletedRunId: 'run-1', reason: null },
  frameworks: [
    {
      key: 'soc2',
      label: 'SOC 2',
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
        needs_evidence: 0,
        needs_context: 0,
        not_attempted: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 0,
      },
      gaps: [],
      coverageLimitations: [],
      controls: [
        {
          id: 'CC6.1',
          title: 'Logical access control and authentication',
          theme: 'Access Control',
          supportLevel: 'automated_testable',
          status: 'passing',
          verdict: 'pass',
          outcome: 'passed',
          reasonCode: 'control_operating',
          basis: 'agent_tested',
          verdictReason: 'Unauthorized requests were denied for the tested endpoint set.',
          score: 100,
          rationale: 'Unauthorized requests were denied for the tested endpoint set.',
          evidence: [],
          gaps: [],
          coverageLimitations: [],
          catalogRef: 'soc2:CC6.1',
          proofObligation: {
            id: 'soc2-cc6.1-authz-v1',
            statement: 'Unauthorized identities cannot access protected resources across the tested scope.',
          },
          requiredEvidence: ['authorized request', 'unauthorized request'],
          nextAction: 'Review the evidence before freshness expires.',
          evidenceFreshness: { freshestAt: '2026-06-23T00:00:00.000Z', stale: false },
          monitoring: { state: 'monitored', source: 'default', exclusionReason: null, updatedAt: null },
          assignment: { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
          actionRequests: [],
          controlChecks: [
            {
              id: 'check-1',
              basis: 'agent_tested',
              verdict: 'pass',
              reasonCode: 'control_operating',
              reason: 'Unauthorized requests were denied for the tested endpoint set.',
              proofObligationId: 'soc2-cc6.1-authz-v1',
              method: 'HTTP differential test',
              toolName: 'http_differential',
              skillSlug: 'compliance-access-control',
              targetRef: 'GET /api/admin',
              evidenceRefs: ['.artifacts/access.json'],
              findingIds: [],
              artifactIds: [],
              proof: {
                claim: 'Unauthorized identities could not access the protected endpoint.',
                evidenceIds: ['.artifacts/access.json'],
                replayAttempted: true,
                replayArtifact: '.artifacts/access.json',
                replayReproduced: true,
              },
              limitations: ['Cross-role authorization was not tested because credentials were not provided.'],
              freshUntil: '2026-09-23T00:00:00.000Z',
              runId: 'run-1',
              sessionId: 'session-1',
              createdAt: '2026-06-23T00:00:00.000Z',
              fresh: true,
              eligible: true,
              reviewStatus: 'unreviewed',
              latestReview: null,
              reviewHistory: [],
            },
          ],
        },
      ],
    },
  ],
};

const evidence: ComplianceEvidenceItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org-1',
    scopeId: 'scope-1',
    title: 'Access review export',
    description: 'Quarterly access review evidence.',
    sourceType: 'user_upload',
    evidenceType: 'access_review',
    owner: null,
    status: 'unreviewed',
    artifact: {
      fileName: 'access-review.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
      storageRef: 'compliance/access-review.pdf',
    },
    metadata: {},
    observationStartedAt: null,
    observationEndedAt: null,
    validUntil: '2027-06-23T00:00:00.000Z',
    uploadedBy: 'user-1',
    reviewNote: null,
    agentReview: {
      status: 'reviewed',
      checkId: 'check-1',
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      verdict: 'pass',
      reviewedAt: '2026-06-23T00:00:00.000Z',
      reason: 'The agent reviewed the mapped access review export.',
    },
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    mappings: [
      {
        id: 'map-1',
        evidenceItemId: '11111111-1111-4111-8111-111111111111',
        organizationId: 'org-1',
        scopeId: 'scope-1',
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        mappingSource: 'user_declared',
        confidence: 'medium',
        rationale: null,
        createdBy: 'user-1',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ],
  },
];

const renderPage = (
  readinessOverride: ComplianceReadinessResponse = readiness,
  route = '/compliance/soc2/CC6.1',
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  apiRoutes.current = {
    '/app/dashboard/compliance-readiness': readinessOverride,
    '/app/compliance/evidence': { evidence },
    '/app/organization/members': [
      { userId: 'user-1', email: 'owner@example.com', role: 'lead', fullName: 'Control Owner' },
    ],
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
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path="/compliance/:frameworkKey/:controlId" element={<ComplianceControlPage />} />
            </Routes>
          </MemoryRouter>
        </ScopeContextProvider>
      </AppPathProvider>
    </QueryClientProvider>,
  );
};

describe('ComplianceControlPage', () => {
  it('renders the agent-owned control workspace', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Logical access control and authentication/i })).toBeInTheDocument();
    expect(screen.getAllByText('Passed')).not.toHaveLength(0);
    expect(screen.getAllByText('Agent tested')).not.toHaveLength(0);
    expect(screen.getByRole('heading', { name: /What must be true/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Why this outcome/i })).toBeInTheDocument();
    expect(screen.getByText(/Unauthorized identities cannot access/i)).toBeInTheDocument();
    expect(screen.getByText('control_operating')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run agent review/i })).not.toBeInTheDocument();
    // The evidence-upload affordance is not a default action; it appears only when the
    // agent has opened an evidence/access request. This control has none.
    expect(screen.queryByRole('button', { name: /Upload requested evidence/i })).not.toBeInTheDocument();

    // Evidence tab surfaces uploaded/integration evidence.
    fireEvent.click(screen.getByRole('tab', { name: /^Evidence$/i }));
    expect(await screen.findByText('Access review export')).toBeInTheDocument();
    expect(screen.getAllByText('Agent reviewed')).not.toHaveLength(0);
    expect(screen.queryByText(/Review unreviewed/i)).not.toBeInTheDocument();

    // Remediation tab surfaces the agent's recorded limitations.
    fireEvent.click(screen.getByRole('tab', { name: /^Remediation$/i }));
    expect(await screen.findByText(/Cross-role authorization was not tested/i)).toBeInTheDocument();
  });

  it('shows HIPAA implementation specification metadata on the control workspace', async () => {
    const hipaaReadiness = structuredClone(readiness);
    hipaaReadiness.selectedFrameworks = [{ key: 'hipaa', label: 'HIPAA Security Rule Readiness', sources: ['organization_profile'] }];
    hipaaReadiness.supportedFrameworks = ['hipaa'];
    const framework = hipaaReadiness.frameworks[0];
    framework.key = 'hipaa';
    framework.label = 'HIPAA Security Rule Readiness';
    framework.controls = [{
      ...framework.controls[0],
      id: '164.312(e)(2)(ii)',
      title: 'Transmission encryption',
      theme: 'Technical',
      supportLevel: 'automated_testable',
      implementationSpec: 'addressable',
      catalogRef: 'hipaa:164.312(e)(2)(ii)',
      proofObligation: {
        id: 'hipaa-164.312-e2ii-transmission-encryption-v1',
        statement: 'Tested ePHI transmission paths use encryption where appropriate or record a documented risk-based alternative.',
      },
      requiredEvidence: ['TLS or encrypted transport observation'],
    }];

    renderPage(hipaaReadiness, '/compliance/hipaa/164.312(e)(2)(ii)');

    expect(await screen.findByRole('heading', { name: /Transmission encryption/i })).toBeInTheDocument();
    expect(screen.getAllByText('Addressable implementation specification')).not.toHaveLength(0);
    expect(screen.getAllByText('hipaa:164.312(e)(2)(ii)')).not.toHaveLength(0);
  });

  it('opens a GDPR control workspace with privacy evidence obligations', async () => {
    const gdprReadiness = structuredClone(readiness);
    gdprReadiness.selectedFrameworks = [{ key: 'gdpr', label: 'GDPR Readiness', sources: ['organization_profile'] }];
    gdprReadiness.supportedFrameworks = ['gdpr'];
    const framework = gdprReadiness.frameworks[0];
    framework.key = 'gdpr';
    framework.label = 'GDPR Readiness';
    framework.controls = [{
      ...framework.controls[0],
      id: 'GDPR-TRANS-NOTICE',
      title: 'Privacy notice availability',
      theme: 'Transparency and Rights',
      supportLevel: 'automated_testable',
      catalogRef: 'gdpr:GDPR-TRANS-NOTICE',
      proofObligation: {
        id: 'gdpr-trans-notice-v1',
        statement: 'In-scope public collection flows expose a reachable privacy notice before or at data capture.',
      },
      requiredEvidence: ['public collection URL', 'privacy notice URL'],
    }];

    renderPage(gdprReadiness, '/compliance/gdpr/GDPR-TRANS-NOTICE');

    expect(await screen.findByRole('heading', { name: /Privacy notice availability/i })).toBeInTheDocument();
    expect(screen.getAllByText('GDPR Readiness')).not.toHaveLength(0);
    expect(screen.getAllByText('gdpr:GDPR-TRANS-NOTICE')).not.toHaveLength(0);
    expect(screen.getByText(/reachable privacy notice before or at data capture/i)).toBeInTheDocument();
    expect(screen.getByText('public collection URL')).toBeInTheDocument();
    expect(screen.getByText('privacy notice URL')).toBeInTheDocument();
  });

  it('shows PCI DSS requirement, approach, CDE, SAQ, and account-data metadata', async () => {
    const pciReadiness = structuredClone(readiness);
    pciReadiness.selectedFrameworks = [{ key: 'pci_dss', label: 'PCI DSS v4.0.1 Readiness', sources: ['organization_profile'] }];
    pciReadiness.supportedFrameworks = ['pci_dss'];
    const framework = pciReadiness.frameworks[0];
    framework.key = 'pci_dss';
    framework.label = 'PCI DSS v4.0.1 Readiness';
    framework.controls = [{
      ...framework.controls[0],
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
      catalogRef: 'pci-dss:11.6.1',
      proofObligation: {
        id: 'pci-11.6.1-payment-page-tamper-v1',
        statement: 'Payment page change/tamper detection evidence exists or observed scripts are flagged as unmonitored.',
      },
      requiredEvidence: ['payment page URL or script inventory'],
    }];

    renderPage(pciReadiness, '/compliance/pci_dss/11.6.1');

    expect(await screen.findByRole('heading', { name: /Payment page change and tamper detection/i })).toBeInTheDocument();
    expect(screen.getAllByText('PCI Req 11')).not.toHaveLength(0);
    expect(screen.getAllByText('Defined approach')).not.toHaveLength(0);
    expect(screen.getByText('Payment page')).toBeInTheDocument();
    expect(screen.getByText('A, A-EP, D-Merchant')).toBeInTheDocument();
    expect(screen.getByText('PAN')).toBeInTheDocument();
  });
});
