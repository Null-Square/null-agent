import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentComposerTerminal from './AgentComposerTerminal';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import type { AIChatContextType } from '@/types/chat';

const mocks = vi.hoisted(() => ({
  activeScopeId: 'scope-1' as string | null,
  uploadScopeDocument: vi.fn(),
}));

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

vi.mock('@modules/chat/api', () => ({
  uploadScopeDocument: mocks.uploadScopeDocument,
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({
    activeScopeId: mocks.activeScopeId,
  }),
}));

const mockUseAIChat = vi.mocked(useAIChat);

const createChatState = (overrides: Partial<AIChatContextType> = {}): AIChatContextType => {
  return {
    messages: [],
    config: { usage: { tokensUsed: 10 } },
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

describe('AgentComposerTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeScopeId = 'scope-1';
    mocks.uploadScopeDocument.mockResolvedValue({
      document: {
        id: 'doc-1',
        scopeId: 'scope-1',
        kind: 'other',
        fileName: 'roe.md',
        mimeType: 'text/markdown',
        byteSize: 12,
        sha256: 'abc',
        parseStatus: 'parsed',
        parseError: null,
        textPreview: 'Rules',
        textTruncated: false,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    });
    mockUseAIChat.mockReturnValue(createChatState());
  });

  it('never shows a credits state or locks input on credits', () => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      config: { usage: { tokensUsed: 0 } },
    });

    render(<AgentComposerTerminal />);

    expect(screen.queryByText(/CREDITS/i)).toBeNull();
    const textarea = screen.getByPlaceholderText('Enter command or query...') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  it('allows sending a new message while user-paused', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      desiredExecution: 'stopped',
      condition: 'idle',
      sessionStatus: 'paused',
      pauseReason: 'manual',
      blockedReason: 'user_paused',
      sendPrompt,
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText(/SESSION STOPPED - YOU CAN SEND A MESSAGE/i)).toBeTruthy();
    const textarea = screen.getByPlaceholderText('Enter command or query...') as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(textarea.disabled).toBe(false);
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(textarea, { target: { value: 'continue with a fresh direction' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith('continue with a fresh direction');
    });
  });

  it('shows awaiting-user state without crashing', () => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      desiredExecution: 'running',
      condition: 'waiting_prerequisite',
      sessionStatus: 'paused',
      blockedReason: 'awaiting_user',
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText(/AWAITING USER INPUT/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect((screen.getByPlaceholderText('Enter command or query...') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('locks interactive input while the system recovers', () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      desiredExecution: 'running',
      condition: 'recovering',
      sessionStatus: 'paused',
      pauseReason: 'system',
      blockedReason: 'system_paused',
      sendPrompt,
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText(/RECOVERING AUTOMATICALLY/i)).toBeTruthy();
    expect((screen.getByPlaceholderText('Recovery is in progress. No action is required.') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /stop/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['approval', 'awaiting_approval', 'Complete the requested approval to continue.'],
    ['runner', 'runner_unavailable', 'Waiting for the compatible runner to reconnect.'],
  ] as const)('locks interactive input for a %s prerequisite', (pauseReason, blockedReason, placeholder) => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      desiredExecution: 'running',
      condition: pauseReason === 'approval' ? 'waiting_approval' : 'waiting_runner',
      sessionStatus: 'paused',
      pauseReason,
      blockedReason,
    });

    render(<AgentComposerTerminal />);

    expect((screen.getByPlaceholderText(placeholder) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks the composer when the run has been cancelled', () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      desiredExecution: 'stopped',
      condition: 'idle',
      runStatus: 'cancelled',
      sessionStatus: 'paused',
      pauseReason: 'manual',
      blockedReason: 'aborted_by_user',
      sendPrompt,
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText(/RUN CANCELLED - USE START TO CONTINUE THE SESSION/i)).toBeTruthy();
    expect(screen.queryByText(/SESSION PAUSED - YOU CAN SEND A MESSAGE/i)).toBeNull();
    const textarea = screen.getByPlaceholderText('Enter command or query...') as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('shows a read-only banner for automated run workbench sessions until manually paused', () => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      sessionMode: 'automated',
      runStatus: 'running',
      desiredExecution: 'running',
      condition: 'executing',
      sessionStatus: 'running',
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText(/RUN WORKBENCH IS READ-ONLY - STOP TO MESSAGE/i)).toBeTruthy();
    const textarea = screen.getByPlaceholderText('Stop the run manually before sending a message.') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('locks a read-only workbench composer even when the session is paused', () => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      readOnlySession: true,
      sessionMode: 'automated',
      runStatus: 'paused',
      desiredExecution: 'stopped',
      condition: 'idle',
      sessionStatus: 'paused',
      pauseReason: 'manual',
      blockedReason: 'user_paused',
    });

    render(<AgentComposerTerminal />);

    // The banner is gone: the disabled composer and its placeholder already
    // say this, and saying it twice in caps was the noise.
    expect(screen.queryByText(/WORKBENCH IS READ-ONLY/i)).toBeNull();
    const textarea = screen.getByPlaceholderText('This workbench is read-only.') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('suppresses pause affordances when the run is already complete', () => {
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      sessionMode: 'automated',
      runStatus: 'completed',
      sessionStatus: 'running',
      isLoading: true,
    });

    render(<AgentComposerTerminal />);

    expect(screen.queryByText(/RUN WORKBENCH IS READ-ONLY - PAUSE TO MESSAGE/i)).toBeNull();
    expect(screen.queryByText(/AGENT PROCESSING/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();

    const textarea = screen.getByPlaceholderText(
      'This run is finished. Open the session chat or start a new run to continue.',
    ) as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
  });

  it('sends a prompt on enter and clears the input', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      sendPrompt,
    });

    render(<AgentComposerTerminal />);

    const textarea = screen.getByPlaceholderText('Enter command or query...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '  run scan  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith('run scan');
    });
    expect(textarea.value).toBe('');
  });

  it('attaches a document from the clean composer and sends it with the prompt', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      sendPrompt,
    });

    const { container } = render(<AgentComposerTerminal variant="clean" />);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['Rules'], 'roe.md', { type: 'text/markdown' })],
      },
    });

    await waitFor(() => {
      expect(mocks.uploadScopeDocument).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        file: expect.objectContaining({ name: 'roe.md' }),
      });
    });
    expect(await screen.findByText('roe.md')).toBeInTheDocument();

    const textarea = screen.getByTestId('chat-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Use this for the RoE.' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('I attached "roe.md"'));
      expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('Use this for the RoE.'));
    });
  });

  it('shows pause control while agent is running and triggers pause', async () => {
    const abortTurn = vi.fn().mockResolvedValue(undefined);
    const sendPrompt = vi.fn();
    mockUseAIChat.mockReturnValue({
      ...createChatState(),
      isLoading: true,
      sessionStatus: 'running',
      abortTurn,
      sendPrompt,
    });

    render(<AgentComposerTerminal />);

    expect(screen.getByText('AGENT PROCESSING')).toBeTruthy();
    const pauseButton = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(pauseButton);

    await waitFor(() => {
      expect(abortTurn).toHaveBeenCalled();
    });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
