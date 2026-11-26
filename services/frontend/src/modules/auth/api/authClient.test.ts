import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from './authClient';
import { api, authenticatedFetch } from '@shared/api';

vi.mock('@shared/api', () => ({
  api: {
    GET: vi.fn(),
  },
  authenticatedFetch: vi.fn(),
  apiBaseUrl: 'http://api.test',
}));

const mockApi = vi.mocked(api);
const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);
type ApiGetResult = Awaited<ReturnType<typeof mockApi.GET>>;

describe('authClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('reads the local owner from /api/auth/me and stores no token', async () => {
    mockApi.GET.mockResolvedValue({
      data: { user: { id: 'u1', email: 'owner@localhost', created_at: '2026-01-01T00:00:00.000Z' } },
      error: undefined,
    } as unknown as ApiGetResult);

    const result = await authClient.getUser();

    expect(mockApi.GET).toHaveBeenCalledWith('/api/auth/me');
    expect(result.error).toBeNull();
    expect(result.data?.email).toBe('owner@localhost');
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('returns the error when the owner cannot be read', async () => {
    mockApi.GET.mockResolvedValue({
      data: null,
      error: { status: 500, message: 'Unavailable' },
    } as unknown as ApiGetResult);

    const result = await authClient.getUser();
    expect(result.error?.message).toBe('Unavailable');
    expect(result.data).toBeNull();
  });

  it('reports a 401 when this browser does not hold the owner key', async () => {
    mockApi.GET.mockResolvedValue({
      data: null,
      error: { code: 'auth.invalid_session', message: 'Open Null AI from the link it printed when it started.' },
      response: { status: 401 },
    } as unknown as ApiGetResult);

    const result = await authClient.getUser();
    expect(result.error?.status).toBe(401);
    expect(result.data).toBeNull();
  });

  it('returns setup status based on scopes', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce({ profile: null })
      .mockResolvedValueOnce([]);
    const result = await authClient.getSetupStatus();

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ setup_required: true });
  });

  it('treats a usable scope as finished setup, with no welcome step after it', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce({ profile: { preferences: {} } })
      .mockResolvedValueOnce([{ id: 'scope-1' }]);

    const result = await authClient.getSetupStatus();

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ setup_required: false });
  });

  it('keeps setup pending when a checkpoint exists even after a scope was created', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce({
        profile: {
          preferences: {
            onboardingProgress: {
              version: 1,
              lastCompletedStep: 3,
              formData: {},
              scopeId: 'scope-1',
              targetId: 'target-1',
              targetSnapshot: 'domain:example.com:dns_txt',
              updatedAt: '2026-07-26T00:00:00.000Z',
            },
          },
        },
      })
      .mockResolvedValueOnce([{ id: 'scope-1', targetCount: 1 }]);

    const result = await authClient.getSetupStatus();

    expect(result.data).toEqual({ setup_required: true });
  });

  it('requires setup for a legacy empty scope', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce({ profile: { preferences: {} } })
      .mockResolvedValueOnce([{ id: 'scope-empty', targetCount: 0 }]);

    const result = await authClient.getSetupStatus();

    expect(result.data).toEqual({ setup_required: true });
  });

  it('does not refetch the guarded scope surface after explicit completion', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce({
        profile: {
          preferences: {
            onboardingCompletedAt: '2026-07-26T00:00:00.000Z',
          },
        },
      });

    const result = await authClient.getSetupStatus();

    expect(result.data).toEqual({ setup_required: false });
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
  });
});
