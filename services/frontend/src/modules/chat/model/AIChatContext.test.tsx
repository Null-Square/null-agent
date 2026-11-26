import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AIChatProvider from './AIChatContext';

const mocks = vi.hoisted(() => ({
  queryClient: {
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  },
  refetchSession: vi.fn(),
  disconnectStream: vi.fn(),
  resetCoalescers: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => mocks.queryClient,
  };
});

vi.mock('@modules/sessions', () => ({
  useSessionsQuery: vi.fn(() => ({})),
  useSessionDetailsQuery: vi.fn(() => ({
    data: undefined,
    refetch: mocks.refetchSession,
  })),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({ activeScopeId: null }),
}));

vi.mock('@shared/hooks/useNotifier', () => ({
  useNotifier: () => ({ error: vi.fn() }),
}));

vi.mock('@modules/chat/hooks/useToast', () => ({
  useToast: () => ({ toastMessage: undefined, pushToast: vi.fn(), clearToast: vi.fn() }),
}));

vi.mock('@modules/chat/hooks/useChatStreaming', () => ({
  useChatStreaming: () => ({
    connectStream: vi.fn(),
    disconnectStream: mocks.disconnectStream,
    assistantMessageRef: { current: null },
    pendingUserMessagesRef: { current: [] },
  }),
}));

vi.mock('@modules/chat/hooks/useStreamCoalescer', () => ({
  useStreamCoalescer: () => ({
    tokenCoalescer: {},
    toolCoalescer: {},
    flushCoalescedUpdates: vi.fn(),
    resetCoalescers: mocks.resetCoalescers,
  }),
}));

vi.mock('@modules/chat/hooks/useSessionLifecycle', () => ({
  useSessionLifecycle: () => ({
    sendPrompt: vi.fn(),
    abortTurn: vi.fn(),
    clearMessages: vi.fn(),
  }),
}));

vi.mock('@modules/chat/hooks/useDerivedSessionTitle', () => ({
  useDerivedSessionTitle: vi.fn(),
}));

vi.mock('@modules/chat/hooks/useStarterPrompt', () => ({
  useStarterPrompt: vi.fn(),
}));

vi.mock('@shared/api', () => ({
  authenticatedFetch: vi.fn(),
}));

describe('AIChatProvider cache lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refetchSession.mockResolvedValue({
      data: undefined,
      status: 'success',
      fetchStatus: 'idle',
      error: null,
    });
  });

  it('keeps session detail cache when only session list sync is disabled', () => {
    const view = render(
      <AIChatProvider sessionId="session-1" syncSessionList={false}>
        <div />
      </AIChatProvider>,
    );

    view.unmount();

    expect(mocks.queryClient.removeQueries).not.toHaveBeenCalledWith({
      queryKey: ['ai-agent-session', 'session-1'],
    });
    expect(mocks.queryClient.setQueryData).toHaveBeenCalledWith(['ai-agent-sessions'], expect.any(Function));
  });
});
