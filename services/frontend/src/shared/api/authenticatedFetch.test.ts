import { afterEach, describe, expect, it, vi } from 'vitest';
import { toApiError, ERROR_CODES } from '@shared/lib/apiError';
import {
  authenticatedFetch,
  authenticatedFormDataFetch,
} from './authenticatedFetch';

const createResponse = (options: {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}) =>
  ({
    ok: options.ok,
    status: options.status,
    json: async () => options.json,
  }) as Response;

describe('authenticatedFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('sends no Authorization header (the backend answers as the local owner) and parses JSON responses', async () => {
    localStorage.setItem('access_token', 'token');
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(String(input)).toBe('http://api.test/data');
      return createResponse({ ok: true, status: 200, json: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const data = await authenticatedFetch<{ ok: boolean }>('http://api.test/data');
    expect(data.ok).toBe(true);
  });

  it('passes caller headers through', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('X-Test')).toBe('1');
      return createResponse({ ok: true, status: 200, json: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await authenticatedFetch('http://api.test/public', {
      headers: { 'X-Test': '1' },
    });
  });

  it('throws ApiError with extracted message and code', async () => {
    const fetchMock = vi.fn(async () =>
      createResponse({
        ok: false,
        status: 403,
        json: { error: { message: 'Forbidden' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(authenticatedFetch('http://api.test/forbidden')).rejects.toMatchObject({
      message: 'Forbidden',
      status: 403,
      code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
    });
  });
});

describe('authenticatedFormDataFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('posts form data without an Authorization header', async () => {
    localStorage.setItem('access_token', 'token');
    const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('Content-Type')).toBeNull();
      return createResponse({ ok: true, status: 200, json: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const formData = new FormData();
    formData.append('file', new File(['data'], 'file.txt'));

    await authenticatedFormDataFetch('http://api.test/upload', formData);
  });

  it('throws ApiError for failed form uploads', async () => {
    const fetchMock = vi.fn(async () =>
      createResponse({
        ok: false,
        status: 413,
        json: { message: 'File too large' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      await authenticatedFormDataFetch('http://api.test/upload', new FormData());
      throw new Error('expected throw');
    } catch (error) {
      const apiError = toApiError(error);
      expect(apiError.status).toBe(413);
      expect(apiError.message).toBe('File too large');
    }
  });
});
