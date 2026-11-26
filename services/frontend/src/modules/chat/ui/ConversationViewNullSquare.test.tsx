import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConversationViewNullSquare from './ConversationViewNullSquare';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import type { AIChatContextType } from '@/types/chat';

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

vi.mock('@modules/chat', () => ({
  ChatStreamTerminal: () => <div data-testid="chat-stream" />,
  CollapsiblePlanPanel: () => <div data-testid="plan-panel" />,
  AgentComposerTerminal: () => <div data-testid="composer" />,
  AgentTerminal: () => <div data-testid="agent-terminal" />,
  Toast: () => <div data-testid="toast" />,
}));

vi.mock('@modules/sessions', () => ({
  SessionActionButtons: () => <div data-testid="session-actions" />,
  useSessionActions: () => ({
    stopSession: vi.fn().mockResolvedValue({ success: true }),
    startSession: vi.fn().mockResolvedValue({ success: true }),
    isStopping: false,
    isStarting: false,
  }),
}));

const mockUseAIChat = vi.mocked(useAIChat);

const createChatState = (overrides: Partial<AIChatContextType> = {}): AIChatContextType => {
  return {
    messages: [],
    config: {},
    isLoading: false,
    sessionId: 'session-1',
    sessionMode: 'interactive',
    sessionStatus: 'idle',
    desiredExecution: 'running',
    condition: 'idle',
    pauseReason: null,
    interactionType: 'none',
    blockedReason: null,
    isAborting: false,
    sandboxPolicy: {
      profile: 'sandbox',
      privileged: false,
      capDrop: [],
      capAdd: [],
      readonlyRootfs: true,
      network: 'bridge',
      seccomp: null,
    },
    plan: [],
    toolStreams: {},
    timeline: [],
    activity: [],
    task: undefined,
    addMessage: vi.fn().mockReturnValue(''),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    approvePendingAction: vi.fn().mockResolvedValue(undefined),
    denyPendingAction: vi.fn().mockResolvedValue(undefined),
    abortTurn: vi.fn().mockResolvedValue(undefined),
    clearMessages: vi.fn().mockResolvedValue(''),
    toastMessage: undefined,
    clearToast: vi.fn(),
    ...overrides,
  };
};

describe('ConversationViewNullSquare', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    mockUseAIChat.mockReturnValue(createChatState());
  });

  it('renders ops panel empty state and context usage', () => {
    render(
      <ConversationViewNullSquare
        config={{ title: 'Task', usage: { contextWindow: 100, tokensUsed: 50 } }}
      />,
    );

    expect(screen.getByText('No Execution Plan')).toBeInTheDocument();
    expect(screen.getByText('CTX')).toBeInTheDocument();
    expect(screen.getByText('sandbox')).toBeInTheDocument();
  });

  it('shows private-runner execution provenance in the workbench header', () => {
    mockUseAIChat.mockReturnValue(
      createChatState({
        executionTarget: 'scope_runner',
        runnerName: 'Private Runner',
      }),
    );

    render(<ConversationViewNullSquare />);

    expect(screen.getByTitle('Private Runner Origin: Private Runner')).toBeInTheDocument();
    expect(screen.getByText('Private Runner')).toBeInTheDocument();
  });

  it('uses the shared recovery presentation in the workbench header', () => {
    mockUseAIChat.mockReturnValue(
      createChatState({
        desiredExecution: 'running',
        condition: 'recovering',
        sessionStatus: 'paused',
        pauseReason: 'system',
        blockedReason: 'system_paused',
      }),
    );

    render(<ConversationViewNullSquare />);

    expect(screen.getByTitle('RECOVERING')).toBeInTheDocument();
    expect(screen.queryByText('Read-only')).toBeNull();
  });

  it('uses the shared approval presentation in the workbench header', () => {
    mockUseAIChat.mockReturnValue(
      createChatState({
        desiredExecution: 'running',
        condition: 'waiting_approval',
        sessionStatus: 'paused',
        pauseReason: 'approval',
        blockedReason: 'awaiting_approval',
      }),
    );

    render(<ConversationViewNullSquare />);

    expect(screen.getByTitle('WAITING FOR APPROVAL')).toBeInTheDocument();
  });

  it('hides execution controls when the owning run is terminal', () => {
    mockUseAIChat.mockReturnValue(
      createChatState({
        runStatus: 'completed',
        sessionStatus: 'paused',
        desiredExecution: 'stopped',
      }),
    );

    render(<ConversationViewNullSquare />);

    expect(screen.queryByTestId('session-actions')).toBeNull();
  });

});
