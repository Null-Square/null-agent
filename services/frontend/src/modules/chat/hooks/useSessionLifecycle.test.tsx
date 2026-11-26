/* @vitest-environment jsdom */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

import { useSessionLifecycle } from './useSessionLifecycle';
import { renderWithClient } from '@/test/utils';
import type { ChatSessionMeta } from '@/types/chat';
import type { Run } from '@modules/security-ops/types';

const pushToast = vi.fn();

const baseParams = {
  currentSessionId: '',
  setCurrentSessionId: vi.fn(),
  setSessionMode: vi.fn(),
  dispatch: vi.fn(),
  connectStream: vi.fn(),
  disconnectStream: vi.fn(),
  isLoading: false,
  desiredExecution: 'running' as const,
  condition: 'idle' as const,
  sessionStatus: 'idle' as const,
  isAborting: false,
  addMessage: vi.fn().mockReturnValue('msg-1'),
  pendingUserMessagesRef: { current: [] as Array<{ tempId: string; content: string }> },
  assistantMessageRef: { current: null as string | null },
  flushCoalescedUpdates: vi.fn(),
  resetCoalescers: vi.fn(),
  pushToast,
  clearToast: vi.fn(),
  generateId: vi.fn(() => 'gen-1'),
};

describe('useSessionLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  const seedSessionAndRun = (
    queryClient: ReturnType<typeof renderWithClient>['queryClient'],
    sessionId: string,
    status: ChatSessionMeta['status'],
    pauseReason: ChatSessionMeta['pause_reason'] = null,
    interactionType: ChatSessionMeta['interaction_type'] = 'none',
    blockedReason: string | null = null,
  ) => {
    const session: ChatSessionMeta = {
      id: sessionId,
      desiredExecution: status === 'paused' ? 'stopped' : 'running',
      condition: status === 'completed' ? 'completed' : status === 'running' ? 'executing' : 'idle',
      status,
      blocked_reason: blockedReason,
      pause_reason: pauseReason,
      interaction_type: interactionType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const run: Run = {
      id: 'run-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      sessionId,
      activeSessionId: sessionId,
      plannerSessionId: null,
      executorSessionId: sessionId,
      goal: 'test run',
      status: status === 'paused' ? 'paused' : 'running',
      pauseReason: status === 'paused' ? pauseReason : null,
      interactionType: status === 'paused' ? interactionType : 'none',
      trigger: 'manual',
      startedAt: null,
      completedAt: null,
    };

    queryClient.setQueryData(['ai-agent-session', sessionId], session);
    queryClient.setQueryData(['ai-agent-sessions'], [session]);
    queryClient.setQueryData(['run', run.id], run);
    queryClient.setQueryData(['runs', {}], [run]);
  };

  it('sendPrompt without a session asks for a scope chat and calls nothing', async () => {
    const { Wrapper } = renderWithClient();
    const { result } = renderHook(() => useSessionLifecycle(baseParams), { wrapper: Wrapper });

    await act(async () => {
      await result.current.sendPrompt('hello');
    });

    expect(pushToast).toHaveBeenCalledWith('Start a chat from a scope first.');
    expect(baseParams.addMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Stop no-ops with a toast when there is no active session', async () => {
    const { Wrapper } = renderWithClient();
    const { result } = renderHook(() => useSessionLifecycle(baseParams), { wrapper: Wrapper });

    await act(async () => {
      await result.current.abortTurn();
    });

    expect(pushToast).toHaveBeenCalledWith('No active session to stop.');
  });

  it('abortTurn shows idle toast when session is not running', async () => {
    const params = { ...baseParams, currentSessionId: 's1', sessionStatus: 'idle' as const };
    const { Wrapper } = renderWithClient();
    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.abortTurn();
    });

    expect(pushToast).toHaveBeenCalledWith('Agent is idle.');
  });

  it('sendPrompt applies the committed session pair without patching run caches', async () => {
    (fetch as unknown as Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        accepted: true,
        desiredExecution: 'running',
        condition: 'recovering',
        status: 'running',
        pause_reason: 'system',
        interaction_type: 'none',
        blocked_reason: null,
      }),
    });

    const { Wrapper, queryClient } = renderWithClient();
    seedSessionAndRun(queryClient, 's-send', 'paused', 'manual', 'none', 'user_paused');
    const params = {
      ...baseParams,
      currentSessionId: 's-send',
      desiredExecution: 'stopped' as const,
      condition: 'idle' as const,
      sessionStatus: 'paused' as const,
    };

    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.sendPrompt('continue');
    });

    expect(queryClient.getQueryData<Run>(['run', 'run-1'])).toMatchObject({
      status: 'paused',
    });
    expect(queryClient.getQueryData<Run[]>(['runs', {}])).toEqual([
      expect.objectContaining({ id: 'run-1', status: 'paused' }),
    ]);
    expect(queryClient.getQueryData<ChatSessionMeta>(['ai-agent-session', 's-send'])).toMatchObject({
      desiredExecution: 'running',
      condition: 'recovering',
    });
  });

  it('sendPrompt accepts a cancelled session as a new durable Start request', async () => {
    (fetch as unknown as Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accepted: true, scheduled: true }),
    });
    const { Wrapper } = renderWithClient();
    const params = {
      ...baseParams,
      currentSessionId: 's-cancelled',
      sessionMode: 'automated' as const,
      runStatus: 'cancelled',
      sessionStatus: 'paused' as const,
      blockedReason: 'aborted_by_user',
    };

    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.sendPrompt('continue');
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/sessions/s-cancelled/message'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('sendPrompt blocks automated workbench messaging until the run is manually paused', async () => {
    const { Wrapper } = renderWithClient();
    const params = {
      ...baseParams,
      currentSessionId: 's-running-run',
      sessionMode: 'automated' as const,
      runStatus: 'running',
      desiredExecution: 'running' as const,
      condition: 'executing' as const,
      sessionStatus: 'running' as const,
    };

    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.sendPrompt('interrupt the run');
    });

    expect(pushToast).toHaveBeenCalledWith('Stop the run before sending a workbench message.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('abortTurn applies the committed Stop pair without patching run caches', async () => {
    (fetch as unknown as Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          desiredExecution: 'stopped',
          condition: 'idle',
          status: 'paused',
          pause_reason: 'manual',
          interaction_type: 'none',
          blocked_reason: 'user_paused',
        }),
    });

    const { Wrapper, queryClient } = renderWithClient();
    seedSessionAndRun(queryClient, 's-abort', 'running');
    const params = {
      ...baseParams,
      currentSessionId: 's-abort',
      desiredExecution: 'running' as const,
      condition: 'executing' as const,
      sessionStatus: 'running' as const,
      isLoading: true,
    };

    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.abortTurn();
    });

    expect(queryClient.getQueryData<Run>(['run', 'run-1'])).toMatchObject({
      status: 'running',
    });
    expect(queryClient.getQueryData<Run[]>(['runs', {}])).toEqual([
      expect.objectContaining({
        id: 'run-1',
        status: 'running',
      }),
    ]);
    expect(queryClient.getQueryData<ChatSessionMeta>(['ai-agent-session', 's-abort'])).toMatchObject({
      desiredExecution: 'stopped',
      condition: 'idle',
      status: 'paused',
    });
  });

  it('abortTurn reconciles to idle when the turn already ended before the stop request landed', async () => {
    (fetch as unknown as Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          desiredExecution: 'stopped',
          condition: 'idle',
          status: 'idle',
          pause_reason: null,
          interaction_type: 'none',
          blocked_reason: null,
          message: 'Session is not currently running.',
        }),
    });

    const { Wrapper, queryClient } = renderWithClient();
    seedSessionAndRun(queryClient, 's-race', 'running');
    const params = {
      ...baseParams,
      currentSessionId: 's-race',
      desiredExecution: 'running' as const,
      condition: 'executing' as const,
      sessionStatus: 'running' as const,
      isLoading: true,
    };

    const { result } = renderHook(() => useSessionLifecycle(params), { wrapper: Wrapper });

    await act(async () => {
      await result.current.abortTurn();
    });

    expect(queryClient.getQueryData<Run>(['run', 'run-1'])).toMatchObject({
      status: 'running',
    });
    expect(pushToast).toHaveBeenCalledWith('Session is not currently running.');
  });
});
