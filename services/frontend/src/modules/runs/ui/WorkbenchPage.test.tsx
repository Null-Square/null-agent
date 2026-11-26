import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkbenchPage from './WorkbenchPage';
import type { RunPhaseSessionEntry } from '@/modules/security-ops/types';

const mockSetSearchParams = vi.fn();
const mockChatPage = vi.fn();
let searchParamsValue = '';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'run-1' }),
  useSearchParams: () => [new URLSearchParams(searchParamsValue), mockSetSearchParams],
}));

vi.mock('@/modules/security-ops/api', () => ({
  useRunActivityQuery: vi.fn(),
  useRunDetailQuery: vi.fn(),
  useRunPhasesQuery: vi.fn(),
}));

vi.mock('@modules/sessions', () => ({
  useSessionDetailsQuery: vi.fn(),
}));

vi.mock('@modules/chat', () => ({
  AIChat: () => <div data-testid="ai-chat" />,
  ChatPage: (props: {
    sessionId?: string;
    runStatus?: string | null;
    workbenchHeaderSlot?: React.ReactNode;
    readOnlySession?: boolean;
    syncSessionList?: boolean;
  }) => {
    mockChatPage(props);
    return (
      <div>
        <div data-testid="chat-session">{props.sessionId}</div>
        {props.workbenchHeaderSlot}
      </div>
    );
  },
}));

vi.mock('@modules/chat/model/AIChatContext', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@shared/lib/workbenchDebug', () => ({
  logWorkbenchDebug: vi.fn(),
  summarizeSessionSnapshot: vi.fn(() => ({ status: 'idle' })),
}));

const securityOpsApi = await import('@/modules/security-ops/api');
const sessionsApi = await import('@modules/sessions');

const run = {
  id: 'run-1',
  status: 'running',
  goal: 'Assess API auth flow',
  trigger: 'manual',
  sessionId: 'session-enumeration',
  activeSessionId: 'session-enumeration',
  executorSessionId: 'session-enumeration',
  plannerSessionId: 'session-planner',
};

const phases: RunPhaseSessionEntry[] = [
  {
    id: 'phase-recon',
    phase: 'recon',
    label: 'Recon',
    ordinal: 1,
    status: 'completed',
    rawStatus: 'completed',
    sessionId: 'session-recon',
    startedAt: '2026-04-02T10:00:00.000Z',
    completedAt: '2026-04-02T10:05:00.000Z',
    durationMs: 300000,
  },
  {
    id: 'phase-enumeration',
    phase: 'enumeration',
    label: 'Enumeration',
    ordinal: 2,
    status: 'running',
    rawStatus: 'active',
    sessionId: 'session-enumeration',
    startedAt: '2026-04-02T10:06:00.000Z',
    completedAt: null,
    durationMs: null,
  },
  {
    id: 'phase-validation',
    phase: 'validation',
    label: 'Validation',
    ordinal: 3,
    status: 'pending',
    rawStatus: 'pending',
    sessionId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  },
];

describe('WorkbenchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsValue = '';
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: run,
      isLoading: false,
    } as never);
    vi.mocked(securityOpsApi.useRunPhasesQuery).mockReturnValue({
      data: phases,
      isLoading: false,
    } as never);
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: null,
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: { id: 'session-enumeration', status: 'running' },
      isLoading: false,
    } as never);
  });

  it('defaults to the active phase session and writes it to the URL', async () => {
    render(<WorkbenchPage />);

    expect(screen.getByTestId('chat-session')).toHaveTextContent('session-enumeration');
    expect(mockChatPage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ readOnlySession: false, syncSessionList: false }),
    );

    await waitFor(() => {
      expect(mockSetSearchParams).toHaveBeenCalledWith(expect.any(URLSearchParams), { replace: true });
    });
    const nextParams = mockSetSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(nextParams.get('session')).toBe('session-enumeration');
  });

  it('preserves a valid phase session from the URL', () => {
    searchParamsValue = 'session=session-recon';

    render(<WorkbenchPage />);

    expect(screen.getByTestId('chat-session')).toHaveTextContent('session-recon');
    expect(mockChatPage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ readOnlySession: true, syncSessionList: false }),
    );
    expect(mockSetSearchParams).not.toHaveBeenCalled();
  });

  it('offers to redirect from a stale phase session to the active replacement', () => {
    searchParamsValue = 'session=session-enumeration-stale';
    vi.mocked(securityOpsApi.useRunPhasesQuery).mockReturnValue({
      data: [
        phases[0]!,
        {
          ...phases[1]!,
          id: 'phase-enumeration-stale',
          status: 'failed',
          rawStatus: 'failed',
          sessionId: 'session-enumeration-stale',
          completedAt: '2026-04-02T10:07:00.000Z',
        },
        phases[1]!,
      ],
      isLoading: false,
    } as never);

    render(<WorkbenchPage />);

    expect(screen.getByText(/phase session is stale/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open active/i }));

    expect(mockSetSearchParams).toHaveBeenCalledTimes(1);
    const nextParams = mockSetSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(nextParams.get('session')).toBe('session-enumeration');
  });

  it('changes the selected transcript when a phase is selected', () => {
    searchParamsValue = 'session=session-enumeration';

    render(<WorkbenchPage />);

    fireEvent.click(screen.getByRole('button', { name: /open recon phase/i }));

    expect(mockSetSearchParams).toHaveBeenCalledTimes(1);
    const nextParams = mockSetSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(nextParams.get('session')).toBe('session-recon');
  });

  it('falls back to activity phases when transcript session links are unavailable', () => {
    vi.mocked(securityOpsApi.useRunPhasesQuery).mockReturnValue({
      data: [],
      isLoading: false,
    } as never);
    vi.mocked(securityOpsApi.useRunActivityQuery).mockReturnValue({
      data: {
        phases: [
          {
            phase: 'recon',
            label: 'Recon',
            ordinal: 1,
            status: 'completed',
            startedAt: '2026-04-02T10:00:00.000Z',
            completedAt: '2026-04-02T10:05:00.000Z',
            durationMs: 300000,
          },
          {
            phase: 'enumeration',
            label: 'Enumeration',
            ordinal: 2,
            status: 'running',
            startedAt: '2026-04-02T10:06:00.000Z',
            completedAt: null,
            durationMs: null,
          },
        ],
      },
      isLoading: false,
    } as never);

    render(<WorkbenchPage />);

    expect(screen.getByText(/read-only snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /recon phase unavailable/i })).toBeDisabled();
  });

  it('always mounts the workbench: no plan gate on run observability', () => {
    render(<WorkbenchPage />);

    expect(screen.getByTestId('chat-session')).toBeInTheDocument();
    expect(vi.mocked(securityOpsApi.useRunPhasesQuery)).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ enabled: true }),
    );
  });
});
