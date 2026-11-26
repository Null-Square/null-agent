import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AIChatConfig } from '@/types/chat';
import ChatRoute from './ChatRoute';
import { useSessionDetailsQuery } from '@modules/sessions';
import { useAIChatContext } from '@modules/chat/model/AIChatContext';

const mockUseSessionDetailsQuery = vi.mocked(useSessionDetailsQuery);

const mockUseAIChatContext = vi.mocked(useAIChatContext);
let lastConfig: AIChatConfig | undefined;
type AIChatContextValue = ReturnType<typeof useAIChatContext>;

vi.mock('@modules/chat/model/AIChatContext', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useAIChatContext: vi.fn(),
}));

vi.mock('@modules/chat', () => ({
  AIChat: ({ config }: { config?: AIChatConfig }) => {
    lastConfig = config;
    return <div data-testid="ai-chat" />;
  },
}));

vi.mock('@modules/sessions', () => ({
  useSessionDetailsQuery: vi.fn(),
}));

describe('ChatRoute', () => {
  beforeEach(() => {
    lastConfig = undefined;
    mockUseAIChatContext.mockReturnValue({
      sessionId: '',
      actions: { clearMessages: vi.fn().mockResolvedValue('session-1') },
    } as unknown as AIChatContextValue);
    mockUseSessionDetailsQuery.mockReturnValue({
      data: { usage: { lastTurnInputTokens: 10, contextWindow: 200 } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSessionDetailsQuery>);
  });

  it('never shows a credits gate over the chat', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByText(/credits exhausted/i)).toBeNull();
  });

  it('clears messages for new sessions and passes context usage, not credits, to AIChat', async () => {
    const clearMessages = vi.fn().mockResolvedValue('session-123');
    mockUseAIChatContext.mockReturnValue({
      sessionId: '',
      actions: { clearMessages },
    } as unknown as AIChatContextValue);
    mockUseSessionDetailsQuery.mockReturnValue({
      data: { usage: { lastTurnInputTokens: 50, contextWindow: 200 } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSessionDetailsQuery>);

    render(
      <MemoryRouter initialEntries={['/chat?new=1']}>
        <Routes>
          <Route path="/chat" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(clearMessages).toHaveBeenCalled();
    });

    expect(lastConfig?.usage).toEqual({
      tokensUsed: 50,
      contextWindow: 200,
      contextRemaining: 150,
    });
  });

  /* Same change: the route signals the shared boot screen instead of drawing
     yellow mono reading "Initializing chat interface…". */
  it('renders no chat content when the chat context is missing', () => {
    mockUseAIChatContext.mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByText(/Initializing chat interface/i)).toBeNull();
    expect(screen.queryByTestId('ai-chat')).toBeNull();
  });
});
