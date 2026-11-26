/* @vitest-environment jsdom */

import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  useSessionsQuery,
  useSessionDetailsQuery,
  useDeleteSessionMutation,
  fetchSessionMessages,
} from './sessions';
import { ApiError } from '@shared/lib/apiError';
import type { ChatSessionMeta } from '@/types/chat';
import { api } from '@shared/api';

vi.mock('@shared/lib/apiError', async () => {
  const actual = await vi.importActual<typeof import('@shared/lib/apiError')>('@shared/lib/apiError');
  return { ...actual, shouldRetry: vi.fn(() => false) };
});

vi.mock('@shared/api', () => {
  const mockApi = {
    GET: vi.fn(),
    DELETE: vi.fn(),
  };
  return { api: mockApi };
});

const mockApi = api as unknown as {
  GET: ReturnType<typeof vi.fn>;
  DELETE: ReturnType<typeof vi.fn>;
};

const wrapperWithClient = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const baseSession = (id: string, overrides?: Partial<ChatSessionMeta>): ChatSessionMeta => ({
  id,
  desiredExecution: 'running',
  condition: 'idle',
  status: 'idle',
  blocked_reason: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('sessions API hooks/services', () => {
  beforeEach(() => {
    mockApi.GET.mockReset();
    mockApi.DELETE.mockReset();
  });

  it('useSessionsQuery returns sessions data', async () => {
    const session = baseSession('s1');
    mockApi.GET.mockResolvedValueOnce({ data: { sessions: [session] }, error: null });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSessionsQuery(), { wrapper: wrapperWithClient(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([session]);
  });

  it('useSessionsQuery stays idle when disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSessionsQuery({ enabled: false }), {
      wrapper: wrapperWithClient(client),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.GET).not.toHaveBeenCalled();
  });

  it('useSessionsQuery surfaces ApiError on rate limit', async () => {
    mockApi.GET.mockResolvedValueOnce({
      data: undefined,
      error: { response: { status: 429, data: { message: 'limit' } } },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSessionsQuery(), { wrapper: wrapperWithClient(client) });

    await expect(
      result.current.refetch({ throwOnError: true })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('useSessionDetailsQuery throws when session missing', async () => {
    mockApi.GET.mockResolvedValueOnce({ data: {}, error: null });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSessionDetailsQuery('missing'), {
      wrapper: wrapperWithClient(client),
    });

    await expect(
      result.current.refetch({ throwOnError: true })
    ).rejects.toThrow('Session not found');
  });

  it('useSessionDetailsQuery stays idle when disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSessionDetailsQuery('workbench-session', { enabled: false }), {
      wrapper: wrapperWithClient(client),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.GET).not.toHaveBeenCalled();
  });

  it('useDeleteSessionMutation removes session cache on success', async () => {
    mockApi.DELETE.mockResolvedValueOnce({ error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['ai-agent-session', 's-del'], baseSession('s-del'));
    client.setQueryData(['ai-agent-sessions'], [baseSession('s-del')]);

    const { result } = renderHook(() => useDeleteSessionMutation(), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync('s-del');
    });

    expect(mockApi.DELETE).toHaveBeenCalledWith('/api/ai-agent/sessions/{sessionId}', {
      params: { path: { sessionId: 's-del' } },
    });
    expect(client.getQueryData(['ai-agent-session', 's-del'])).toBeUndefined();
  });

  it('fetchSessionMessages returns messages and throws ApiError on failure', async () => {
    mockApi.GET.mockResolvedValueOnce({
      data: { messages: [{ id: 'm1', role: 'assistant', content: 'hi', createdAt: 'now' }] },
      error: null,
    });
    const ok = await fetchSessionMessages('s1');
    expect(ok.messages[0].id).toBe('m1');

    mockApi.GET.mockResolvedValueOnce({
      data: undefined,
      error: { response: { status: 500, data: { message: 'fail' } } },
    });
    await expect(fetchSessionMessages('s1')).rejects.toBeInstanceOf(ApiError);
  });

});
