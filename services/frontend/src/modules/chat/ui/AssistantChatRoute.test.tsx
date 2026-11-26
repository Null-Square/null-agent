import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  useAssistantChatSessionsQuery,
  useCreateScopedChatSessionMutation,
  useDeleteAssistantChatSessionMutation,
  useRenameAssistantChatSessionMutation,
  useSetupReadinessQuery,
} from '@modules/chat/api';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { useSessionDetailsQuery } from '@modules/sessions';
import { useScope } from '@shared/contexts/ScopeContext';
import AssistantChatRoute from './AssistantChatRoute';

const assistantRouteUiMocks = vi.hoisted(() => ({
  ChatStreamTerminal: vi.fn((_props: Record<string, unknown>) => <div data-testid="assistant-stream" />),
}));

const mockUseScope = vi.mocked(useScope);
const mockUseCreateScopedChatSessionMutation = vi.mocked(useCreateScopedChatSessionMutation);
const mockUseAssistantChatSessionsQuery = vi.mocked(useAssistantChatSessionsQuery);
const mockUseRenameAssistantChatSessionMutation = vi.mocked(useRenameAssistantChatSessionMutation);
const mockUseDeleteAssistantChatSessionMutation = vi.mocked(useDeleteAssistantChatSessionMutation);
const mockUseSetupReadinessQuery = vi.mocked(useSetupReadinessQuery);
const mockUseSessionDetailsQuery = vi.mocked(useSessionDetailsQuery);
const mockUseAIChat = vi.mocked(useAIChat);

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: vi.fn(),
}));

vi.mock('@modules/chat/api', () => ({
  useCreateScopedChatSessionMutation: vi.fn(),
  useAssistantChatSessionsQuery: vi.fn(),
  useRenameAssistantChatSessionMutation: vi.fn(),
  useDeleteAssistantChatSessionMutation: vi.fn(),
  useSetupReadinessQuery: vi.fn(),
}));

vi.mock('@modules/sessions', () => ({
  useSessionDetailsQuery: vi.fn(),
}));

vi.mock('@modules/chat/model/AIChatContext', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
  useAIChat: vi.fn(),
}));

vi.mock('@modules/chat', () => ({
  AgentComposerTerminal: () => <div data-testid="assistant-composer" />,
  ChatStreamTerminal: assistantRouteUiMocks.ChatStreamTerminal,
  GateBanner: () => <div data-testid="assistant-gate-banner" />,
  Toast: ({ message }: { message: string }) => <div>{message}</div>,
}));

// The landing this file used to cover is gone: conversations start in the
// assistant panel, and this route renders a conversation. Its tests went with
// it rather than being kept green against nothing.
describe('AssistantChatRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assistantRouteUiMocks.ChatStreamTerminal.mockClear();
    mockUseScope.mockReturnValue({
      activeScopeId: 'scope-1',
      setActiveScopeId: vi.fn(),
      scopes: [
        {
          id: 'scope-1',
          name: 'Prod Scope',
          description: null,
          status: 'active',
        },
      ],
      isLoading: false,
    });
    mockUseAssistantChatSessionsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAssistantChatSessionsQuery>);
    mockUseSetupReadinessQuery.mockReturnValue({
      data: { counts: { targetCount: 1, verifiedTargetCount: 1 } },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useSetupReadinessQuery>);
    mockUseRenameAssistantChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
    } as unknown as ReturnType<typeof useRenameAssistantChatSessionMutation>);
    mockUseDeleteAssistantChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
    } as unknown as ReturnType<typeof useDeleteAssistantChatSessionMutation>);
    mockUseSessionDetailsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSessionDetailsQuery>);
    mockUseAIChat.mockReturnValue({
      sessionId: 'session-1',
      sessionStatus: 'idle',
      isLoading: false,
      toastMessage: undefined,
      clearToast: vi.fn(),
      config: {},
      approvePendingAction: vi.fn().mockResolvedValue(undefined),
      denyPendingAction: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useAIChat>);
  });

  it('reuses the same bootstrap request across remounts when entering with a prompt', async () => {
    let resolveRequest: ((value: { sessionId: string }) => void) | undefined;
    const mutateAsync = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync,
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);

    const firstRender = render(
      <MemoryRouter initialEntries={['/chat?prompt=Summarize%20the%20latest%20run&model=gpt-5.4']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);

    firstRender.unmount();

    render(
      <MemoryRouter initialEntries={['/chat?prompt=Summarize%20the%20latest%20run&model=gpt-5.4']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);

    resolveRequest?.({ sessionId: 'session-1' });

    await waitFor(() => {
      expect(screen.getByTestId('assistant-stream')).toBeInTheDocument();
      expect(screen.getByTestId('assistant-composer')).toBeInTheDocument();
    });
  });

  it('does not render the top header label or new chat button in an active session', async () => {
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);

    render(
      <MemoryRouter initialEntries={['/chat?session=history-2']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('assistant-stream')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /new chat/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/security assistant/i)).not.toBeInTheDocument();
  });

  it('shows an approval panel for pending setup changes', async () => {
    const approvePendingAction = vi.fn().mockResolvedValue(undefined);
    const denyPendingAction = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      sessionId: 'session-1',
      sessionStatus: 'paused',
      pauseReason: 'approval',
      isLoading: false,
      toastMessage: undefined,
      clearToast: vi.fn(),
      config: {},
      pendingApproval: {
        actionId: 'approval-1',
        tool: 'update_scope_brief',
        args: {
          impactTolerance: 'non_destructive',
        },
        reason: 'Tool update_scope_brief requires approval by policy pattern "update_scope_brief".',
      },
      approvePendingAction,
      denyPendingAction,
    } as unknown as ReturnType<typeof useAIChat>);
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);

    render(
      <MemoryRouter initialEntries={['/chat?session=history-2']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Approval Required')).toBeInTheDocument();
    });
    expect(screen.getByText('Update scope brief')).toBeInTheDocument();
    expect(screen.getByText(/non_destructive/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(approvePendingAction).toHaveBeenCalledWith('approval-1');
    });
  });

  it('renders the assistant chat stream with the standard markdown renderer', async () => {
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);

    render(
      <MemoryRouter initialEntries={['/chat?session=history-2']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('assistant-stream')).toBeInTheDocument();
    });

    expect(assistantRouteUiMocks.ChatStreamTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'clean',
      }),
      undefined,
    );
    const streamProps = assistantRouteUiMocks.ChatStreamTerminal.mock.calls.at(-1)?.[0] ?? {};
    expect(Object.keys(streamProps)).not.toContain(['assistant', 'Render', 'Mode'].join(''));
  });

  it('blocks the composer and offers verification when the scope target is unverified', async () => {
    const mutateAsync = vi.fn();
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync,
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);
    mockUseSetupReadinessQuery.mockReturnValue({
      data: { counts: { targetCount: 1, verifiedTargetCount: 0 } },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useSetupReadinessQuery>);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Verify target ownership')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /verify target/i })).toHaveAttribute('href', '/setup');
    expect(
      screen.queryByPlaceholderText(/ask a question or enter an operational directive/i),
    ).not.toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('asks for a target first when the scope has none', async () => {
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);
    mockUseSetupReadinessQuery.mockReturnValue({
      data: { counts: { targetCount: 0, verifiedTargetCount: 0 } },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useSetupReadinessQuery>);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Add a target to this scope')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add target/i })).toHaveAttribute('href', '/setup');
  });

  it('does not bootstrap a queued hero prompt while the scope target is unverified', async () => {
    const mutateAsync = vi.fn();
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync,
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);
    mockUseSetupReadinessQuery.mockReturnValue({
      data: { counts: { targetCount: 1, verifiedTargetCount: 0 } },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useSetupReadinessQuery>);

    render(
      <MemoryRouter initialEntries={['/chat?prompt=Summarize%20the%20latest%20run']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('Verify target ownership')).toBeInTheDocument();
  });

  it('closes an open session view when the scope loses its verified target', async () => {
    mockUseCreateScopedChatSessionMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useCreateScopedChatSessionMutation>);
    mockUseSetupReadinessQuery.mockReturnValue({
      data: { counts: { targetCount: 1, verifiedTargetCount: 0 } },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useSetupReadinessQuery>);

    render(
      <MemoryRouter initialEntries={['/chat?session=history-2']}>
        <Routes>
          <Route path="/chat" element={<AssistantChatRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Verify target ownership')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('assistant-composer')).not.toBeInTheDocument();
  });

});
