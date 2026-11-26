/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { api } from '@shared/api';
import { useSubscriptionQuery } from './subscription';

vi.mock('@shared/api', () => ({
  api: { GET: vi.fn() },
}));

const mockApi = vi.mocked(api);
type ApiGetResult = Awaited<ReturnType<typeof mockApi.GET>>;

const createWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe('useSubscriptionQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the local plan, its features and limits, and keeps no credits', async () => {
    mockApi.GET.mockResolvedValue({
      data: {
        subscription: {
          plan: {
            slug: 'local',
            name: 'Local',
            experienceProfile: 'workbench',
            creditsPerPeriod: 0,
            features: { accessAutomations: true, accessPrivateRunners: true },
            limits: { maxConcurrentRuns: null },
          },
          creditsCurrent: 0,
        },
      },
      error: undefined,
    } as unknown as ApiGetResult);

    const { result } = renderHook(() => useSubscriptionQuery(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.GET).toHaveBeenCalledWith('/api/profile/subscription');
    expect(result.current.data).toEqual({
      plan: {
        id: 'local',
        name: 'Local',
        slug: 'local',
        features: { accessAutomations: true, accessPrivateRunners: true },
        limits: { maxConcurrentRuns: null },
      },
    });
  });

  it('returns null when the backend has no plan', async () => {
    mockApi.GET.mockResolvedValue({ data: { subscription: null }, error: undefined } as unknown as ApiGetResult);

    const { result } = renderHook(() => useSubscriptionQuery(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
  });
});
