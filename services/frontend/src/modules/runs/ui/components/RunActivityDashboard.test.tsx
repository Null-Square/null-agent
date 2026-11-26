import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RunActivityDashboard from './RunActivityDashboard';
import type { RunActivitySummary } from '@/modules/security-ops/types';

vi.mock('@/modules/security-ops/api', () => ({
  useRunActivityQuery: vi.fn(),
}));

const securityOpsApi = await import('@/modules/security-ops/api');

function buildActivitySummary(
  overrides: Partial<RunActivitySummary> = {},
): RunActivitySummary {
  return {
    totals: {
      requests: 42,
      uniqueHosts: 4,
      uniqueEndpoints: 15,
      failures: 3,
      blockedActions: 1,
      averageDurationMs: 512,
      ...(overrides.totals ?? {}),
    },
    distributions: {
      statusCodes: [
        { key: '2xx', label: '2xx', count: 30, percentage: 71.4 },
        { key: '4xx', label: '4xx', count: 9, percentage: 21.4 },
        { key: '5xx', label: '5xx', count: 3, percentage: 7.1 },
      ],
      methods: [
        { key: 'GET', label: 'GET', count: 33, percentage: 78.6 },
        { key: 'POST', label: 'POST', count: 9, percentage: 21.4 },
      ],
      responseTimes: [
        { key: 'lt_100ms', label: 'lt_100ms', count: 20, percentage: 47.6 },
        { key: '500_1000ms', label: '500_1000ms', count: 14, percentage: 33.3 },
        { key: '1_3s', label: '1_3s', count: 8, percentage: 19.1 },
      ],
      contentTypes: [],
      ...(overrides.distributions ?? {}),
    },
    timeline: {
      buckets: [
        {
          ts: '2026-04-02T10:00:00.000Z',
          hosts: [
            { host: 'api.example.com', count: 5 },
            { host: 'app.example.com', count: 3 },
          ],
        },
        {
          ts: '2026-04-02T10:05:00.000Z',
          hosts: [
            { host: 'api.example.com', count: 8 },
            { host: 'app.example.com', count: 4 },
          ],
        },
      ],
      hosts: ['api.example.com', 'app.example.com'],
      ...(overrides.timeline ?? {}),
    },
    topEndpoints: [
      {
        id: 'ep-1',
        host: 'api.example.com',
        path: '/api/users',
        requestCount: 9,
        failureCount: 1,
        methods: [{ method: 'GET', count: 9 }],
        statusBand: '2xx',
      },
      {
        id: 'ep-2',
        host: 'app.example.com',
        path: '/login',
        requestCount: 4,
        failureCount: 2,
        methods: [{ method: 'POST', count: 4 }],
        statusBand: '4xx',
      },
      ...(overrides.topEndpoints ?? []),
    ],
    topHosts: [
      {
        host: 'api.example.com',
        requestCount: 24,
        failureCount: 1,
        firstSeenAt: '2026-04-02T10:00:00.000Z',
        lastSeenAt: '2026-04-02T10:06:00.000Z',
      },
      {
        host: 'app.example.com',
        requestCount: 18,
        failureCount: 2,
        firstSeenAt: '2026-04-02T10:00:00.000Z',
        lastSeenAt: '2026-04-02T10:05:00.000Z',
      },
      ...(overrides.topHosts ?? []),
    ],
    coverage: {
      source: 'action.summary',
      limitations: [
        'Coverage combines action.summary telemetry with http_payload history and sandbox proxy capture when available.',
      ],
      ...(overrides.coverage ?? {}),
    },
    discoveries: overrides.discoveries ?? [],
    authSurface: overrides.authSurface ?? [],
    securityHeaders: overrides.securityHeaders ?? { totalEndpoints: 0, missingHeaders: [] },
    phases: overrides.phases ?? [],
    generatedAt: '2026-04-02T10:10:00.000Z',
    ...overrides,
  };
}

describe('RunActivityDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a layout-matching skeleton while loading', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByTestId('run-activity-skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when no requests were recorded', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        totals: {
          requests: 0,
          uniqueHosts: 0,
          uniqueEndpoints: 0,
          failures: 0,
          blockedActions: 0,
          averageDurationMs: null,
        },
        topEndpoints: [],
        topHosts: [],
        timeline: { buckets: [], hosts: [] },
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByText(/no http activity recorded for this run yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/only summarized request telemetry is available and sandbox proxy capture was not recorded/i),
    ).toBeInTheDocument();
  });

  it('renders KPI cards and analytics sections for populated activity data', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary(),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByTestId('run-activity-dashboard')).toBeInTheDocument();
    // The metric strip is gone: each breakdown card carries its own total, so
    // those figures were the same number printed a fifth time.
    expect(screen.getByText(/status codes/i)).toBeInTheDocument();
    expect(screen.getByText(/http methods/i)).toBeInTheDocument();
    expect(screen.getByText(/response times/i)).toBeInTheDocument();
    expect(screen.getByText('Testing Timeline')).toBeInTheDocument();
    expect(screen.getByText('Top Endpoints')).toBeInTheDocument();
    expect(screen.getByText('Top Hosts')).toBeInTheDocument();
    expect(screen.queryByText('Attack Phase Timeline')).toBeNull();
    expect(screen.getByText('/api/users')).toBeInTheDocument();
    expect(screen.getAllByText('api.example.com')[0]).toBeInTheDocument();
  });

  it('uses high-contrast status colors in the top endpoints table', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary(),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    // Endpoints render through the shared RecordTable (a grid, not a <table>),
    // and "2xx" now also appears in the status-code breakdown, so scope tightly.
    const table = screen.getByTestId('run-activity-endpoints');
    // Status bands use the brand severity tokens: 2xx cleared, 4xx a warning.
    expect(within(table).getByText('2xx')).toHaveClass('text-success');
    expect(within(table).getByText('4xx')).toHaveClass('text-medium');
  });

  it('renders a per-section empty state when telemetry is too sparse for the timeline chart', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        timeline: {
          buckets: [
            {
              ts: '2026-04-02T10:00:00.000Z',
              hosts: [{ host: 'api.example.com', count: 6 }],
            },
          ],
          hosts: ['api.example.com'],
        },
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByText(/not enough telemetry yet/i)).toBeInTheDocument();
    expect(screen.getByText('Top Endpoints')).toBeInTheDocument();
    expect(screen.getByText('Top Hosts')).toBeInTheDocument();
  });

  it('does not show security headers as missing when raw response headers were not captured', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        securityHeaders: { totalEndpoints: 0, missingHeaders: [] },
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByText(/no captured headers/i)).toBeInTheDocument();
    expect(screen.getByText(/summarized request telemetry is not counted as missing/i)).toBeInTheDocument();
    expect(screen.queryByText(/100%/i)).toBeNull();
  });

  it('keeps the phase timeline visible even when request telemetry is empty', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        totals: {
          requests: 0,
          uniqueHosts: 0,
          uniqueEndpoints: 0,
          failures: 0,
          blockedActions: 0,
          averageDurationMs: null,
        },
        topEndpoints: [],
        topHosts: [],
        timeline: { buckets: [], hosts: [] },
        phases: [
          {
            phase: 'recon',
            label: 'Recon',
            ordinal: 1,
            status: 'running',
            startedAt: '2026-04-02T10:00:00.000Z',
            completedAt: null,
            durationMs: null,
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    expect(screen.getByText(/mission progression/i)).toBeInTheDocument();
    expect(screen.queryByText(/no http activity recorded for this run yet/i)).toBeNull();
  });

  it('opens phase details when a mission progression phase is clicked', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        phases: [
          {
            phase: 'validation',
            label: 'Validation',
            ordinal: 1,
            status: 'running',
            startedAt: '2026-04-02T10:00:00.000Z',
            completedAt: null,
            durationMs: null,
            validationProgress: { total: 3, completed: 1, pending: 2 },
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    fireEvent.click(screen.getByLabelText(/validation.*in progress/i));

    expect(screen.getByRole('dialog', { name: /validation phase details/i })).toBeInTheDocument();
    expect(screen.getByText(/phase details/i)).toBeInTheDocument();
    expect(screen.getByText(/validation queue: 1\/3 completed, 2 pending/i)).toBeInTheDocument();
  });

  it('shows why controlled exploitation was skipped', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        phases: [{
          phase: 'exploitation',
          label: 'Exploitation',
          ordinal: 4,
          status: 'skipped',
          startedAt: '2026-07-25T10:00:00.000Z',
          completedAt: '2026-07-25T10:00:01.000Z',
          durationMs: 1_000,
          reason: 'no_same_run_validated_finding',
        }],
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    // The playground timeline shows step labels only, so a skip reason is one
    // click away in the drawer rather than printed under every phase.
    fireEvent.click(screen.getByLabelText(/exploitation.*skipped/i));
    expect(screen.getByText(/reason: no same run validated finding/i)).toBeInTheDocument();
  });

  it('renders unfinished phases as stopped when a cached activity payload belongs to a cancelled run', async () => {
    const refetch = vi.fn();
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        phases: [
          {
            phase: 'recon',
            label: 'Recon',
            ordinal: 1,
            status: 'completed',
            startedAt: '2026-04-02T10:00:00.000Z',
            completedAt: '2026-04-02T10:05:00.000Z',
            durationMs: 300_000,
          },
          {
            phase: 'enumeration',
            label: 'Enumeration',
            ordinal: 2,
            status: 'running',
            startedAt: '2026-04-02T10:06:00.000Z',
            completedAt: null,
            durationMs: null,
          },
          {
            phase: 'validation',
            label: 'Validation',
            ordinal: 3,
            status: 'pending',
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ],
      }),
      isLoading: false,
      isError: false,
      refetch,
    } as never);

    render(<RunActivityDashboard runId="run-1" isTerminal runStatus="cancelled" />);

    expect(screen.getByLabelText(/recon.*done/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/enumeration.*stopped/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/validation.*stopped/i)).toBeInTheDocument();
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('shows the discovery tooltip on hover', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary({
        discoveries: [
          {
            category: 'vulnerability',
            key: 'disc-1',
            summary: 'Confirmed authorization bypass on export replay path.',
            confidence: 0.93,
            ts: '2026-04-02T10:02:30.000Z',
            outcome: 'success',
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    fireEvent.mouseEnter(screen.getByTestId('run-activity-discovery-marker-0'));

    const tooltip = screen.getByTestId('run-activity-tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent(/confirmed authorization bypass on export replay path\./i);
    expect(tooltip).toHaveStyle({ transform: 'translate(-50%, 12px)' });
  });

  it('shows a line-point tooltip with host request counts on hover', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary(),
      isLoading: false,
      isError: false,
    } as never);

    render(<RunActivityDashboard runId="run-1" />);

    fireEvent.mouseEnter(screen.getByTestId('run-activity-point-api.example.com-0'));

    const tooltip = screen.getByTestId('run-activity-tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('api.example.com');
    expect(tooltip).toHaveTextContent('5 requests');
  });

  it('polls live runs every 5s and disables polling for terminal runs', () => {
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: buildActivitySummary(),
      isLoading: false,
      isError: false,
    } as never);

    const { rerender } = render(<RunActivityDashboard runId="run-1" isTerminal={false} />);

    expect(securityOpsApi.useRunActivityQuery).toHaveBeenLastCalledWith(
      'run-1',
      expect.objectContaining({ refetchInterval: 5_000 }),
    );

    rerender(<RunActivityDashboard runId="run-1" isTerminal />);

    expect(securityOpsApi.useRunActivityQuery).toHaveBeenLastCalledWith(
      'run-1',
      expect.objectContaining({ refetchInterval: false }),
    );
  });
});
