import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ScopeDetailPage from './ScopeDetailPage';
import {
  useOrganizationMembersQuery,
  useScopeDetailQuery,
  useScopeTargetsQuery,
  useRunsQuery,
  useRunnersQuery,
  useAssetsQuery,
  useUpdateRunnerScopesMutation,
  useUpdateScopeMutation,
  useScopePlanQuery,
  useCreateRunMutation,
  useAddTargetMutation,
  useAutoVerifyTargetMutation,
  useVerifyTargetMutation,
  useRemoveTargetMutation,
} from '@/modules/security-ops/api';
import { useAuth } from '@/modules/auth';

const permissionMocks = vi.hoisted(() => ({
  has: vi.fn((_capability: string) => true),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useOrganizationMembersQuery: vi.fn(),
  useScopeDetailQuery: vi.fn(),
  useScopeTargetsQuery: vi.fn(),
  useRunsQuery: vi.fn(),
  useRunnersQuery: vi.fn(),
  useAssetsQuery: vi.fn(),
  useUpdateRunnerScopesMutation: vi.fn(),
  useUpdateScopeMutation: vi.fn(),
  useScopePlanQuery: vi.fn(),
  useCreateRunMutation: vi.fn(),
  useAddTargetMutation: vi.fn(),
  useAutoVerifyTargetMutation: vi.fn(),
  useVerifyTargetMutation: vi.fn(),
  useRemoveTargetMutation: vi.fn(),
}));

vi.mock('@/modules/auth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({
    has: permissionMocks.has,
  }),
}));

// The Code row is tested on its own (ScopeCodeSource.test.tsx); here only its place.
vi.mock('./components/ScopeCodeSource', () => ({
  default: ({ scopeId }: { scopeId: string }) => <button type="button">Code {scopeId}</button>,
}));

vi.mock('./components/AccessMaterialsSection', () => ({
  AccessMaterialsSection: () => <div>Access Materials Section</div>,
}));

const mockMutation = { mutate: vi.fn(), isPending: false } as any;

describe('ScopeDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMocks.has.mockReturnValue(true);
    vi.mocked(useUpdateRunnerScopesMutation).mockReturnValue(mockMutation);
    vi.mocked(useAuth).mockReturnValue({ user: { id: 'user-1' } } as any);
    vi.mocked(useOrganizationMembersQuery).mockReturnValue({
      data: [{ userId: 'user-1', role: 'admin' }],
      isLoading: false,
    } as any);

    vi.mocked(useScopeDetailQuery).mockReturnValue({
      data: {
        id: 'scope-1',
        name: 'Production Environment',
        whiteboxEnabled: false,
        connectedRepoCount: 0,
        accessMaterialCount: 0,
        attachedRunner: null,
      },
      isLoading: false,
    } as any);
    
    vi.mocked(useScopeTargetsQuery).mockReturnValue({ data: [], isLoading: false } as any);

    
    vi.mocked(useScopeTargetsQuery).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useRunsQuery).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useRunnersQuery).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useAssetsQuery).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useUpdateScopeMutation).mockReturnValue(mockMutation);
    vi.mocked(useScopePlanQuery).mockReturnValue({ data: null, isLoading: false } as any);
    vi.mocked(useCreateRunMutation).mockReturnValue(mockMutation);
    vi.mocked(useAddTargetMutation).mockReturnValue(mockMutation);
    vi.mocked(useAutoVerifyTargetMutation).mockReturnValue(mockMutation);
    vi.mocked(useVerifyTargetMutation).mockReturnValue(mockMutation);
    vi.mocked(useRemoveTargetMutation).mockReturnValue(mockMutation);
  });

  it('renders scope details', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/scopes/scope-1']}>
        <Routes>
          <Route path="/settings/scopes/:id" element={<ScopeDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Production Environment' })).toBeTruthy();
    // Execution now sits inside "Targets & execution" rather than a rail or a
    // heading of its own, so assert the panel that carries it.
    expect(screen.getByRole('button', { name: /targets & execution/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rules of engagement/i })).toBeInTheDocument();
    /* Compliance maps findings to a framework and narrows nothing, so it is its
       own card rather than a third thing under the rules. */
    expect(screen.getByRole('button', { name: /^compliance/i })).toBeInTheDocument();
    // Code sits between the rules and compliance.
    const rules = screen.getByRole('button', { name: /rules of engagement/i });
    const code = screen.getByRole('button', { name: 'Code scope-1' });
    const compliance = screen.getByRole('button', { name: /^compliance/i });
    expect(rules.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(code.compareDocumentPosition(compliance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/authorization required/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/this computer/i).length).toBeGreaterThan(0);
    // The GitHub repository section is gone: it needed NullSquare's GitHub App.
    expect(screen.queryByRole('button', { name: /repositories/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'STRATEGY' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OBSERVATIONS' })).not.toBeInTheDocument();
  });

  it('hides danger zone for non-admin', async () => {
    permissionMocks.has.mockImplementation((capability: string) => capability !== 'org.settings.write');
    vi.mocked(useOrganizationMembersQuery).mockReturnValue({
        data: [{ userId: 'user-1', role: 'viewer' }],
        isLoading: false,
    } as any);

    render(
      <MemoryRouter initialEntries={['/settings/scopes/scope-1']}>
        <Routes>
          <Route path="/settings/scopes/:id" element={<ScopeDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Production Environment' })).toBeTruthy();
    expect(screen.queryByText('Danger Zone')).toBeNull();
  });

  it('shows danger zone for admin', async () => {
    vi.mocked(useOrganizationMembersQuery).mockReturnValue({
        data: [{ userId: 'user-1', role: 'admin' }],
        isLoading: false,
    } as any);

    render(
      <MemoryRouter initialEntries={['/settings/scopes/scope-1']}>
        <Routes>
          <Route path="/settings/scopes/:id" element={<ScopeDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Production Environment' })).toBeTruthy();
    expect(screen.getByText(/danger zone/i)).toBeInTheDocument();
  });
});
