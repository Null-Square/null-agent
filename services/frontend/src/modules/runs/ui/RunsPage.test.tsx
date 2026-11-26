/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RunsPage from './RunsPage';
import { useRunsQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useRunsQuery: vi.fn(),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({ activeScopeId: 'scope-demo-acme' }),
}));


vi.mock('@shared/ui/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

// The design system is NOT mocked — the page is composition over the shared
// list kit, so these tests render the real QueryBar / RecordTable and would
// catch the page growing its own list again.

const mockUseRunsQuery = vi.mocked(useRunsQuery);

describe('RunsPage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('polls the run list so stale pause badges clear after resume reconciliation', () => {
    mockUseRunsQuery.mockReturnValue({
      data: [],
      isLoading: false,
    } as any);

    render(
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route path="/runs" element={<RunsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Deliberately no polling override: arrivals come from the live event
    // stream, and the query's own default stops polling once nothing is active.
    expect(mockUseRunsQuery).toHaveBeenCalledWith({ scopeId: 'scope-demo-acme' });
  });

  it('navigates into the run detail route', () => {
    mockUseRunsQuery.mockReturnValue({
      data: [
        {
          id: 'demo-run-auth-boundary',
          displayId: 'RUN-1042',
          title: 'Authenticated surface review',
          goal: 'Validate export authorization controls',
          scopeName: 'Acme Retail Production',
          status: 'completed',
          trigger: 'manual',
          startedAt: '2026-04-06T09:00:00.000Z',
          findingsDiscovered: 4,
        },
      ],
      isLoading: false,
    } as any);

    render(
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<div>Run Detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText(/Authenticated surface review/i));

    expect(screen.getByText('Run Detail')).toBeInTheDocument();
  });
});
