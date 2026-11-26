import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatStreamTerminal from './ChatStreamTerminal';
import { useAIChat } from '@modules/chat/model/AIChatContext';

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

vi.mock('@shared/lib/metrics', () => ({
  metrics: { trackRender: vi.fn() },
}));

vi.mock('@shared/ui/MermaidDiagram', () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => <div data-testid="chat-mermaid">{chart}</div>,
}));

const mockUseAIChat = vi.mocked(useAIChat);
type AIChatValue = ReturnType<typeof useAIChat>;

const createChatValue = (overrides: Partial<AIChatValue> = {}): AIChatValue =>
  ({
    messages: [],
    isLoading: false,
    timeline: [],
    activity: [],
    artifacts: [],
    readOnlySession: false,
    sessionStatus: 'idle',
    pauseReason: null,
    streamConnected: true,
    lastStreamActivityAt: undefined,
    lastStreamPingAt: undefined,
    plan: [],
    toolStreams: {},
    ...overrides,
  } as unknown as AIChatValue);

describe('ChatStreamTerminal', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.useRealTimers();
  });

  it('shows empty state when no messages or timeline entries exist', () => {
    mockUseAIChat.mockReturnValue(createChatValue());

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Live Agent Monitor')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the first agent message\./)).toBeInTheDocument();
  });

  it('renders user and assistant messages, filters duplicates, and ignores timeline entries', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    mockUseAIChat.mockReturnValue(
      createChatValue({
        isLoading: true,
        messages: [
          { id: 'u1', role: 'user', content: '', status: 'sending', timestamp: now },
          {
            id: 'u-internal',
            role: 'user',
            content: 'hidden kickoff',
            status: 'sent',
            timestamp: now,
            metadata: { visibility: 'internal' },
          },
          { id: 'a1', role: 'assistant', content: 'Hello', status: 'sent', timestamp: now },
          { id: 'a2', role: 'assistant', content: 'Hello', status: 'sent', timestamp: now },
        ],
        timeline: [
          {
            id: 't-1',
            sessionId: 'session-1',
            ts: now.getTime() - 1_000,
            kind: 'plan_ready',
            status: 'success',
            title: 'Plan ready',
            detail: '3 steps queued',
            source: 'system',
            importance: 'medium',
          },
        ],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('OPERATOR OVERRIDE')).toBeInTheDocument();
    expect(screen.getByText('NULL AI AGENT')).toBeInTheDocument();
    expect(screen.getByText('~ TRANSMITTING SYSTEM OVERRIDE')).toBeInTheDocument();
    expect(screen.getAllByText('Hello')).toHaveLength(1);
    expect(screen.queryByText('hidden kickoff')).toBeNull();
    expect(screen.queryByText('Plan ready')).toBeNull();
    expect(screen.queryByText('3 steps queued')).toBeNull();
  });

  it('can hide user messages for assistant-only stream views', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    mockUseAIChat.mockReturnValue(
      createChatValue({
        messages: [
          { id: 'u1', role: 'user', content: 'hello', status: 'sent', timestamp: now },
          { id: 'a1', role: 'assistant', content: 'world', status: 'sent', timestamp: now },
        ],
      }),
    );

    render(<ChatStreamTerminal showUserMessages={false} />);

    expect(screen.queryByText('OPERATOR OVERRIDE')).toBeNull();
    expect(screen.getByText('NULL AI AGENT')).toBeInTheDocument();
    expect(screen.getByText('world')).toBeInTheDocument();
  });

  it('renders persisted phase timeline without exposing artifacts', () => {
    const now = new Date('2025-01-01T00:00:00Z').getTime();
    mockUseAIChat.mockReturnValue(
      createChatValue({
        readOnlySession: true,
        messages: [],
        activity: [
          {
            id: 't-1',
            sessionId: 'session-1',
            ts: now,
            kind: 'tool',
            status: 'success',
            title: 'Shell command completed',
            detail: 'nuclei scan completed',
            source: 'system',
            importance: 'medium',
          },
        ],
        artifacts: [
          {
            id: 'artifact-1',
            originalName: 'raw-internal.json',
            filePath: '.artifacts/raw-internal.json',
            sizeBytes: 120,
            createdAt: now,
          },
        ],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Phase History')).toBeInTheDocument();
    expect(screen.getByText('Shell command completed')).toBeInTheDocument();
    expect(screen.getByText('nuclei scan completed')).toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).toBeNull();
    expect(screen.queryByText('raw-internal.json')).toBeNull();
    expect(screen.queryByText('.artifacts/raw-internal.json')).toBeNull();
  });

  it('renders system alert messages', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        messages: [
          { id: 's1', role: 'system', content: 'Boom', status: 'sent', timestamp: new Date() },
        ],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText(/SYSTEM ALERT/)).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('shows the empty state instead of heartbeat cards when no visible messages exist', () => {
    const now = Date.now();
    mockUseAIChat.mockReturnValue(
      createChatValue({
        sessionStatus: 'running',
        streamConnected: true,
        lastStreamActivityAt: now - 13_000,
        lastStreamPingAt: now - 5_000,
        plan: [{ id: 'step-1', title: 'Testing login flow', status: 'running' }],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Live Agent Monitor')).toBeInTheDocument();
    expect(screen.queryByText('Still working')).toBeNull();
  });

  it('does not render connection issue cards inline in the chat stream', () => {
    const now = Date.now();
    mockUseAIChat.mockReturnValue(
      createChatValue({
        sessionStatus: 'running',
        streamConnected: false,
        lastStreamActivityAt: now - 13_000,
        lastStreamPingAt: now - 31_000,
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Live Agent Monitor')).toBeInTheDocument();
    expect(screen.queryByText('Connection issue')).toBeNull();
  });

  it('shows System Active indicator when isLoading is true', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        isLoading: true,
        messages: [{ id: 'a1', role: 'assistant', content: 'Working...', status: 'sent', timestamp: new Date() }],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('System Active')).toBeInTheDocument();
  });

  it('shows System Active indicator in empty state when isLoading is true', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        isLoading: true,
        messages: [],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Live Agent Monitor')).toBeInTheDocument();
    expect(screen.getByText('System Active')).toBeInTheDocument();
  });

  it('shows System Active indicator for running workbench sessions even when loading is false', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        sessionStatus: 'running',
        messages: [{ id: 'a1', role: 'assistant', content: 'Working...', status: 'sent', timestamp: new Date() }],
        toolStreams: {
          request_tool: {
            name: 'request_tool',
            chunks: ['POST /graphql AdminReviewQueue'],
            status: 'running',
            lastUpdated: Date.now(),
          },
        },
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('System Active')).toBeInTheDocument();
  });

  it('does not show a paused terminal banner when session status is running but run status is stale paused', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        sessionStatus: 'running',
        runStatus: 'paused',
        pauseReason: 'system',
        messages: [{ id: 'a1', role: 'assistant', content: 'Continuing enumeration', status: 'sent', timestamp: new Date() }],
        toolStreams: {
          shell_run: {
            name: 'shell_run',
            chunks: ['httpx running'],
            status: 'running',
            lastUpdated: Date.now(),
          },
        },
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.queryByText('System Paused')).toBeNull();
    expect(screen.getByText('System Active')).toBeInTheDocument();
  });

  it('does not show a manual-resume pause banner for read-only historical phase sessions', () => {
    mockUseAIChat.mockReturnValue(
      createChatValue({
        readOnlySession: true,
        sessionStatus: 'paused',
        pauseReason: 'system',
        runStatus: 'paused',
        messages: [{ id: 'a1', role: 'assistant', content: 'Historical recon transcript', status: 'sent', timestamp: new Date() }],
      }),
    );

    render(<ChatStreamTerminal />);

    expect(screen.getByText('Historical recon transcript')).toBeInTheDocument();
    expect(screen.queryByText('System Paused')).toBeNull();
    expect(screen.queryByText(/Awaiting manual resume/i)).toBeNull();
  });

  it('renders clean assistant messages as Markdown with tables and Mermaid diagrams', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    mockUseAIChat.mockReturnValue(
      createChatValue({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: [
              '## Scope Summary',
              '',
              '| Asset | Priority |',
              '| --- | --- |',
              '| api.example.test | High |',
              '',
              '```mermaid',
              'graph TD;',
              'A-->B;',
              '```',
            ].join('\n'),
            status: 'sent',
            timestamp: now,
          },
        ],
      }),
    );

    render(<ChatStreamTerminal variant="clean" />);

    expect(screen.getByRole('heading', { name: 'Scope Summary' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('api.example.test')).toBeInTheDocument();
    expect(screen.getByTestId('chat-mermaid')).toHaveTextContent('graph TD;');
  });

  it('renders fenced code blocks as ordinary Markdown code', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    mockUseAIChat.mockReturnValue(
      createChatValue({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '```json\n{"findingCount":1}\n```',
            status: 'sent',
            timestamp: now,
          },
        ],
      }),
    );

    render(<ChatStreamTerminal variant="clean" />);

    expect(screen.getByText('{"findingCount":1}')).toBeInTheDocument();
  });
});
