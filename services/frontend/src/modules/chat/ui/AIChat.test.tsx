import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import AIChat from './AIChat';
import { useAIChat } from '@modules/chat/model/AIChatContext';

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

vi.mock('./HeroWave', () => ({
  HeroWave: ({ title }: { title: string }) => <div data-testid="hero">{title}</div>,
}));

vi.mock('./ConversationViewNullSquare', () => ({
  default: ({ config }: { config: { title?: string } }) => (
    <div data-testid="conversation">{config?.title}</div>
  ),
}));

const mockUseAIChat = vi.mocked(useAIChat);
type AIChatValue = ReturnType<typeof useAIChat>;

describe('AIChat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('shows hero view by default', () => {
    mockUseAIChat.mockReturnValue({
      messages: [],
      config: { title: 'Context Title' },
      sessionId: '',
      task: undefined,
      sessionMode: 'interactive',
    } as unknown as AIChatValue);

    render(<AIChat />);

    expect(screen.getByTestId('hero')).toHaveTextContent('Context Title');
    expect(screen.queryByTestId('conversation')).toBeNull();
  });

  it('transitions to conversation when a session starts', () => {
    vi.useFakeTimers();
    mockUseAIChat.mockReturnValue({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: new Date() }],
      config: { title: 'Context Title' },
      sessionId: 'session-1',
      task: undefined,
      sessionMode: 'interactive',
    } as unknown as AIChatValue);

    render(<AIChat config={{ title: 'Override Title' }} />);

    expect(screen.getByTestId('hero')).toBeInTheDocument();
    expect(screen.getByTestId('conversation')).toHaveTextContent('Override Title');

    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(screen.queryByTestId('hero')).toBeNull();
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
  });

  it('stays on hero in automated mode', () => {
    mockUseAIChat.mockReturnValue({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: new Date() }],
      config: { title: 'Context Title' },
      sessionId: 'session-1',
      task: { id: 'task-1' },
      sessionMode: 'automated',
    } as unknown as AIChatValue);

    render(<AIChat />);

    expect(screen.getByTestId('hero')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation')).toBeNull();
  });
});
