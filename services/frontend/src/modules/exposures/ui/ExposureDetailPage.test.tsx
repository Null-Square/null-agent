import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExposureDetailPage from './ExposureDetailPage';
import {
  useExposureDetailQuery,
  useVerifyExposureMutation,
  useDismissExposureMutation,
  useCreateExposureOverrideMutation,
  useDeleteExposureOverrideMutation,
} from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useExposureDetailQuery: vi.fn(),
  useVerifyExposureMutation: vi.fn(),
  useDismissExposureMutation: vi.fn(),
  useCreateExposureOverrideMutation: vi.fn(),
  useDeleteExposureOverrideMutation: vi.fn(),
}));

vi.mock('@/modules/permissions', () => ({
  useHasCapability: () => true,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'exp-1' }) };
});

const mockUseDetail = vi.mocked(useExposureDetailQuery);
const mockUseVerify = vi.mocked(useVerifyExposureMutation);
const mockUseDismiss = vi.mocked(useDismissExposureMutation);
const mockUseSaveOverride = vi.mocked(useCreateExposureOverrideMutation);
const mockUseDeleteOverride = vi.mocked(useDeleteExposureOverrideMutation);

const detail = (overrides: { match?: Record<string, unknown>; advisory?: Record<string, unknown>; component?: Record<string, unknown>; events?: unknown[]; observations?: unknown[]; affectedRanges?: unknown[]; override?: unknown } = {}) => ({
  match: {
    id: 'exp-1',
    organizationId: 'org-1',
    assetId: 'asset-1',
    componentId: 'component-1',
    advisoryId: 'advisory-1',
    matchConfidence: 'exact_version',
    versionEvaluated: '1.18.0',
    evidenceTier: 'reported_exact',
    evidenceSource: 'httpx',
    priorityScore: 90,
    state: 'notified',
    inventoryObservedAt: '2026-08-01T00:00:00.000Z',
    verificationRunId: null,
    findingId: null,
    stateReason: null,
    notifiedAt: null,
    verifiedAt: null,
    resolvedAt: null,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    ...overrides.match,
  },
  advisory: {
    id: 'advisory-1',
    canonicalId: 'CVE-2024-1234',
    canonicalSource: 'nvd',
    cveId: 'CVE-2024-1234',
    title: 'nginx vulnerability',
    summary: 'A resolver flaw allows memory disclosure.',
    publishedAt: '2026-07-01T00:00:00.000Z',
    lastModifiedAt: '2026-07-10T00:00:00.000Z',
    severity: 'high',
    cvssV31Vector: null,
    cvssV31Score: 7.7,
    epssScore: null,
    epssPercentile: 0.41,
    kevListed: false,
    kevAddedAt: null,
    cweIds: null,
    ...overrides.advisory,
  },
  component: {
    id: 'component-1',
    ecosystem: 'cpe',
    componentKey: 'cpe:f5:nginx',
    displayName: 'nginx',
    resolvedVersion: '1.18.0',
    resolvedVersionScheme: 'cpe',
    resolvedEvidenceTier: 'reported_exact',
    resolvedObservationSource: 'httpx',
    backportRisk: false,
    versionConflict: false,
    ...overrides.component,
  },
  assetValue: 'shop.example.com',
  events: overrides.events ?? [],
  observations: overrides.observations ?? [
    {
      id: 'observation-1',
      source: 'httpx',
      port: 443,
      versionRaw: '1.18.0',
      versionNormalized: '1.18.0',
      confidence: 0.91,
      evidence: [{ label: 'Server header', excerpt: 'nginx/1.18.0' }],
      observedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  affectedRanges: overrides.affectedRanges ?? [
    {
      id: 'range-1',
      versionScheme: 'cpe',
      introducedVersion: '1.10.0',
      introducedInclusive: true,
      fixedVersion: '1.20.0',
      fixedInclusive: false,
    },
  ],
  override: overrides.override ?? null,
});

describe('ExposureDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVerify.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false } as never);
    mockUseDismiss.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false } as never);
    mockUseSaveOverride.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false } as never);
    mockUseDeleteOverride.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false } as never);
  });

  const renderWith = (data: unknown, state: { isLoading?: boolean; isError?: boolean } = {}) => {
    mockUseDetail.mockReturnValue({
      data,
      isLoading: state.isLoading ?? false,
      isError: state.isError ?? false,
    } as never);
    return render(
      <MemoryRouter>
        <ExposureDetailPage />
      </MemoryRouter>,
    );
  };

  it('shows the advisory, the component and the asset', () => {
    renderWith(detail());

    expect(screen.getByRole('heading', { name: /CVE-2024-1234 in nginx 1\.18\.0/u })).toBeInTheDocument();
    expect(screen.getByText('shop.example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /advisory/i }));
    expect(screen.getByText(/resolver flaw allows memory disclosure/u)).toBeInTheDocument();
  });

  it('states plainly that an open exposure has not been tested', () => {
    // This is the page where somebody decides to spend money. Leaving the
    // unverified status to a badge alone invites reading a version match as a
    // demonstrated compromise.
    renderWith(detail());

    expect(screen.getByText(/has not been tested yet/iu)).toBeInTheDocument();
  });

  it('explains the basis of the match rather than just naming it', () => {
    renderWith(detail());

    expect(screen.getByText(/evaluated version falls inside a range/iu)).toBeInTheDocument();
    expect(screen.getByText(/reported by scanner or banner evidence/iu)).toBeInTheDocument();
  });

  it('shows the observation and affected range behind the match', () => {
    renderWith(detail());

    // What we observed on the host is evidence; which versions the advisory
    // covers is advisory data. They now sit on the tabs that own them.
    fireEvent.click(screen.getByRole('tab', { name: /evidence/i }));
    expect(screen.getByText('Server header')).toBeInTheDocument();
    expect(screen.getByText('nginx/1.18.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /advisory/i }));
    expect(screen.getByText(/cpe: >= 1\.10\.0, < 1\.20\.0/iu)).toBeInTheDocument();
  });

  it('warns that a backported patch can invalidate the version match', () => {
    renderWith(detail({ component: { backportRisk: true } }));

    expect(screen.getByText(/may have patched this without changing the version string/iu)).toBeInTheDocument();
  });

  it('refuses to call a non-reproduction proof of safety', () => {
    // A failed attempt is not evidence of absence, and saying otherwise would
    // be the most damaging thing this page could claim.
    renderWith(detail({ match: { state: 'not_reproduced' } }));

    expect(screen.getByText(/not proof the host is unaffected/iu)).toBeInTheDocument();
  });

  it('links a confirmed advisory risk to the tested risk it became', () => {
    renderWith(detail({ match: { state: 'confirmed', findingId: 'finding-9' } }));

    const link = screen.getByRole('link', { name: /view the tested risk/iu });
    expect(link).toHaveAttribute('href', '/risks/finding-9');
  });

  it('offers no verification once a verdict has landed', () => {
    renderWith(detail({ match: { state: 'confirmed', findingId: 'finding-9' } }));

    expect(screen.queryByRole('button', { name: /verify advisory risk/iu })).not.toBeInTheDocument();
  });

  it('tells the user that verifying uses their model key before they click, and never mentions credits', () => {
    renderWith(detail());

    expect(screen.getByText(/uses your model key/iu)).toBeInTheDocument();
    expect(screen.queryByText(/credits/iu)).toBeNull();
  });

  it('requires confirmation before starting the verification', () => {
    const mutate = vi.fn();
    mockUseVerify.mockReturnValue({ mutate, isPending: false, isError: false } as never);
    renderWith(detail());

    fireEvent.click(screen.getByRole('button', { name: /verify advisory risk/iu }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /start verification/iu }));

    expect(mutate).toHaveBeenCalledWith('exp-1');
  });

  it('makes correction scope explicit instead of offering Not Us', () => {
    renderWith(detail());

    fireEvent.click(screen.getByRole('button', { name: /correct match/iu }));

    expect(screen.getByText('Software is not installed')).toBeInTheDocument();
    expect(screen.getByText('Detected version is wrong')).toBeInTheDocument();
    expect(screen.getByText('This advisory does not apply')).toBeInTheDocument();
    expect(screen.queryByText('Not Us')).not.toBeInTheDocument();
  });

  it('renders the state timeline when events exist', () => {
    renderWith(
      detail({
        events: [
          {
            id: 'event-1',
            matchId: 'exp-1',
            type: 'state_changed',
            fromState: 'verifying',
            toState: 'confirmed',
            actorUserId: null,
            note: 'Reproduced with a control request',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: /history/i }));

    expect(screen.getByText(/status changed to confirmed/iu)).toBeInTheDocument();
    expect(screen.getByText(/Reproduced with a control request/u)).toBeInTheDocument();
  });

  it('shows a recoverable error rather than a blank page', () => {
    renderWith(undefined, { isError: true });

    expect(screen.getByText(/could not be loaded/iu)).toBeInTheDocument();
  });

  it('always queries the detail: no plan gate on advisory risks', () => {
    renderWith(undefined);

    expect(mockUseDetail).toHaveBeenCalledWith('exp-1');
    expect(screen.queryByText(/not included in your plan/iu)).toBeNull();
  });

  it('surfaces a failed verification without implying the state changed', () => {
    mockUseVerify.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: true } as never);
    renderWith(detail());

    expect(screen.getByRole('alert')).toHaveTextContent(/no second run was started/iu);
  });
});
