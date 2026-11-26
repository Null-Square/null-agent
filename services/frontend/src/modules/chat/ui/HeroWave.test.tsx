import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroWave } from './HeroWave';

const mocks = vi.hoisted(() => ({
  complianceReadinessQuery: vi.fn(),
  createRun: vi.fn(),
  /* Mutable so a test can hold the launch mid-flight and look at what the
     customer is actually shown while they wait. */
  createRunPending: false,
  navigate: vi.fn(),
  runsData: [] as Array<Record<string, unknown>>,
  dismissSetupRecommendation: vi.fn(),
  setupReadinessData: null as null | {
    recommendations: Array<Record<string, unknown>>;
    nextBestActions?: Array<Record<string, unknown>>;
  },
  startComplianceAssessment: vi.fn(),
  startCodeReview: vi.fn(),
  codeSource: null as null | Record<string, unknown>,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  targetVerificationMessage: null as string | null,
  targetVerificationState: 'verified' as 'missing' | 'pending' | 'verified',
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('@shared/services/toastService', () => ({
  toastService: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('@shared/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

vi.mock('@shared/contexts/AppPathContext', () => ({
  useAppPaths: () => ({
    assetDetail: (id: string) => `/assets/${id}`,
    assetsList: '/assets',
    automationsList: '/automations',
    complianceControl: (frameworkKey: string, controlId: string) => `/compliance/${frameworkKey}/${controlId}`,
    findingDetail: (id: string) => `/risks/${id}`,
    risksList: '/risks',
    runDetail: (id: string) => `/runs/${id}`,
    runWorkbench: (id: string) => `/runs/${id}/workbench`,
    runnersList: '/runners',
    runsList: '/runs',
    scopeDetail: (id: string) => `/scopes/${id}`,
    scopesList: '/scopes',
  }),
}));

vi.mock('@modules/security-ops/hooks/useContextualRunActions', () => ({
  useContextualRunActions: () => ({
    activeAutomationsCount: 0,
    assetsCount: 3,
    criticalCount: 0,
    hasScope: true,
    highCount: 1,
    loadingSignals: false,
    openRisksCount: 1,
    resolvedRisksCount: 0,
    runnersOnline: 0,
    runnersTotal: 0,
    scope: {
      attachedRunner: null,
      codeSource: mocks.codeSource,
      id: 'scope-1',
      name: 'Primary Scope',
    },
    targetCount: 1,
    targetVerificationMessage: mocks.targetVerificationMessage,
    targetVerificationState: mocks.targetVerificationState,
    verifiedTargetCount: mocks.targetVerificationState === 'verified' ? 1 : 0,
  }),
}));

vi.mock('@modules/security-ops/api', () => ({
  useComplianceReadinessQuery: (scopeId: string | undefined, options?: Record<string, unknown>) => {
    mocks.complianceReadinessQuery(scopeId, options);
    return {
      data: {
      frameworks: [
        {
          key: 'soc2',
          label: 'SOC 2',
          selected: true,
          supported: true,
          controls: [
            { id: 'CC6.1', monitoring: { state: 'monitored' } },
            { id: 'CC6.2', monitoring: { state: 'monitored' } },
          ],
        },
      ],
    },
    };
  },
  useCreateRunMutation: () => ({
    isPending: mocks.createRunPending,
    mutateAsync: mocks.createRun,
  }),
  useRunsQuery: () => ({
    data: mocks.runsData,
  }),
  useStartComplianceAssessmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.startComplianceAssessment,
  }),
  useStartCodeReviewMutation: () => ({
    isPending: false,
    mutateAsync: mocks.startCodeReview,
  }),
}));

vi.mock('@modules/sessions/api', () => ({
  getModelEffortLabel: () => 'Medium',
  useAvailableModelsQuery: () => ({
    data: [
      {
        availableCount: 1,
        category: 'medium',
        description: 'Balanced model effort',
        displayName: 'Medium',
        id: 'medium',
        isDefault: true,
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('@modules/chat/api', () => ({
  useDismissSetupRecommendationMutation: () => ({
    isPending: false,
    mutate: mocks.dismissSetupRecommendation,
    variables: null,
  }),
  useSetupReadinessQuery: () => ({
    data: mocks.setupReadinessData,
  }),
}));

vi.mock('@shared/ui/ExecutionTargetSelector', () => ({
  ExecutionTargetSelector: () => <div data-testid="execution-target-selector" />,
}));

describe('HeroWave mission modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runsData = [];
    mocks.setupReadinessData = null;
    mocks.createRunPending = false;
    mocks.targetVerificationMessage = null;
    mocks.targetVerificationState = 'verified';
    mocks.startComplianceAssessment.mockResolvedValue({ run: { id: 'run-compliance-1' } });
    mocks.startCodeReview.mockResolvedValue({ run: { id: 'run-code-review-1' }, sessionId: 'session-1' });
    mocks.codeSource = null;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
  });

  it('starts a compliance assessment from the mission card without pentest-only controls', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Pentest' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compliance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code Review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Compliance' }));

    expect(screen.getByText('Start SOC 2 Readiness')).toBeInTheDocument();
    expect(screen.queryByTestId('execution-target-selector')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Start Compliance/i }));

    await waitFor(() => {
      expect(mocks.startComplianceAssessment).toHaveBeenCalledWith({
        framework: 'soc2',
        modelCategory: 'medium',
        scopeId: 'scope-1',
        title: 'SOC 2 Readiness Assessment',
      });
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Compliance assessment started.');
    expect(mocks.navigate).toHaveBeenCalledWith('/runs/run-compliance-1');
  });

  it('sends Code Review to the scope page while the scope has no code', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Code Review' }));

    expect(screen.getByText('Review a Repository')).toBeInTheDocument();
    expect(screen.getByText(/Add code on the/)).toHaveTextContent('Add code on the scope page first.');
    expect(screen.queryByText(/No repository is connected/)).toBeNull();
    expect(screen.queryByText(/github/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Code Review assessment' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'scope page' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/scopes/scope-1');
  });

  it('starts a Code Review of the commit the scope code source is at', async () => {
    mocks.codeSource = {
      kind: 'git',
      location: 'https://github.com/juice-shop/juice-shop',
      ref: null,
      status: 'ready',
      headCommit: '3f9c2a1b8e44',
      error: null,
      reviewBrief: null,
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Code Review' }));

    expect(
      screen.getByText('juice-shop · 3f9c2a1. The agent reads this commit and nothing else.'),
    ).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start Code Review assessment' });
    expect(start).toBeEnabled();

    fireEvent.click(start);

    await waitFor(() => {
      expect(mocks.startCodeReview).toHaveBeenCalledWith({ scopeId: 'scope-1', modelCategory: 'medium' });
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Code Review assessment started.');
    expect(mocks.navigate).toHaveBeenCalledWith('/runs/run-code-review-1');
  });

  it('keeps Code Review off while the scope code is still cloning', () => {
    mocks.codeSource = {
      kind: 'git',
      location: 'https://github.com/juice-shop/juice-shop',
      ref: null,
      status: 'cloning',
      headCommit: null,
      error: null,
      reviewBrief: null,
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Code Review' }));

    expect(screen.getAllByText(/juice-shop is still being cloned/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Start Code Review assessment' })).toBeDisabled();
    expect(mocks.startCodeReview).not.toHaveBeenCalled();
  });

  it('disables Code Review start while the scope target is unverified', () => {
    mocks.targetVerificationMessage = 'Verify target ownership before starting an assessment.';
    mocks.targetVerificationState = 'pending';

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Code Review' }));

    expect(screen.getByRole('button', { name: 'Start Code Review assessment' })).toBeDisabled();
    expect(screen.getAllByText('Verify target ownership before starting an assessment.').length).toBeGreaterThan(0);
  });

  it('does not show a pentest active-run block for a running compliance assessment', () => {
    mocks.runsData = [
      {
        id: 'run-compliance-active',
        scopeId: 'scope-1',
        status: 'running',
        workflowDiscipline: 'compliance',
        title: 'SOC 2 Readiness Assessment',
        goal: 'Dedicated SOC 2 readiness assessment.',
        startedAt: '2026-06-25T10:00:00.000Z',
        createdAt: '2026-06-25T10:00:00.000Z',
      },
    ];

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Assessment Already Running')).not.toBeInTheDocument();
    expect(screen.getByText('Start The Next Assessment')).toBeInTheDocument();
  });

  it('always offers every mode: the plan never hides compliance or Code Review', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Pentest' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code Review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compliance' })).toBeInTheDocument();
  });

  it('keeps setup recommendations out of the Home operational insights', () => {
    mocks.setupReadinessData = {
      recommendations: [
        {
          id: 'verify_target',
          title: 'Verify target ownership',
          description: 'Finish provider, DNS, or HTTP verification before assessment.',
          reason: 'Ownership still needs verification.',
          status: 'required',
          prompt: 'Explain the fastest safe way to verify this target.',
          href: '/setup',
          dismissible: true,
          stateSignature: 'sig-verify-target',
        },
        {
          id: 'define_rules',
          title: 'Define rules of engagement',
          description: 'Add scope boundaries before deeper testing.',
          reason: 'Rules are still missing.',
          status: 'required',
          prompt: 'Help define rules of engagement.',
          href: '/setup',
          dismissible: true,
          stateSignature: 'sig-define-rules',
        },
      ],
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Verify target ownership')).not.toBeInTheDocument();
    expect(screen.queryByText('Define rules of engagement')).not.toBeInTheDocument();
    expect(screen.getByText('Review High Risks')).toBeInTheDocument();
    expect(mocks.dismissSetupRecommendation).not.toHaveBeenCalled();
  });

  it('disables assessment start and shows a compact verification action when target is unverified', async () => {
    mocks.targetVerificationMessage = 'Verify target ownership before starting an assessment.';
    mocks.targetVerificationState = 'pending';

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Verification Required')).not.toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: /Start next assessment/i });
    expect(startButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^verify target$/i }));

    expect(mocks.navigate).toHaveBeenCalledWith('/scopes/scope-1');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it('blocks chat mode too when the target is unverified', () => {
    mocks.targetVerificationMessage = 'Target ownership must be verified before starting a run.';
    mocks.targetVerificationState = 'pending';

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-hero-submit')).toBeDisabled();
    expect(screen.getByText('Verify the target before chatting.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^verify target$/i }));

    expect(mocks.navigate).toHaveBeenCalledWith('/scopes/scope-1');
    expect(mocks.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/chat?'));
  });

  it('does not gate chat mode once the target is verified', () => {
    mocks.targetVerificationMessage = null;
    mocks.targetVerificationState = 'verified';

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/before chatting/i)).not.toBeInTheDocument();
  });

  /**
   * Starting an assessment checks the plan, loads the scope, provisions an
   * environment and launches the agent — and the button used to answer all of
   * it with a 7px flickering square, so a slow provision read as a dead page.
   */
  it('says what it is doing while the assessment is being prepared', () => {
    mocks.createRunPending = true;

    render(
      <MemoryRouter initialEntries={['/']}>
        <HeroWave />
      </MemoryRouter>,
    );

    expect(screen.getByText(/preparing your assessment/i)).toBeInTheDocument();
    // The first ambient caption. They cycle, and none of them claims a stage
    // is complete — the whole launch is a single request the browser cannot
    // see inside.
    expect(screen.getByText(/creating an isolated container/i)).toBeInTheDocument();
  });
});
