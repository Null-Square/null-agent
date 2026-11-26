/* @vitest-environment jsdom */

import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useChatStreaming } from './useChatStreaming';
import type { ChatSessionMeta, ChatSessionSnapshot } from '@/types/chat';
import type { Run } from '@modules/security-ops/types';

vi.mock('@modules/sessions/lib/sessionLogger', () => ({
  sessionLogger: {
    sseCachePatch: vi.fn(),
    optimisticPatch: vi.fn(),
    cacheState: vi.fn(),
    rollback: vi.fn(),
  },
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  emit(type: string, payload: unknown) {
    const event = { data: typeof payload === 'string' ? payload : JSON.stringify(payload) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() {
    this.closed = true;
  }
}

const createClient = (session: ChatSessionMeta) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData<ChatSessionMeta>(['ai-agent-session', session.id], session);
  client.setQueryData<ChatSessionMeta[]>(['ai-agent-sessions'], [session]);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  return { client, wrapper };
};

const createOptions = (overrides: Partial<Parameters<typeof useChatStreaming>[0]> = {}) => {
  const dispatch = vi.fn();

  return {
    apiBase: 'http://localhost:3000',
    addMessage: vi.fn().mockReturnValue('msg-1'),
    dispatch,
    dispatchMany: vi.fn(),
    pushToast: vi.fn(),
    onApprovalNeeded: vi.fn(),
    onApprovalGranted: vi.fn(),
    onApprovalDenied: vi.fn(),
    tokenCoalescer: { append: vi.fn(), flush: vi.fn(), reset: vi.fn() },
    toolCoalescer: { append: vi.fn(), flush: vi.fn(), reset: vi.fn() },
    flushCoalescedUpdates: vi.fn(),
    resetCoalescers: vi.fn(),
    createId: vi.fn(() => 'gen-1'),
    normalizeTaskSummary: vi.fn(() => undefined),
    ...overrides,
  };
};

describe('useChatStreaming (pause protection)', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not override paused session on token events when blocked_reason is set', () => {
    const pausedSession: ChatSessionMeta = {
      id: 's1',
      desiredExecution: 'stopped',
      condition: 'idle',
      status: 'paused',
      pause_reason: 'manual',
      interaction_type: 'none',
      blocked_reason: 'user_paused',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(pausedSession);
    const options = createOptions();

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s1');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('token', JSON.stringify('chunk'));
    });

    expect(client.getQueryData<ChatSessionMeta>(['ai-agent-session', 's1'])).toMatchObject({
      status: 'paused',
      pause_reason: 'manual',
      blocked_reason: 'user_paused',
    });
    expect(client.getQueryData<ChatSessionMeta[]>(['ai-agent-sessions'])).toEqual([
      expect.objectContaining({ id: 's1', status: 'paused', pause_reason: 'manual', blocked_reason: 'user_paused' }),
    ]);
  });

  it('does not override paused sessions on message_start events', () => {
    const blockedSession: ChatSessionMeta = {
      id: 's2',
      desiredExecution: 'stopped',
      condition: 'idle',
      status: 'paused',
      pause_reason: 'manual',
      interaction_type: 'none',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(blockedSession);
    const options = createOptions();

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s2');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('message_start', JSON.stringify({ role: 'assistant' }));
    });

    expect(client.getQueryData<ChatSessionMeta>(['ai-agent-session', 's2'])).toMatchObject({
      status: 'paused',
      pause_reason: 'manual',
      blocked_reason: null,
    });
  });

  it('does not optimistically patch running state when session is not blocked', () => {
    const idleSession: ChatSessionMeta = {
      id: 's3',
      desiredExecution: 'running',
      condition: 'idle',
      status: 'idle',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(idleSession);
    const options = createOptions();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s3');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('token', JSON.stringify('chunk'));
    });

    expect(client.getQueryData<ChatSessionMeta>(['ai-agent-session', 's3'])).toMatchObject({
      status: 'idle',
      blocked_reason: null,
    });
    expect(client.getQueryData<ChatSessionMeta[]>(['ai-agent-sessions'])).toEqual([
      expect.objectContaining({ id: 's3', status: 'idle', blocked_reason: null }),
    ]);
    expect(invalidateQueries).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['ai-agent-session', 's3'] }));
    expect(options.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'session/setLoading', payload: true }));
  });

  it('keeps session blocked and does not dispatch idle on message_end for paused sessions', () => {
    const pausedSession: ChatSessionMeta = {
      id: 's4',
      desiredExecution: 'stopped',
      condition: 'idle',
      status: 'paused',
      pause_reason: 'manual',
      interaction_type: 'none',
      blocked_reason: 'user_paused',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(pausedSession);
    const dispatch = vi.fn();
    const options = createOptions({ dispatch });

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s4');
    });

    const source = MockEventSource.instances[0];
    dispatch.mockClear();

    act(() => {
      source.emit('message_end', JSON.stringify({ messageId: 'mid' }));
    });

    const dispatchedIdle = dispatch.mock.calls.some(
      (call) => call[0]?.type === 'session/setStatus' && call[0]?.payload === 'idle'
    );

    expect(dispatchedIdle).toBe(false);
    expect(client.getQueryData<ChatSessionMeta>(['ai-agent-session', 's4'])).toMatchObject({
      status: 'paused',
      pause_reason: 'manual',
      blocked_reason: 'user_paused',
    });
  });

  it('treats session.status as invalidation and never patches session or run truth', () => {
    const idleSession: ChatSessionMeta = {
      id: 's6',
      desiredExecution: 'running',
      condition: 'idle',
      status: 'idle',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(idleSession);
    const run: Run = {
      id: 'run-s6',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      sessionId: 's6',
      activeSessionId: 's6',
      plannerSessionId: null,
      executorSessionId: 's6',
      goal: 'status sync test',
      status: 'running',
      trigger: 'manual',
      startedAt: null,
      completedAt: null,
    };
    client.setQueryData<Run>(['run', 'run-s6'], run);
    client.setQueryData<Run[]>(['runs', {}], [run]);
    const options = createOptions();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s6');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('session.status', {
        id: 's6',
        status: 'paused',
        blocked_reason: 'user_paused',
        pause_reason: 'manual',
        interaction_type: 'none',
        previousStatus: 'running',
        version: 1,
        updatedAt: Date.now(),
      });
    });

    expect(client.getQueryData<ChatSessionMeta>(['ai-agent-session', 's6'])).toMatchObject({
      desiredExecution: 'running',
      condition: 'idle',
      status: 'idle',
      blocked_reason: null,
    });
    expect(client.getQueryData<ChatSessionMeta[]>(['ai-agent-sessions'])).toEqual([
      expect.objectContaining({ id: 's6', desiredExecution: 'running', condition: 'idle', status: 'idle' }),
    ]);
    expect(client.getQueryData<Run>(['run', 'run-s6'])).toMatchObject({
      status: 'running',
    });
    expect(client.getQueryData<Run[]>(['runs', {}])).toEqual([
      expect.objectContaining({ id: 'run-s6', status: 'running' }),
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 's6'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['ai-agent-sessions'] });
  });

  it('hydrates session detail cache from session.bootstrap events', () => {
    const idleSession: ChatSessionMeta = {
      id: 's7',
      desiredExecution: 'running',
      condition: 'idle',
      status: 'idle',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(idleSession);
    const options = createOptions();

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s7');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('session.bootstrap', {
        id: 's7',
        desiredExecution: 'running',
        condition: 'executing',
        status: 'running',
        version: 3,
        mode: 'automated',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'm-1',
            role: 'assistant',
            content: 'existing output',
            timestamp: Date.now(),
          },
        ],
        plan: [{ id: 'p-1', title: 'Bootstrap plan', status: 'running' }],
        artifacts: [{ id: 'a-1', originalName: 'report.md', filePath: 'sessions/s7/report.md', sizeBytes: 12, createdAt: Date.now() }],
        liveToolStreams: {
          shell: {
            name: 'shell',
            chunks: ['npm test'],
            status: 'running',
            command: 'npm test',
            lastUpdated: Date.now(),
          },
        },
        timeline: [
          {
            id: 'tool:shell',
            sessionId: 's7',
            ts: Date.now(),
            kind: 'tool',
            status: 'running',
            title: 'Running shell',
            source: 'system',
            importance: 'medium',
            replaceKey: 'tool:shell',
          },
        ],
      } satisfies Partial<ChatSessionSnapshot>);
    });

    expect(client.getQueryData<ChatSessionSnapshot>(['ai-agent-session', 's7'])).toMatchObject({
      id: 's7',
      status: 'running',
      version: 3,
      messages: [expect.objectContaining({ id: 'm-1', content: 'existing output' })],
      plan: [expect.objectContaining({ id: 'p-1', title: 'Bootstrap plan' })],
      artifacts: [expect.objectContaining({ id: 'a-1', originalName: 'report.md' })],
      liveToolStreams: {
        shell: expect.objectContaining({ command: 'npm test', chunks: ['npm test'] }),
      },
      timeline: [expect.objectContaining({ id: 'tool:shell', title: 'Running shell' })],
    });
  });

  it('patches session snapshot cache when live messages arrive after bootstrap', () => {
    const session: ChatSessionMeta = {
      id: 's8',
      desiredExecution: 'running',
      condition: 'executing',
      status: 'running',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(session);
    client.setQueryData<ChatSessionSnapshot>(['ai-agent-session', 's8'], {
      ...session,
      version: 4,
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          content: 'first',
          timestamp: Date.now(),
        },
      ],
    });
    const options = createOptions();

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s8');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('message', {
        id: 'm-2',
        role: 'assistant',
        content: 'second',
        timestamp: Date.now(),
      });
    });

    expect(client.getQueryData<ChatSessionSnapshot>(['ai-agent-session', 's8'])).toMatchObject({
      messages: [
        expect.objectContaining({ id: 'm-1', content: 'first' }),
        expect.objectContaining({ id: 'm-2', content: 'second' }),
      ],
    });
  });

  it('patches and replaces timeline entries in the session snapshot cache', () => {
    const session: ChatSessionMeta = {
      id: 's9',
      desiredExecution: 'running',
      condition: 'executing',
      status: 'running',
      blocked_reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { client, wrapper } = createClient(session);
    client.setQueryData<ChatSessionSnapshot>(['ai-agent-session', 's9'], {
      ...session,
      version: 5,
      timeline: [
        {
          id: 'tool:call-1',
          sessionId: 's9',
          ts: 100,
          kind: 'tool',
          status: 'running',
          title: 'Running shell',
          source: 'system',
          importance: 'medium',
          replaceKey: 'tool:call-1',
        },
      ],
    });
    const options = createOptions();

    const { result } = renderHook(() => useChatStreaming(options), { wrapper });

    act(() => {
      result.current.connectStream('s9');
    });

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('timeline_event', {
        id: 'tool:call-1',
        sessionId: 's9',
        ts: 200,
        kind: 'tool',
        status: 'success',
        title: 'Shell completed',
        source: 'system',
        importance: 'medium',
        replaceKey: 'tool:call-1',
      });
    });

    expect(client.getQueryData<ChatSessionSnapshot>(['ai-agent-session', 's9'])).toMatchObject({
      timeline: [expect.objectContaining({ id: 'tool:call-1', status: 'success', title: 'Shell completed', ts: 200 })],
    });
    expect(options.dispatchMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'activity/push' }),
      ]),
    );
  });
});
