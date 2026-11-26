/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AssetsPage from './AssetsPage';
import { useAssetsQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAssetsQuery: vi.fn(),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({ activeScopeId: 'scope-demo-acme' }),
}));

vi.mock('./components/AssetKindBadge', () => ({
  AssetKindBadge: ({ kind }: { kind: string }) => <span>{kind}</span>,
}));

vi.mock('@shared/ui/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

// The design system is NOT mocked — see the note in FindingsPage.test.tsx. The
// page is composition over the shared list kit, so these tests render the real
// QueryBar / StatusTabs / RecordTable and would catch a page that quietly grew
// its own list again.

const mockUseAssetsQuery = vi.mocked(useAssetsQuery);

describe('AssetsPage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates into the asset detail route', () => {
    mockUseAssetsQuery.mockReturnValue({
      data: [
        {
          id: 'asset-jobs',
          kind: 'domain',
          value: 'jobs.demo.acme.io',
          tags: ['exports', 'worker'],
          firstSeenAt: '2026-04-06T09:17:06.000Z',
          lastSeenAt: '2026-04-06T09:17:06.000Z',
          focus: { score: 82, label: 'critical', reasons: ['Customer-facing surface'] },
        },
      ],
      isLoading: false,
    } as any);
    render(
      <MemoryRouter initialEntries={['/assets']}>
        <Routes>
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<div>Asset Detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText(/jobs\.demo\.acme\.io/i));

    expect(screen.getByText('Asset Detail')).toBeInTheDocument();
  });

  it('sorts the asset inventory by evidence focus', () => {
    mockUseAssetsQuery.mockReturnValue({
      data: [
        {
          id: 'asset-low',
          kind: 'domain',
          value: 'marketing.demo.acme.io',
          tags: ['marketing'],
          firstSeenAt: '2026-04-06T09:17:06.000Z',
          lastSeenAt: '2026-04-06T09:17:06.000Z',
          focus: { score: 14, label: 'low', reasons: [] },
        },
        {
          id: 'asset-high',
          kind: 'domain',
          value: 'api.demo.acme.io',
          tags: ['auth'],
          firstSeenAt: '2026-04-01T09:17:06.000Z',
          lastSeenAt: '2026-04-01T09:17:06.000Z',
          focus: { score: 91, label: 'critical', reasons: ['Customer-facing surface'] },
        },
      ],
      isLoading: false,
    } as any);
    render(
      <MemoryRouter initialEntries={['/assets']}>
        <Routes>
          <Route path="/assets" element={<AssetsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Rows are the shared data table's row buttons, ordered by focus.
    const assetRows = screen.getAllByRole('button', { name: /open asset: .*\.demo\.acme\.io/i });
    expect(assetRows[0]).toHaveAccessibleName(/api\.demo\.acme\.io/i);
    expect(assetRows[1]).toHaveAccessibleName(/marketing\.demo\.acme\.io/i);
    expect(screen.queryByRole('button', { name: /customer-facing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /needs context queue/i })).not.toBeInTheDocument();
  });





});
