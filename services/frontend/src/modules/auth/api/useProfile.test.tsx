import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProfile } from './useProfile';
import { useAuth } from '@modules/auth';
import { authenticatedFetch } from '@shared/api';

vi.mock('@modules/auth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@shared/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);
const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);
type AuthState = ReturnType<typeof useAuth>;

const buildAuthState = (overrides: Partial<AuthState> = {}): AuthState => ({
  user: null,
  loading: false,
  ...overrides,
});

describe('useProfile', () => {
  const createWrapper = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears state when no user is present', async () => {
    mockUseAuth.mockReturnValue(buildAuthState({ user: null }));

    const { result } = renderHook(() => useProfile(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.profile).toBeNull();
  });

  it('loads and maps profile data for signed-in users', async () => {
    mockUseAuth.mockReturnValue(buildAuthState({ user: { id: 'u1', email: 'user@example.com' } }));
    mockAuthenticatedFetch.mockResolvedValue({
      profile: {
        id: 'p1',
        user_id: 'u1',
        full_name: 'Operator',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
      },
    });

    const { result } = renderHook(() => useProfile(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.profile?.user_id).toBe('u1');
    });
    expect(result.current.profile?.full_name).toBe('Operator');
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates profile loading across multiple consumers', async () => {
    mockUseAuth.mockReturnValue(buildAuthState({ user: { id: 'u2', email: 'user@example.com' } }));
    mockAuthenticatedFetch.mockResolvedValue({ profile: { user_id: 'u2' } });
    const wrapper = createWrapper();

    const first = renderHook(() => useProfile(), { wrapper });
    const second = renderHook(() => useProfile(), { wrapper });

    await waitFor(() => {
      expect(first.result.current.profile?.user_id).toBe('u2');
      expect(second.result.current.profile?.user_id).toBe('u2');
    });

    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
  });
});
