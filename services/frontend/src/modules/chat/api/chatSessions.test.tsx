/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAssistantChatSessionsQuery,
  useCreateScopedChatSessionMutation,
  useDeleteAssistantChatSessionMutation,
  useRenameAssistantChatSessionMutation,
} from './chatSessions';
import { authenticatedFetch } from '@shared/api';

vi.mock('@shared/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

const wrapperWithClient = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>;

describe('chatSessions API hooks', () => {
  beforeEach(() => {
    mockAuthenticatedFetch.mockReset();
  });

  it('creates a scoped read-only chat session and invalidates related caches', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({
      sessionId: 'chat-session-1',
      mode: 'interactive',
      assistant: {
        mode: 'read_only',
        profileKey: 'security-assistant',
        scopeContext: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          schema: 'nullsquare.scope-aware-chat.v3',
          sections: ['organization', 'scope', 'targets', 'roe_document'],
        },
      },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateScopedChatSessionMutation(), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        scopeId: 'scope-1',
        modelId: 'model-1',
        initialPrompt: 'Explain the latest blocked technique.',
      });
    });

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        scopeId: 'scope-1',
        modelId: 'model-1',
        initialPrompt: 'Explain the latest blocked technique.',
      }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-sessions'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 'chat-session-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assistant-chat-sessions'] });
  });

  it('skips session-list invalidation for transient assistant chats', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({
      sessionId: 'chat-session-2',
      mode: 'interactive',
      assistant: {
        mode: 'read_only',
        profileKey: 'security-assistant',
        scopeContext: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          schema: 'nullsquare.scope-aware-chat.v3',
          sections: ['organization', 'scope'],
        },
      },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateScopedChatSessionMutation({ syncSessionList: false }), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ scopeId: 'scope-1' });
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['ai-agent-sessions'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 'chat-session-2'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assistant-chat-sessions'] });
  });

  it('lists assistant chat history for the active scope', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({
      sessions: [
        {
          id: 'chat-session-3',
          title: 'Explain the last validation run',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastActive: Date.now(),
          status: 'idle',
          scopeId: 'scope-1',
          summary: 'Asked about the last validation run',
          assistantMode: 'read_only_chat',
          sessionKind: 'assistant_chat',
        },
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAssistantChatSessionsQuery('scope-1'), {
      wrapper: wrapperWithClient(client),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([
        expect.objectContaining({
          id: 'chat-session-3',
          scopeId: 'scope-1',
          assistantMode: 'read_only_chat',
          sessionKind: 'assistant_chat',
        }),
      ]);
    });

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/app/chat/sessions?scopeId=scope-1');
  });

  it('renames an assistant chat session and invalidates assistant history caches', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({
      success: true,
      title: 'Renamed assistant chat',
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRenameAssistantChatSessionMutation(), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: 'chat-session-4',
        title: 'Renamed assistant chat',
      });
    });

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/app/chat/sessions/chat-session-4', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed assistant chat' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assistant-chat-sessions'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 'chat-session-4'] });
  });

  it('deletes an assistant chat session and evicts its detail cache', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({
      success: true,
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const removeSpy = vi.spyOn(client, 'removeQueries');
    const { result } = renderHook(() => useDeleteAssistantChatSessionMutation(), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync('chat-session-5');
    });

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/app/chat/sessions/chat-session-5', {
      method: 'DELETE',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assistant-chat-sessions'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 'chat-session-5'] });
  });
});
