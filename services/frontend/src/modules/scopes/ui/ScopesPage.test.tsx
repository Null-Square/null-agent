import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScopesPage from './ScopesPage';
import { useScopesQuery } from '@/modules/security-ops/api';

const permissionMocks = vi.hoisted(() => ({
  has: vi.fn(() => true),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useScopesQuery: vi.fn(),
  useCreateScopeMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({
    has: permissionMocks.has,
  }),
}));

const mockUseScopesQuery = vi.mocked(useScopesQuery);

describe('ScopesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMocks.has.mockReturnValue(true);
    mockUseScopesQuery.mockReturnValue({
      data: [
        {
          id: 'scope-1',
          name: 'Production',
          executionNetwork: 'external',
          whiteboxEnabled: true,
          targetCount: 1,
          verifiedTargetCount: 1,
          lastRunAt: new Date().toISOString(),
        },
      ],
      isLoading: false,
    } as any);
  });

  it('renders scopes list', async () => {
    render(
      <MemoryRouter>
        <ScopesPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('Production')).toBeTruthy();
    expect(screen.getByText('Whitebox')).toBeTruthy();
    // The shared table renders the execution cell twice — desktop column and
    // mobile stack — and only one is ever displayed.
    expect(screen.getAllByText('this computer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scopes')).not.toHaveLength(0);
  });

  it('opens scope creation with no plan limit notice', async () => {
    render(
      <MemoryRouter>
        <ScopesPage />
      </MemoryRouter>
    );

    const newScopeButton = screen.getByRole('button', { name: /new scope/i });
    expect(newScopeButton).not.toBeDisabled();
    
    expect(screen.queryByText(/scope limit reached/i)).not.toBeInTheDocument();
    
    fireEvent.click(newScopeButton);

    expect(screen.queryByText(/scope limit reached/i)).not.toBeInTheDocument();
  });
});
