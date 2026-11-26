import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createClient from 'openapi-fetch';
import { toastService } from '@shared/services/toastService';
import { metrics } from '@shared/lib/metrics';

vi.mock('openapi-fetch', () => ({
  default: vi.fn(() => ({
    GET: vi.fn(),
    POST: vi.fn(),
    PATCH: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  })),
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: { warning: vi.fn() },
}));

vi.mock('@shared/lib/metrics', () => ({
  metrics: { apiTiming: { start: vi.fn(), end: vi.fn() } },
}));

const mockCreateClient = vi.mocked(createClient);

const createResponse = (status: number, body: Record<string, unknown> = {}, retryAfter?: string | null) => ({
  status,
  headers: { get: () => retryAfter ?? null },
  clone: () => ({
    json: async () => body,
  }),
});

describe('api client', () => {
  let authFetch: typeof fetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();

    await import('./client');
    const config = mockCreateClient.mock.calls[0]?.[0];
    if (!config) {
      throw new Error('api client not initialized');
    }
    authFetch = config.fetch as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no Authorization header: the backend answers as the local owner', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.headers.get('Authorization')).toBeNull();
      return createResponse(200);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    localStorage.setItem('access_token', 'token');
    await authFetch('http://api.test/path');

    expect(fetchMock).toHaveBeenCalled();
  });

  it('shows the server message on 403 responses, never an upgrade prompt', async () => {
    const fetchMock = vi.fn(async () => createResponse(403, { message: 'Forbidden' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await authFetch('http://api.test/forbidden');

    expect(toastService.warning).toHaveBeenCalledWith('Not allowed', 'Forbidden');
  });

  it('does not retry rate limited responses', async () => {
    // The server is healthy and asking us to slow down. Retrying spends the
    // next window's budget, and each attempt sleeps on Retry-After — which is
    // the full remaining window, up to a minute — while React Query retries
    // this wrapper again on top.
    const fetchMock = vi.fn(async () => createResponse(429, { message: 'Rate limit exceeded' }, '58'));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const response = await authFetch('http://api.test/limited');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(toastService.warning).toHaveBeenCalledWith('Rate limited', 'Rate limit exceeded');
  });

  it('retries transient failures before succeeding', async () => {
    vi.useFakeTimers();
    const responses = [createResponse(500), createResponse(200)];
    const fetchMock = vi.fn(async () => responses.shift() as ReturnType<typeof createResponse>);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const promise = authFetch('http://api.test/retry');
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metrics.apiTiming.start).toHaveBeenCalled();
    expect(metrics.apiTiming.end).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
