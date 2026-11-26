/* @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMeta } from '@/types/chat';
import { useSessionActions } from './useSessionActions';

vi.mock('@shared/services/toastService', () => ({
  toastService: { success: vi.fn(), error: vi.fn() },
}));

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session: ChatSessionMeta = {
    id: 's1',
    desiredExecution: 'running',
    condition: 'executing',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  client.setQueryData(['ai-agent-session', session.id], session);
  client.setQueryData(['ai-agent-sessions'], [session]);
  client.setQueryData(['run', 'r1'], { id: 'r1', status: 'running', sessionId: 's1' });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

describe('useSessionActions canonical commands', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.restoreAllMocks());

  it('applies the committed Stop projection without rewriting run status', async () => {
    const { client, wrapper } = setup();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      desiredExecution: 'stopped',
      condition: 'idle',
      message: 'Stopped',
    }), { status: 200 }));

    const { result } = renderHook(() => useSessionActions(), { wrapper });
    await act(() => result.current.stopSession('s1'));

    expect(client.getQueryData(['ai-agent-session', 's1'])).toMatchObject({
      desiredExecution: 'stopped',
      condition: 'idle',
    });
    expect(client.getQueryData(['run', 'r1'])).toMatchObject({ status: 'running' });
    expect(client.getQueryState(['run', 'r1'])?.isInvalidated).toBe(true);
  });

  it('ignores legacy-only mutation payloads and invalidates for an authoritative read', async () => {
    const { client, wrapper } = setup();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'paused',
      blocked_reason: 'user_paused',
    }), { status: 200 }));

    const { result } = renderHook(() => useSessionActions(), { wrapper });
    await act(() => result.current.stopSession('s1'));

    expect(client.getQueryData(['ai-agent-session', 's1'])).toMatchObject({
      desiredExecution: 'running',
      condition: 'executing',
    });
    expect(client.getQueryState(['ai-agent-session', 's1'])?.isInvalidated).toBe(true);
  });
});
