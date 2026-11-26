import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './fetchClient';
import { ERROR_CODES } from '@null-ai/contracts';
import { createQueryClient } from '@shared/lib/queryClient';

describe('fetchClient errors', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('preserves HTTP status and canonical code for retry decisions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
      message: 'Rate limit exceeded',
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(api.get('/app/dashboard/service-status')).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
      status: 429,
      message: 'Rate limit exceeded',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not multiply a 429 through React Query retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
      message: 'Rate limit exceeded',
    }), { status: 429 }));
    const queryClient = createQueryClient();

    await expect(queryClient.fetchQuery({
      queryKey: ['rate-limited-request'],
      queryFn: () => api.get('/app/dashboard/service-status'),
    })).rejects.toMatchObject({ status: 429 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
