import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import FindingDetailPage from './FindingDetailPage';
import type { Finding, FindingEvidence, FindingEvent } from '@/modules/security-ops/types';
import {
  useAssignFindingMutation,
  useFindingDetailQuery,
  useFindingDispositionVerificationsQuery,
  useFindingEvidenceQuery,
  useFindingEventsQuery,
  useCancelFindingDispositionVerificationMutation,
  useOrganizationMembersQuery,
  useRequestFindingDispositionVerificationMutation,
  useRetryFindingDispositionVerificationMutation,
  useUpdateFindingMutation,
  useValidateFindingMutation,
} from '@/modules/security-ops/api';
import { downloadArtifactBlob } from '@/modules/sessions/api/artifacts';

const permissionMocks = vi.hoisted(() => ({
  has: vi.fn(() => true),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useFindingDetailQuery: vi.fn(),
  useRiskDetailQuery: vi.fn(() => ({ data: undefined })),
  useCodeOccurrenceDetailQuery: vi.fn(() => ({ data: undefined })),
  useFindingDispositionVerificationsQuery: vi.fn(),
  useFindingEventsQuery: vi.fn(),
  useFindingEvidenceQuery: vi.fn(),
  useOrganizationMembersQuery: vi.fn(),
  useAssignFindingMutation: vi.fn(),
  useUpdateFindingMutation: vi.fn(),
  useValidateFindingMutation: vi.fn(),
  useRequestFindingDispositionVerificationMutation: vi.fn(),
  useRetryFindingDispositionVerificationMutation: vi.fn(),
  useCancelFindingDispositionVerificationMutation: vi.fn(),
}));

vi.mock('@/modules/sessions/api/artifacts', () => ({
  downloadArtifactBlob: vi.fn().mockResolvedValue(new Blob(['proof'])),
}));

vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({
    has: permissionMocks.has,
  }),
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@shared/ui/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

// The design system is NOT mocked — this page is composition over the shared
// detail kit, so these tests render the real DetailPageShell, StatusTabs and
// rail, and would catch a page that grew its own chrome again.

vi.mock('./components/CvssScoreBadge', () => ({
  CvssScoreBadge: ({ score }: { score: number | null | undefined }) => <span>{score == null ? 'NO CVSS' : `CVSS ${score}`}</span>,
}));
vi.mock('./components/OwaspBadge', () => ({
  OwaspBadge: ({ category }: { category: string }) => <span>{category}</span>,
}));
vi.mock('./components/ValidationBadge', () => ({
  ValidationBadge: ({ state }: { state: string }) => <span>{state}</span>,
}));

const mockUseFindingDetailQuery = vi.mocked(useFindingDetailQuery);
const mockUseFindingDispositionVerificationsQuery = vi.mocked(useFindingDispositionVerificationsQuery);
const mockUseFindingEventsQuery = vi.mocked(useFindingEventsQuery);
const mockUseFindingEvidenceQuery = vi.mocked(useFindingEvidenceQuery);
const mockUseOrganizationMembersQuery = vi.mocked(useOrganizationMembersQuery);
const mockUseAssignFindingMutation = vi.mocked(useAssignFindingMutation);
const mockUseUpdateFindingMutation = vi.mocked(useUpdateFindingMutation);
const mockUseValidateFindingMutation = vi.mocked(useValidateFindingMutation);
const mockUseRequestFindingDispositionVerificationMutation = vi.mocked(useRequestFindingDispositionVerificationMutation);
const mockUseRetryFindingDispositionVerificationMutation = vi.mocked(useRetryFindingDispositionVerificationMutation);
const mockUseCancelFindingDispositionVerificationMutation = vi.mocked(useCancelFindingDispositionVerificationMutation);
const mockDownloadArtifactBlob = vi.mocked(downloadArtifactBlob);

const baseFinding: Finding = {
  id: 'finding-1',
  title: 'Unauthenticated admin surface',
  severity: 'high',
  state: "potential",
  assignedTo: null,
  assetId: 'asset-1',
  assetValue: 'app.example.com',
  assetKind: 'domain',
  scopeId: 'scope-1',
  scopeName: 'Scope One',
  summary: 'Admin route is reachable without auth.',
  businessImpact: 'Attacker can access admin functions.',
  technicalAnalysis: 'The admin route lacks authentication checks and is reachable directly.',
  pocDescription: '1. Open the admin route. 2. Observe the dashboard without logging in.',
  pocScriptCode: 'curl -i https://app.example.com/admin',
  remediation: 'Require authentication.',
  assumptions: 'Attacker has network access to the target.',
  fixEffort: 'medium',
  confidence: 0.74,
  evidenceCount: 0,
  cvssScore: 8.1,
  cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L',
  cweId: 'CWE-287',
  cveId: null,
  cweIds: ['CWE-287'],
  cveIds: null,
  owaspCategory: 'A01:2021-Broken Access Control',
  endpoint: {
    id: 'endpoint-1',
    url: 'https://app.example.com/admin',
    method: 'GET',
  },
  service: {
    id: 'service-1',
    protocol: 'https',
    port: 443,
    serviceName: 'nginx',
    product: 'nginx',
    version: '1.25.0',
  },
  firstSeenAt: '2026-03-22T10:00:00.000Z',
  lastSeenAt: '2026-03-22T10:00:00.000Z',
  createdAt: '2026-03-22T10:00:00.000Z',
};

const renderPage = (
  initialEntry = '/risks/finding-1',
  routePath = '/risks/:id',
  element: ReactNode = <FindingDetailPage />,
) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path={routePath} element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe('FindingDetailPage validation workflow', () => {
  const assignMutate = vi.fn();
  const updateMutate = vi.fn();
  const validateMutate = vi.fn();
  const requestDispositionMutate = vi.fn();
  const retryDispositionMutate = vi.fn();
  const cancelDispositionMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    permissionMocks.has.mockReturnValue(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockUseFindingDetailQuery.mockReturnValue({ data: baseFinding, isLoading: false } as never);
    mockUseFindingDispositionVerificationsQuery.mockReturnValue({
      data: { active: null, latest: null, attempts: [] },
    } as never);
    mockUseFindingEventsQuery.mockReturnValue({ data: [] } as never);
    mockUseFindingEvidenceQuery.mockReturnValue({ data: [] as FindingEvidence[] } as never);
    mockUseOrganizationMembersQuery.mockReturnValue({ data: [] } as never);
    mockUseAssignFindingMutation.mockReturnValue({ mutate: assignMutate, isPending: false } as never);
    mockUseUpdateFindingMutation.mockReturnValue({ mutate: updateMutate, isPending: false } as never);
    mockUseValidateFindingMutation.mockReturnValue({ mutate: validateMutate, isPending: false } as never);
    mockUseRequestFindingDispositionVerificationMutation.mockReturnValue({
      mutate: requestDispositionMutate,
      isPending: false,
    } as never);
    mockUseRetryFindingDispositionVerificationMutation.mockReturnValue({
      mutate: retryDispositionMutate,
      isPending: false,
    } as never);
    mockUseCancelFindingDispositionVerificationMutation.mockReturnValue({
      mutate: cancelDispositionMutate,
      isPending: false,
    } as never);
    mockDownloadArtifactBlob.mockResolvedValue(new Blob(['proof']));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:finding-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('shows validate as the primary action for weak-proof findings', () => {
    renderPage();

    expect(screen.queryByText(/NO DURABLE PROOF|WEAK PROOF/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Evidence/i }));
    expect(screen.getByText(/Nothing durable is attached yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Overview/i }));
    expect(screen.getByText('Validate Risk')).toBeInTheDocument();
    expect(screen.queryByText('Run Validation Again')).toBeNull();
    expect(screen.getByText('Review as False Positive')).toBeInTheDocument();
    expect(screen.queryByText('Retest Finding')).toBeNull();
  });

  it('shows rerun validation and false-positive action after failed validation', () => {
    const finding = { ...baseFinding, state: 'not_reproduced' };
    const events: FindingEvent[] = [
      {
        id: 'event-1',
        findingId: finding.id,
        type: 'validation_checked',
        note: 'Validation run #r14 did not reproduce finding',
        createdAt: '2026-03-23T08:30:00.000Z',
      },
    ];
    mockUseFindingDetailQuery.mockReturnValue({ data: finding, isLoading: false } as never);
    mockUseFindingEventsQuery.mockReturnValue({ data: events } as never);

    renderPage();

    expect(screen.getByText(/validation did not reproduce/i)).toBeInTheDocument();
    expect(screen.getByText('Run Validation Again')).toBeInTheDocument();
    expect(screen.getByText('Review as False Positive')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Review as False Positive'));
    expect(requestDispositionMutate).toHaveBeenCalledWith(
      {
        findingId: finding.id,
        requestedState: 'dismissed',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('routes resolution and false-positive review through focused verification', () => {
    const finding = { ...baseFinding, state: 'confirmed', evidenceCount: 1 };
    const evidence: FindingEvidence[] = [
      {
        id: 'evidence-1',
        path: '.artifacts/proof.txt',
        label: 'proof',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        createdAt: '2026-03-23T08:00:00.000Z',
      },
    ];

    mockUseFindingDetailQuery.mockReturnValue({ data: finding, isLoading: false } as never);
    mockUseFindingEvidenceQuery.mockReturnValue({ data: evidence } as never);

    renderPage();

    expect(screen.queryByText(/STRONG PROOF|DURABLE ARTIFACT|STRUCTURED HTTP/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Evidence/i }));
    expect(screen.getByText(/A retained artifact is attached/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Overview/i }));
    expect(screen.queryByText('Validate Risk')).toBeNull();
    expect(screen.queryByText('Retest Finding')).toBeNull();
    expect(screen.getByText('Review as False Positive')).toBeInTheDocument();

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'accepted' },
    });
    fireEvent.click(screen.getByText('Request Resolution'));
    expect(requestDispositionMutate).toHaveBeenCalledWith(
      {
        findingId: finding.id,
        requestedState: 'resolved',
      },
      expect.any(Object),
    );
  });

  it('renders the new findings IA and legacy fallbacks', () => {
    const legacyFinding = {
      ...baseFinding,
      technicalAnalysis: null,
      pocDescription: null,
      pocScriptCode: null,
      assumptions: null,
      fixEffort: null,
    };
    mockUseFindingDetailQuery.mockReturnValue({ data: legacyFinding, isLoading: false } as never);

    renderPage();

    expect(screen.getByRole('tab', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Evidence/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Remediation/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/i })).toBeInTheDocument();
    expect(screen.getByText('TL;DR')).toBeInTheDocument();
    expect(screen.getByText('Technical Analysis')).toBeInTheDocument();
    expect(screen.getByText('Assumptions')).toBeInTheDocument();
    expect(screen.getByText('Affected Context')).toBeInTheDocument();
    // These three rail blocks restated the header and Affected Context — six
    // facts, twelve renders (audit 5B.1). They must not come back.
    expect(screen.queryByText('Severity & Status')).toBeNull();
    expect(screen.queryByText('Risk Signals')).toBeNull();
    expect(screen.queryByText('Target')).toBeNull();
    // Candidate-state findings get a "Pending promotion" hint instead of the
    // older misleading "older finding format" copy.
    expect(screen.getAllByText(/Pending — gets captured/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /Evidence/i }));
    expect(screen.getByText('Reproduction')).toBeInTheDocument();
    expect(screen.getByText('PoC Script')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Remediation/i }));
    expect(screen.getByText('Fix')).toBeInTheDocument();
  });
  it('renders http_exchange evidence properly without attempting download', () => {
    const finding: Finding = {
      ...baseFinding,
      reviewMeta: {
        codeLocationCount: 0,
        copyFixPromptReady: false,
        evidenceSummary: {
          total: 1,
          artifactCount: 0,
          downloadableArtifactCount: 0,
          structuredHttpCount: 1,
          excerptCount: 0,
          fileMissingCount: 0,
        },
      },
    };
    const evidence: FindingEvidence[] = [
      {
        id: 'evidence-http',
        kind: 'http_exchange',
        path: '/api/v1/admin',
        displayPath: 'GET /api/v1/admin',
        http: {
          source: 'request_tool',
          request: {
            method: 'GET',
            url: 'https://app.example.com/api/v1/admin',
            headers: [{ name: 'Host', value: 'app.example.com' }],
          },
          response: {
            statusCode: 200,
            contentType: 'application/json',
            body: {
              text: '{"admin": true}',
              truncated: false,
            },
          },
        },
      },
    ];

    mockUseFindingDetailQuery.mockReturnValue({ data: finding, isLoading: false } as never);
    mockUseFindingEvidenceQuery.mockReturnValue({ data: evidence } as never);

    renderPage();
    expect(screen.queryByText('Validate Risk')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Evidence/i }));

    expect(screen.getByText('GET /api/v1/admin')).toBeInTheDocument();
    expect(screen.getByText(/GET https:\/\/app\.example\.com\/api\/v1\/admin/i)).toBeInTheDocument();
    expect(screen.getByText(/Host: app\.example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/Status: 200/i)).toBeInTheDocument();
    expect(screen.getByText(/{"admin": true}/i)).toBeInTheDocument();
    expect(screen.queryByText('LOADING FULL EVIDENCE FILE...')).not.toBeInTheDocument();
    expect(mockDownloadArtifactBlob).not.toHaveBeenCalled();
  });

  it('renders screenshot evidence inline without requiring a manual download', async () => {
    const finding = { ...baseFinding, state: 'confirmed', evidenceCount: 1 };
    const evidence: FindingEvidence[] = [
      {
        id: 'evidence-screenshot',
        kind: 'artifact',
        path: '.artifacts/browser/screenshots/admin-login-challenge.png',
        label: 'Browser screenshot',
        excerpt: 'Rendered challenge state after submitting the admin login flow.',
        sessionId: 'session-1',
        artifactId: 'artifact-screenshot',
        createdAt: '2026-03-23T08:00:00.000Z',
      },
    ];
    mockDownloadArtifactBlob.mockResolvedValue(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    );
    mockUseFindingDetailQuery.mockReturnValue({ data: finding, isLoading: false } as never);
    mockUseFindingEvidenceQuery.mockReturnValue({ data: evidence } as never);

    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Evidence/i }));

    const preview = await screen.findByRole('img', { name: /Browser screenshot preview/i });
    expect(preview).toHaveAttribute('src', 'blob:finding-preview');
    expect(screen.getByText(/Rendered challenge state/i)).toBeInTheDocument();
    expect(mockDownloadArtifactBlob).toHaveBeenCalledWith(
      'session-1',
      'artifact-screenshot',
    );
  });

  it('renders Copy Fix Prompt and Code Locations in Remediation tab when reviewMeta indicates it', () => {
    const finding = {
      ...baseFinding,
      reviewMeta: {
        codeLocationCount: 1,
        copyFixPromptReady: true,
        evidenceSummary: {
          total: 1,
          artifactCount: 1,
          downloadableArtifactCount: 1,
          structuredHttpCount: 0,
          excerptCount: 0,
          fileMissingCount: 0,
        },
      },
      codeLocations: [
        {
          pathKind: 'repository',
          repository: 'backend-repo',
          ref: 'main',
          filePath: 'src/routes/admin.ts',
          startLine: 10,
          endLine: 12,
          label: 'Missing auth check',
          fixBefore: 'app.get("/admin", handler);',
          fixAfter: 'app.get("/admin", requireAuth, handler);',
        },
      ],
    };

    mockUseFindingDetailQuery.mockReturnValue({ data: finding, isLoading: false } as never);

    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Remediation/i }));

    expect(screen.getByText('Copy Fix Prompt')).toBeInTheDocument();
    expect(screen.getByText('Affected Code')).toBeInTheDocument();
    expect(screen.getByText('backend-repo')).toBeInTheDocument();
    expect(screen.getByText(/src\/routes\/admin\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/L10-12/)).toBeInTheDocument();
  });
});
