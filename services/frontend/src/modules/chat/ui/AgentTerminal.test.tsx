import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentTerminal from './AgentTerminal';
import { useAIChat } from '@modules/chat/model/AIChatContext';

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

// Mock shared components that might still be imported or were used
// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

const mockUseAIChat = vi.mocked(useAIChat);
type AIChatValue = ReturnType<typeof useAIChat>;

describe('AgentTerminal', () => {
  it('shows placeholder when no session is active', () => {
    mockUseAIChat.mockReturnValue({
      toolStreams: {},
      sessionId: '',
      condition: 'idle',
      sessionStatus: 'idle',
      activity: [],
      artifacts: [],
      readOnlySession: false,
    } as unknown as AIChatValue);

    render(<AgentTerminal />);

    const terminal = screen.getByTestId('terminal');

    expect(terminal).toHaveClass('w-full', 'min-w-0', 'flex-1');
    expect(screen.getByText(/no active session/i)).toBeInTheDocument();
  });

  it('renders command output and maps the executing condition', () => {
    mockUseAIChat.mockReturnValue({
      toolStreams: {
        shell_run: {
          name: 'shell_run',
          chunks: ['line-1\nline-2'],
          status: 'running',
          command: 'ls -la',
          lastUpdated: Date.now(),
        },
      },
      sessionId: 'session-1234',
      condition: 'executing',
      sessionStatus: 'running',
      activity: [],
      artifacts: [],
      readOnlySession: false,
    } as unknown as AIChatValue);

    render(<AgentTerminal />);

    expect(screen.getByText('ls -la')).toBeInTheDocument();
    expect(screen.getByText('line-1')).toBeInTheDocument();
    expect(screen.getByText('line-2')).toBeInTheDocument();
    expect(screen.getByText(/Receiving stream/i)).toBeInTheDocument();
    expect(screen.getByTestId('terminal').dataset.status).toBe('EXECUTING');
  });

  it('renders ansi color segments for error lines', () => {
    mockUseAIChat.mockReturnValue({
      toolStreams: {
        shell_run: {
          name: 'shell_run',
          chunks: ['[error]\u001b[31mboom\u001b[0m'],
          status: 'error',
          lastUpdated: Date.now(),
        },
      },
      sessionId: 'session-err',
      condition: 'idle',
      sessionStatus: 'failed',
      activity: [],
      artifacts: [],
      readOnlySession: false,
    } as unknown as AIChatValue);

    const { container } = render(<AgentTerminal />);

    expect(screen.getByTestId('terminal').dataset.status).toBe('IDLE');
    expect(container.querySelector('.ansi-red')).not.toBeNull();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders persisted timeline without exposing artifacts for read-only phase sessions', () => {
    const now = new Date('2026-04-02T10:00:00Z').getTime();
    mockUseAIChat.mockReturnValue({
      toolStreams: {},
      sessionId: 'session-history',
      condition: 'completed',
      sessionStatus: 'completed',
      readOnlySession: true,
      activity: [
        {
          id: 'timeline-1',
          sessionId: 'session-history',
          ts: now,
          kind: 'tool',
          status: 'success',
          title: 'HTTP sitemap captured',
          detail: '12 URLs found',
          source: 'system',
          importance: 'medium',
        },
      ],
      artifacts: [
        {
          id: 'artifact-1',
          originalName: 'sitemap.json',
          filePath: '.artifacts/sitemap.json',
          sizeBytes: 100,
          createdAt: now,
        },
      ],
    } as unknown as AIChatValue);

    render(<AgentTerminal />);

    expect(screen.getByText('phase_history')).toBeInTheDocument();
    expect(screen.getByText(/HTTP sitemap captured/)).toBeInTheDocument();
    expect(screen.getByText(/12 URLs found/)).toBeInTheDocument();
    expect(screen.queryByText(/sitemap\.json -> \.artifacts\/sitemap\.json/)).toBeNull();
    expect(screen.queryByText('sitemap.json')).toBeNull();
  });
});
