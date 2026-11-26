/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@null-ai/design-tokens/ui';
import DashboardPage from './DashboardPage';
import {
  useDashboardOverviewV2,
  useRisksQuery,
  useRiskSummaryQuery,
  useAssetsQuery,
  useComplianceReadinessQuery,
  useScopeTargetsQuery,
} from '@modules/security-ops/api';
import type { DashboardOverviewV2 } from '@modules/security-ops/types';
import { useScope } from '@shared/contexts/ScopeContext';
import { useProfile } from '@modules/auth/api/useProfile';

vi.mock('@modules/security-ops/api', () => ({
  useCreateRunMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
  useScopeTargetsQuery: vi.fn().mockReturnValue({ data: [] }),
  useDashboardOverviewV2: vi.fn().mockReturnValue({ data: null }),
  useRisksQuery: vi.fn().mockReturnValue({ data: [] }),
  useRiskSummaryQuery: vi.fn().mockReturnValue({ data: null }),
  useAssetsQuery: vi.fn().mockReturnValue({ data: [] }),
  useComplianceReadinessQuery: vi.fn().mockReturnValue({ data: null }),
  useStartComplianceReportMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: vi.fn(),
}));

vi.mock('@modules/auth/api/useProfile', () => ({
  useProfile: vi.fn(),
}));

vi.mock('@modules/scopes/ui/components/TargetVerificationModal', () => ({
  default: ({ open, target }: { open: boolean; target: { value: string } | null }) =>
    open && target ? <div role="dialog">Verify {target.value}</div> : null,
}));

const mockUseDashboardOverviewV2 = vi.mocked(useDashboardOverviewV2);
const mockUseRisksQuery = vi.mocked(useRisksQuery);
const mockUseRiskSummaryQuery = vi.mocked(useRiskSummaryQuery);
const mockUseAssetsQuery = vi.mocked(useAssetsQuery);
const mockUseComplianceReadinessQuery = vi.mocked(useComplianceReadinessQuery);
const mockUseScopeTargetsQuery = vi.mocked(useScopeTargetsQuery);
const mockUseScope = vi.mocked(useScope);
const mockUseProfile = vi.mocked(useProfile);

const successResult = <T,>(data: T) =>
  ({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown);

const dashboardOverview = (overrides: Partial<DashboardOverviewV2> = {}): DashboardOverviewV2 => ({
  window: { days: 30, from: '2026-07-10T00:00:00.000Z', to: '2026-08-09T00:00:00.000Z' },
  posture: {
    criticalOpen: 1,
    highOpen: 2,
    activeBacklog: 3,
    resolvedInWindow: 1,
    mttrHours: 4,
    runsInWindow: 4,
    trajectory: 'stable',
  },
  securityPosture: {
    grade: 'A-',
    numericScore: 91,
    confidence: 'high',
    methodology: 'academic_plus_minus',
    trend: 'stable',
    validationCoverage: 0.75,
    remediationVelocity: 1,
    runsInWindow: 4,
    rationale: ['Recent testing and validation coverage support a strong grade.'],
    openFindings: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
  },
  activeRuns: 1,
  recentRuns: [],
  lifecycle: { trend: [], validationRate: 0.75, remediationVelocity: 1, backlogDelta: 0 },
  cadence: { heatmap: [], statusMix: {}, triggerMix: {}, nextScheduledRun: null },
  assets: { topAffected: [] },
  categories: { owasp: [] },
  readiness: {
    targetState: 'verified',
    runnerState: 'not_required',
    accessMaterialsCount: 0,
    connectedRepoCount: 0,
    whiteboxEnabled: false,
    activeAutomations: 0,
  },
  latestActivity: null,
  ...overrides,
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>
    <MemoryRouter>{children}</MemoryRouter>
  </TooltipProvider>
);

describe('DashboardPage', () => {
  beforeEach(() => {
    mockUseScope.mockReturnValue({
      activeScopeId: 'scope-1',
      setActiveScopeId: vi.fn(),
      scopes: [{ id: 'scope-1', name: 'prod' }],
      isLoading: false,
    } as any);

    mockUseProfile.mockReturnValue({
      profile: {
        full_name: 'Operator',
      },
      isLoading: false,
    } as any);

    mockUseDashboardOverviewV2.mockReturnValue(
      successResult(dashboardOverview()) as ReturnType<typeof useDashboardOverviewV2>,
    );
    mockUseRisksQuery.mockReturnValue(successResult([]) as ReturnType<typeof useRisksQuery>);
    mockUseRiskSummaryQuery.mockReturnValue(successResult({
      total: 4,
      open: 3,
      openKev: 0,
      byState: {
        potential: 0,
        verifying: 0,
        confirmed: 3,
        not_reproduced: 0,
        dismissed: 0,
        resolved: 1,
        accepted: 0,
      },
      bySeverity: { critical: 1, high: 2, medium: 1 },
      openBySeverity: { critical: 1, high: 2 },
    }) as ReturnType<typeof useRiskSummaryQuery>);
    mockUseAssetsQuery.mockReturnValue(successResult([]) as ReturnType<typeof useAssetsQuery>);
    mockUseComplianceReadinessQuery.mockReturnValue(successResult(null) as ReturnType<typeof useComplianceReadinessQuery>);
    // The board only exists once a domain is verified — an unverified scope
    // gets the gate instead — so the default fixture has one.
    mockUseScopeTargetsQuery.mockReturnValue(successResult([{
      id: 'target-default', scopeId: 'scope-1', type: 'domain', value: 'acme.test',
      verified: true, verifiedAt: '2026-08-01T00:00:00.000Z',
    }]) as ReturnType<typeof useScopeTargetsQuery>);
  });

  it('shows the active scope target and opens the existing verification flow when it is unverified', () => {
    mockUseScopeTargetsQuery.mockReturnValue(successResult([{
      id: 'target-1',
      scopeId: 'scope-1',
      type: 'domain',
      value: 'example.com',
      verified: false,
      verificationMethod: 'dns_txt',
      verificationToken: 'token-1',
      verifiedAt: null,
    }]) as ReturnType<typeof useScopeTargetsQuery>);

    render(<DashboardPage />, { wrapper: Wrapper });

    // The gate replaces the page: the domain is the only thing on it.
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText(/verification required/i)).toBeTruthy();
    expect(screen.queryByText('Vulnerability trajectory')).toBeNull();
    const targetAction = screen.getByRole('button', { name: 'Verify target example.com' });
    fireEvent.click(targetAction);
    expect(screen.getByRole('dialog')).toHaveTextContent('Verify example.com');
  });

  it('shows verified state for the active scope target on Platform plans too', () => {
    mockUseScopeTargetsQuery.mockReturnValue(successResult([{
      id: 'target-1',
      scopeId: 'scope-1',
      type: 'domain',
      value: 'platform.example.com',
      verified: true,
      verifiedAt: '2026-08-01T00:00:00.000Z',
    }]) as ReturnType<typeof useScopeTargetsQuery>);

    render(<DashboardPage />, { wrapper: Wrapper });

    const targetStatus = screen.getByLabelText('Primary target platform.example.com, verified');
    expect(targetStatus).toHaveTextContent('platform.example.com');
    expect(within(targetStatus).getByLabelText('Verified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /verify target/i })).toBeNull();
  });

  it('surfaces advisory risks next to tested risks when any exist', async () => {
    mockUseRisksQuery.mockReturnValue(successResult([{
      key: 'exposure:x1',
      id: 'x1',
      recordKind: 'exposure',
      title: 'CVE-2026-1111 in openssl 3.0.1',
      subtitle: null,
      severity: 'critical',
      state: 'potential',
      assetValue: 'api.example.com',
      cvssScore: 9.8,
      kevListed: true,
    }]) as ReturnType<typeof useRisksQuery>);
    mockUseRiskSummaryQuery.mockReturnValue(successResult({
      total: 5,
      open: 4,
      openKev: 1,
      byState: {
        potential: 2,
        verifying: 0,
        confirmed: 2,
        not_reproduced: 0,
        dismissed: 0,
        resolved: 1,
        accepted: 0,
      },
      bySeverity: { critical: 1, high: 3, medium: 1 },
      openBySeverity: { critical: 1, high: 3 },
    }) as ReturnType<typeof useRiskSummaryQuery>);

    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.getByText('Potential')).toBeTruthy();
    expect(screen.getByText('KEV listed')).toBeTruthy();
    expect(screen.getByText('CVE-2026-1111 in openssl 3.0.1')).toBeTruthy();
  });

  it('hides the advisory-risk counter entirely when there are none', async () => {
    // An organization without Threat Watch should never be shown a permanent
    // zero for a feature it does not have.
    mockUseRiskSummaryQuery.mockReturnValue(successResult({
      total: 2,
      open: 2,
      openKev: 0,
      byState: {
        potential: 0,
        verifying: 0,
        confirmed: 2,
        not_reproduced: 0,
        dismissed: 0,
        resolved: 0,
        accepted: 0,
      },
      bySeverity: { high: 2 },
      openBySeverity: { high: 2 },
    }) as ReturnType<typeof useRiskSummaryQuery>);

    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.queryByText('Potential')).toBeNull();
  });

  it('renders the dashboard heading', async () => {
    render(<DashboardPage />, { wrapper: Wrapper });
    // The greeting is now the page's real h1 at every width — it used to be
    // `hidden xl:block`, so on a laptop the page opened with no heading at all.
    expect(screen.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/i })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: /Operator/i })).toBeTruthy();
  });

  it('uses the canonical Risk summary for Open Risks', async () => {
    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.getByText('Open risks').parentElement).toHaveTextContent('3');
  });

  it('renders the security grade and does not show the scope pill', async () => {
    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.getByText(/Security posture/i)).toBeTruthy();
    expect(screen.getByText('A-')).toBeTruthy();
    expect(screen.queryByText(/Scope:/i)).toBeNull();
  });

  it('always shows compliance readiness: the plan never hides it', async () => {
    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.getByText('Compliance readiness')).toBeTruthy();
    expect(mockUseComplianceReadinessQuery).toHaveBeenCalledWith('scope-1');
  });

  it('reads cadence from the canonical overview', async () => {
    mockUseDashboardOverviewV2.mockReturnValue(successResult(dashboardOverview({
      cadence: {
        heatmap: [
          { date: '2026-03-28', count: 1 },
          { date: '2026-03-29', count: 2 },
        ],
        statusMix: {},
        triggerMix: {},
        nextScheduledRun: null,
      },
    })) as ReturnType<typeof useDashboardOverviewV2>);

    render(<DashboardPage />, { wrapper: Wrapper });

    expect(screen.queryByText('No cadence data')).toBeNull();
  });

  it('uses the backend trajectory values without shifting historical active counts', async () => {
    mockUseDashboardOverviewV2.mockReturnValue(
      successResult(dashboardOverview({
        lifecycle: {
          trend: [
          { date: '2026-04-02', created: 0, resolved: 0, active: 1 },
          { date: '2026-04-03', created: 0, resolved: 0, active: 1 },
          ],
          validationRate: 1,
          remediationVelocity: null,
          backlogDelta: 0,
        },
      })) as ReturnType<typeof useDashboardOverviewV2>,
    );

    const rectSpy = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 180,
      width: 800,
      height: 180,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = render(<DashboardPage />, { wrapper: Wrapper });
      // The readout is driven by pointing at a day, not by the chart's own
      // geometry — one hit column per point, so the last one is the last day.
      const hitColumns = Array.from(container.querySelectorAll('rect[fill="transparent"]'));
      expect(hitColumns.length).toBeGreaterThan(0);

      fireEvent.mouseEnter(hitColumns[hitColumns.length - 1] as SVGElement);

      // The date now appears on the axis as well as in the readout, so this
      // asserts the readout: the row that pairs the series with its value.
      const readout = container.querySelector('[data-sparkline-readout]');
      expect(readout).toBeTruthy();
      expect(readout).toHaveTextContent('2026-04-03');
      expect(readout).toHaveTextContent('Open risk');
      expect(readout).toHaveTextContent('1');
      expect(screen.queryByText('New that day')).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });

  describe('the first-run state', () => {
    // Nothing has ever landed on this scope. A board of eight empty widgets
    // shows a new user eight broken things and no way to fix any of them, so
    // the page becomes the one action that is available.
    const withNoData = () => {
      mockUseDashboardOverviewV2.mockReturnValue(successResult(dashboardOverview({
        posture: {
          criticalOpen: 0, highOpen: 0, activeBacklog: 0, resolvedInWindow: 0,
          mttrHours: null, runsInWindow: 0, trajectory: 'stable',
        },
        securityPosture: {
          grade: 'F', numericScore: 0, confidence: 'low', methodology: 'academic_plus_minus',
          trend: 'stable', validationCoverage: 0, remediationVelocity: 0, runsInWindow: 0,
          rationale: [],
          openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        activeRuns: 0,
        recentRuns: [],
        lifecycle: { trend: [], validationRate: 0, remediationVelocity: null, backlogDelta: 0 },
        cadence: { heatmap: [], statusMix: {}, triggerMix: {}, nextScheduledRun: null },
        assets: { topAffected: [] },
        categories: { owasp: [] },
      })) as ReturnType<typeof useDashboardOverviewV2>);
      mockUseRiskSummaryQuery.mockReturnValue(successResult({
        total: 0, open: 0, openKev: 0,
        byState: { potential: 0, verifying: 0, confirmed: 0, not_reproduced: 0, dismissed: 0, resolved: 0, accepted: 0 },
        bySeverity: {}, openBySeverity: {},
      }) as ReturnType<typeof useRiskSummaryQuery>);
    };

    const target = (verified: boolean) => {
      mockUseScopeTargetsQuery.mockReturnValue(successResult([{
        id: 'target-1', scopeId: 'scope-1', type: 'domain', value: 'example.com',
        verified, verificationMethod: verified ? undefined : 'dns_txt',
        verificationToken: verified ? undefined : 'token-1',
        verifiedAt: verified ? '2026-08-01T00:00:00.000Z' : null,
      }]) as ReturnType<typeof useScopeTargetsQuery>);
    };

    it('asks for domain verification, and says what verifying causes', () => {
      withNoData();
      target(false);
      render(<DashboardPage />, { wrapper: Wrapper });

      expect(screen.getByText(/verification required/i)).toBeTruthy();
      expect(screen.getByText('example.com')).toBeTruthy();
      // The reason anyone edits a DNS record is what happens next.
      expect(screen.getByText(/the first assessment starts on its own/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /verify target example.com/i })).toBeTruthy();
      expect(screen.queryByText('Vulnerability trajectory')).toBeNull();
    });

    it('explains the running discovery once the domain is verified', () => {
      withNoData();
      target(true);
      render(<DashboardPage />, { wrapper: Wrapper });

      expect(screen.getByRole('heading', { name: /mapping your surface/i })).toBeTruthy();
      expect(screen.getByText(/check back in a few minutes/i)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /verify target example.com/i })).toBeNull();
    });

    it('asks for a domain first when the scope has no target at all', () => {
      withNoData();
      mockUseScopeTargetsQuery.mockReturnValue(successResult([]) as ReturnType<typeof useScopeTargetsQuery>);
      render(<DashboardPage />, { wrapper: Wrapper });

      expect(screen.getByRole('heading', { name: /name what we may test/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /add a domain/i })).toBeTruthy();
    });

    it('draws the board as soon as anything has landed', () => {
      withNoData();
      target(true);
      mockUseDashboardOverviewV2.mockReturnValue(successResult(dashboardOverview({
        posture: {
          criticalOpen: 0, highOpen: 0, activeBacklog: 1, resolvedInWindow: 0,
          mttrHours: null, runsInWindow: 0, trajectory: 'stable',
        },
        securityPosture: {
          grade: 'F', numericScore: 0, confidence: 'low', methodology: 'academic_plus_minus',
          trend: 'stable', validationCoverage: 0, remediationVelocity: null, runsInWindow: 0,
          rationale: [], openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        activeRuns: 0,
        recentRuns: [],
        lifecycle: {
          trend: [{ date: '2026-04-01', active: 1, created: 1, resolved: 0 }],
          validationRate: 0,
          remediationVelocity: null,
          backlogDelta: 1,
        },
        cadence: { heatmap: [], statusMix: {}, triggerMix: {}, nextScheduledRun: null },
        assets: { topAffected: [] },
        categories: { owasp: [] },
      })) as ReturnType<typeof useDashboardOverviewV2>);
      render(<DashboardPage />, { wrapper: Wrapper });

      expect(screen.queryByRole('heading', { name: /mapping your surface/i })).toBeNull();
      expect(screen.getByText('Vulnerability trajectory')).toBeTruthy();
    });
  });
});
