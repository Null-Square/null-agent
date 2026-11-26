/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { useDerivedSessionTitle } from './useDerivedSessionTitle';
import { DEFAULT_SESSION_TITLE } from '@modules/sessions/lib/sessionTitle';
import type { AIChatMessage, TaskSummary } from '@/types/chat';

const createWrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const userMessage = (content: string): AIChatMessage => ({
  id: 'm1',
  role: 'user',
  content,
  timestamp: new Date(),
});

const clientWith = (sessions: { id: string; title?: string | null }[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['ai-agent-sessions'], sessions);
  return client;
};

const titles = (client: QueryClient) =>
  client.getQueryData<{ id: string; title?: string | null }[]>(['ai-agent-sessions']);

describe('useDerivedSessionTitle', () => {
  it('names an untitled session from the first user message', async () => {
    const client = clientWith([{ id: 's1', title: DEFAULT_SESSION_TITLE }]);

    renderHook(
      () => useDerivedSessionTitle({ sessionId: 's1', messages: [userMessage('Scan shop.example.com')] }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(titles(client)?.[0]?.title).toBe('Scan shop.example.com');
    });
  });

  it('prefers the task title when the session is running one', async () => {
    const client = clientWith([{ id: 's2', title: DEFAULT_SESSION_TITLE }]);

    renderHook(
      () =>
        useDerivedSessionTitle({
          sessionId: 's2',
          messages: [userMessage('Scan shop.example.com')],
          task: { title: 'Quarterly assessment' } as TaskSummary,
        }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(titles(client)?.[0]?.title).toBe('Quarterly assessment');
    });
  });

  it('never overwrites a title somebody chose', async () => {
    const client = clientWith([{ id: 's3', title: 'Named by hand' }]);

    renderHook(
      () => useDerivedSessionTitle({ sessionId: 's3', messages: [userMessage('Scan shop.example.com')] }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(titles(client)?.[0]?.title).toBe('Named by hand');
    });
  });

  it('does nothing when disabled, without a session, or before anyone speaks', async () => {
    const cases: Array<Parameters<typeof useDerivedSessionTitle>[0]> = [
      { sessionId: 's4', messages: [userMessage('hello')], enabled: false },
      { sessionId: '', messages: [userMessage('hello')] },
      { sessionId: 's4', messages: [] },
      // Tool traffic is machinery, not something a person said.
      { sessionId: 's4', messages: [{ id: 't1', role: 'tool', content: 'ok', timestamp: new Date() }] },
    ];

    for (const params of cases) {
      const client = clientWith([{ id: 's4', title: DEFAULT_SESSION_TITLE }]);
      renderHook(() => useDerivedSessionTitle(params), { wrapper: createWrapper(client) });
      await waitFor(() => {
        expect(titles(client)?.[0]?.title).toBe(DEFAULT_SESSION_TITLE);
      });
    }
  });
});
