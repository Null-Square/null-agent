import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from './AssistantPanel';

const mocks = vi.hoisted(() => ({
  dismissRecommendation: vi.fn(),
  navigate: vi.fn(),
  assistantHistory: [] as Array<{ id: string; title: string | null; summary: string | null }>,
  setupReadinessData: {
    recommendations: [
      {
        id: 'verify_target',
        title: 'Verify target ownership',
        description: 'Finish provider, DNS, or HTTP verification before assessment.',
        reason: 'Ownership still needs verification before assessments can run.',
        status: 'required',
        prompt: 'Explain the fastest safe way to verify this target.',
        href: '/setup',
        dismissible: true,
        stateSignature: 'sig-verify-target',
        priority: 90,
      },
    ],
  } as any,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({
    activeScopeId: 'scope-1',
    scopes: [{ id: 'scope-1', name: 'Prod Scope', status: 'active' }],
  }),
}));

vi.mock('@modules/chat/api', () => ({
  useSetupReadinessQuery: () => ({
    data: mocks.setupReadinessData,
  }),
  useAssistantChatSessionsQuery: () => ({
    data: mocks.assistantHistory,
    isLoading: false,
  }),
  useDismissSetupRecommendationMutation: () => ({
    isPending: false,
    mutate: mocks.dismissRecommendation,
    variables: null,
  }),
}));

describe('AssistantPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupReadinessData = {
      recommendations: [
        {
          id: 'verify_target',
          title: 'Verify target ownership',
          description: 'Finish provider, DNS, or HTTP verification before assessment.',
          reason: 'Ownership still needs verification before assessments can run.',
          status: 'required',
          prompt: 'Explain the fastest safe way to verify this target.',
          href: '/setup',
          dismissible: true,
          stateSignature: 'sig-verify-target',
          priority: 90,
        },
      ],
    };
  });

  it('lists recent conversations so the panel can resume one', () => {
    // Resuming a conversation is the most common reason to open the panel, and
    // it was only ever on the chat page.
    mocks.assistantHistory = [
      { id: 'session-1', title: 'Export authorization review', summary: 'Two risks promoted.' },
    ];

    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /open security assistant/i }));

    expect(screen.getByText('Recent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Export authorization review'));
    expect(mocks.navigate).toHaveBeenCalledWith('/chat?session=session-1');

    mocks.assistantHistory = [];
  });

  it('shows each recommendation as one row that starts it in one click', () => {
    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /open security assistant/i }));

    expect(screen.getByText('Verify target ownership')).toBeInTheDocument();
    // The reason is the row's subtitle now, not a disclosure: it used to take a
    // click to reveal and a second click on one of two buttons to act.
    expect(screen.getByText(/ownership still needs verification/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss verify target ownership/i })).toBeNull();
    // The composer keeps the only "send" button on the panel.
    expect(screen.getAllByRole('button', { name: /send/i })).toHaveLength(1);
  });

  it('routes ownership setup actions to the setup wizard instead of the assistant chat', () => {
    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /open security assistant/i }));
    // One click on the row: ownership actions navigate to setup rather than
    // sending a chat prompt.
    fireEvent.click(screen.getByText('Verify target ownership'));

    expect(mocks.navigate).toHaveBeenCalledWith('/setup');
    expect(mocks.navigate).not.toHaveBeenCalledWith(expect.stringContaining('prompt='));
  });

  it('keeps the automation recommendation visible when setup gaps are also present', () => {
    mocks.setupReadinessData = {
      recommendations: [
        {
          id: 'add_target',
          title: 'Add first target',
          description: 'Add the first authorized target.',
          status: 'required',
          prompt: 'Help add a target.',
          stateSignature: 'sig-add-target',
          priority: 100,
        },
        {
          id: 'define_rules',
          title: 'Define rules of engagement',
          description: 'Capture boundaries and constraints.',
          status: 'required',
          prompt: 'Help define rules.',
          stateSignature: 'sig-roe',
          priority: 95,
        },
        {
          id: 'review_scope',
          title: 'Review current posture',
          description: 'Review configured context.',
          status: 'recommended',
          prompt: 'Review this scope.',
          stateSignature: 'sig-review',
          priority: 85,
        },
        {
          id: 'create_automation',
          title: 'Schedule automated checks',
          description: 'Prepare recurring checks for this scope.',
          status: 'recommended',
          prompt: 'Help me prepare a safe recurring automation plan.',
          dismissible: true,
          stateSignature: 'sig-automation',
          priority: 40,
        },
      ],
    };

    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /open security assistant/i }));

    expect(screen.getByText('Schedule automated checks')).toBeInTheDocument();
    expect(screen.queryByText('Review current posture')).toBeNull();

    fireEvent.click(screen.getByText('Schedule automated checks'));

    expect(screen.getByRole('button', { name: /dismiss schedule automated checks/i })).toBeInTheDocument();
  });

  it('shows scope assistant tasks when there are no setup recommendations', () => {
    mocks.setupReadinessData = {
      recommendations: [],
      nextBestActions: [],
    };

    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /open security assistant/i }));

    expect(screen.queryByText(/no active recommendations/i)).toBeNull();
    expect(screen.getByText('Ask about this scope')).toBeInTheDocument();
    expect(screen.getAllByText('Scope overview')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Explain risks')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Prioritize fixes')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Latest run')[0]).toBeInTheDocument();
  });
});
