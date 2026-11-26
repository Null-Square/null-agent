import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunnersPage from './RunnersPage';
import { useAuth } from '@/modules/auth';
import { useRunnersQuery, useOrganizationMembersQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useRunnersQuery: vi.fn(),
  useOrganizationMembersQuery: vi.fn(),
  useDeployRunnerMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useRunnerDetailQuery: vi.fn().mockReturnValue({ data: null, isLoading: false }),
}));

vi.mock('@/modules/auth', () => ({
  useAuth: vi.fn(),
}));

// Mock SettingsLayout
vi.mock('@/modules/settings/ui/SettingsLayout', () => ({
  default: ({ children, actions }: any) => <div>{actions}{children}</div>,
}));

// Mock UI components
// The design system is NOT mocked — the page is composition over the shared
// list kit, so these tests render the real components.

const mockUseRunnersQuery = vi.mocked(useRunnersQuery);
const mockUseOrganizationMembersQuery = vi.mocked(useOrganizationMembersQuery);
const mockUseAuth = vi.mocked(useAuth);

describe('RunnersPage RBAC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRunnersQuery.mockReturnValue({ data: [], isLoading: false } as any);
  });

  it('shows Deploy button for Admin', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'admin-id' } } as any);
    mockUseOrganizationMembersQuery.mockReturnValue({ 
      data: [{ userId: 'admin-id', role: 'admin' }] 
    } as any);

    render(
      <MemoryRouter>
        <RunnersPage />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /deploy runner/i })).toBeInTheDocument();
  });

  it('hides Deploy button for Lead', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'lead-id' } } as any);
    mockUseOrganizationMembersQuery.mockReturnValue({ 
      data: [{ userId: 'lead-id', role: 'lead' }] 
    } as any);

    render(
      <MemoryRouter>
        <RunnersPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /deploy runner/i })).toBeNull();
  });

  it('hides Deploy button for Viewer', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'viewer-id' } } as any);
    mockUseOrganizationMembersQuery.mockReturnValue({ 
      data: [{ userId: 'viewer-id', role: 'viewer' }] 
    } as any);

    render(
      <MemoryRouter>
        <RunnersPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /deploy runner/i })).toBeNull();
  });
});
