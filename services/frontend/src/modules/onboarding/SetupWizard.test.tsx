import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizard from './SetupWizard';
import type { SetupFormData } from './types';

const {
  mockNavigate,
  mockSetActiveScopeId,
  mockToastError,
  mockUpdateOrganization,
  mockCreateScope,
  mockUpdateScope,
  mockAddTarget,
  mockRemoveTarget,
  mockVerifyTarget,
  mockOrganizationQuery,
  mockScopesState,
  mockGetProfile,
  mockUpdateProfile,
  mockModelOverview,
  CONNECTED,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetActiveScopeId: vi.fn(),
  mockToastError: vi.fn(),
  mockUpdateOrganization: vi.fn(),
  mockCreateScope: vi.fn(),
  mockUpdateScope: vi.fn(),
  mockAddTarget: vi.fn(),
  mockRemoveTarget: vi.fn(),
  mockVerifyTarget: vi.fn(),
  mockOrganizationQuery: vi.fn(),
  mockScopesState: [] as Array<{
    id: string;
    status?: string;
    name?: string;
    targetCount?: number;
  }>,
  mockGetProfile: vi.fn(),
  mockUpdateProfile: vi.fn(),
  mockModelOverview: vi.fn(),
  CONNECTED: {
    connection: {
      method: 'api_key',
      provider: 'ANTHROPIC',
      model: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      account: null,
      server: null,
    },
    providers: [],
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({ setActiveScopeId: mockSetActiveScopeId }),
}));

vi.mock('@modules/auth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'operator@example.com' },
    loading: false,
  }),
}));

vi.mock('@modules/auth/api/authClient', () => ({
  authClient: {
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    section: ({ children, ...props }: any) => <section {...props}>{children}</section>,
    span: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  },
}));

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: { success: vi.fn(), error: mockToastError },
}));

vi.mock('@shared/lib/apiError', () => ({
  toApiError: (error: any) => ({ message: error?.message || 'Error' }),
}));

vi.mock('lucide-react', () => ({
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  LogOut: () => <span data-testid="icon-log-out" />,
  ArrowUpRight: () => <span data-testid="icon-arrow-up-right" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Copy: () => <span data-testid="icon-copy" />,
  CheckCircle: () => <span data-testid="icon-check-circle" />,
  Cable: () => <span data-testid="icon-cable" />,
  Search: () => <span data-testid="icon-search" />,
  Check: () => <span data-testid="icon-check" />,
}));

vi.mock('@modules/security-ops/api', () => ({
  useOrganizationQuery: () => ({ data: mockOrganizationQuery() }),
  useUpdateOrganizationMutation: () => ({ mutateAsync: (...args: unknown[]) => mockUpdateOrganization(...args) }),
  useCreateScopeMutation: () => ({ mutateAsync: (...args: unknown[]) => mockCreateScope(...args) }),
  useUpdateScopeMutation: () => ({ mutateAsync: (...args: unknown[]) => mockUpdateScope(...args) }),
  useAddTargetMutation: () => ({ mutateAsync: (...args: unknown[]) => mockAddTarget(...args) }),
  useRemoveTargetMutation: () => ({ mutateAsync: (...args: unknown[]) => mockRemoveTarget(...args) }),
  useVerifyTargetMutation: () => ({ mutateAsync: (...args: unknown[]) => mockVerifyTarget(...args) }),
  useScopesQuery: () => ({ data: mockScopesState, isLoading: false }),
}));

/* The model is the server's: the step reads the connection, and the choices
   that make one are tested on their own. */
vi.mock('@modules/model', async () => {
  const { useQuery, useQueryClient } = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  const key = ['model-connection'];
  const fetchModelOverview = () => Promise.resolve(mockModelOverview());
  return {
    modelConnectionQueryKey: key,
    fetchModelOverview,
    useModelConnectionQuery: () => useQuery({ queryKey: key, queryFn: fetchModelOverview }),
    // Stands in for the three choices: one button that leaves a model connected.
    ModelConnect: ({ returnTo }: { returnTo: string }) => {
      const queryClient = useQueryClient();
      return (
        <div data-testid="model-connect">
          {returnTo}
          <button type="button" onClick={() => queryClient.setQueryData(key, CONNECTED)}>
            Connect test model
          </button>
        </div>
      );
    },
  };
});

vi.mock('@modules/chat/api', () => ({
  useWebsiteVerificationRecommendationQuery: () => ({ data: undefined, isFetching: false }),
}));

const baseFormData: SetupFormData = {
  orgName: 'TestOrg',
  operationalContext: '',
  scopeName: '',
  mission: '',
  impactTolerance: 'non_destructive',
  complianceFrameworks: [],
  targetType: 'domain',
  targetValue: '',
  domainVerificationMethod: 'dns_txt',
  isTargetVerified: false,
};

describe('SetupWizard', () => {
  const renderWizard = async (initialEntries: string[] = ['/setup']) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <SetupWizard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByText(/restoring your setup/i)).not.toBeInTheDocument();
    });
  };

  /* The model comes first; with one connected, Continue opens the organization. */
  const passModelStep = async () => {
    expect(screen.getByText('Connected: Claude Opus 5.5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    return screen.findByLabelText(/organization name/i);
  };

  const advanceToWebsiteStep = async () => {
    await passModelStep();
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'TestOrg' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    return screen.findByLabelText(/target value/i);
  };

  /* The website step owns proving control of the domain; the step after it is
     the statement. Both are needed to finish, so tests walk through both. */
  const advanceToAuthorizeStep = async (website: string) => {
    const websiteInput = await advanceToWebsiteStep();
    fireEvent.change(websiteInput, { target: { value: website } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    return screen.findByRole('button', { name: /^i authorize$/i });
  };

  const authorize = async (website: string) => {
    const authorizeButton = await advanceToAuthorizeStep(website);
    fireEvent.click(authorizeButton);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockScopesState.length = 0;
    mockOrganizationQuery.mockReturnValue({});
    mockGetProfile.mockResolvedValue({ error: null, data: { preferences: {} } });
    mockModelOverview.mockReturnValue(CONNECTED);
    mockUpdateProfile.mockResolvedValue({ error: null, data: { preferences: {} } });
    mockUpdateOrganization.mockResolvedValue({});
    mockCreateScope.mockResolvedValue({ id: 'scope-1', name: 'example.com Website', status: 'active' });
    mockUpdateScope.mockResolvedValue({ id: 'scope-1', name: 'example.com Website', status: 'active' });
    mockAddTarget.mockResolvedValue({ id: 'target-1', verificationToken: 'tok-123' });
    mockRemoveTarget.mockResolvedValue(undefined);
    mockVerifyTarget.mockResolvedValue({ verified: false, message: 'Pending verification' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a model first, then the organization, website and authorization', async () => {
    await renderWizard();

    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /connect a model/i })).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(
      screen.getByText('Null thinks with a model you choose. You can change it later in Settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/scope name/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^GitHub$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Compliance$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Review$/i)).not.toBeInTheDocument();
  });

  it('shows a model that is already connected, with a way to change it', async () => {
    await renderWizard();

    expect(screen.getByText('Connected: Claude Opus 5.5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
    expect(screen.queryByTestId('model-connect')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    expect(screen.getByTestId('model-connect')).toHaveTextContent('/setup');
  });

  it('keeps Continue off until a model is connected', async () => {
    mockModelOverview.mockReturnValue({ connection: null, providers: [] });
    await renderWizard();

    expect(screen.getByTestId('model-connect')).toHaveTextContent('/setup');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('opens the organization step empty even when an organization already exists', async () => {
    await renderWizard();
    const orgInput = await passModelStep();
    // The field the wizard exists to ask about must not arrive pre-answered.
    expect((orgInput as HTMLInputElement).value).toBe('');
  });

  it('blocks navigation if organization is missing', async () => {
    await renderWizard();
    await passModelStep();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(screen.queryByLabelText(/target value/i)).not.toBeInTheDocument();
  });

  it('saves the organization before opening the website step', async () => {
    await renderWizard();
    await advanceToWebsiteStep();

    expect(mockUpdateOrganization).toHaveBeenCalledWith({ name: 'TestOrg', operationalContext: null });
    expect(screen.getByLabelText('Step 3 of 4')).toBeInTheDocument();
  });

  it('resumes directly at the website from valid server progress', async () => {
    mockGetProfile.mockResolvedValue({
      error: null,
      data: {
        preferences: {
          onboardingProgress: {
            version: 1,
            lastCompletedStep: 1,
            formData: baseFormData,
            scopeId: null,
            targetId: null,
            targetSnapshot: '',
            updatedAt: '2026-08-11T00:00:00.000Z',
          },
        },
      },
    });

    await renderWizard();
    expect(screen.getByRole('heading', { name: /add your website/i })).toBeInTheDocument();
  });

  /* Progress saved before the model step existed: without a model the step
     comes first, and Continue then goes on to where the person had got to. */
  it('asks for a model before resuming progress saved without one', async () => {
    mockModelOverview.mockReturnValue({ connection: null, providers: [] });
    mockGetProfile.mockResolvedValue({
      error: null,
      data: {
        preferences: {
          onboardingProgress: {
            version: 1,
            lastCompletedStep: 1,
            formData: baseFormData,
            scopeId: null,
            targetId: null,
            targetSnapshot: '',
            updatedAt: '2026-08-11T00:00:00.000Z',
          },
        },
      },
    });

    await renderWizard();
    expect(screen.getByRole('heading', { name: /connect a model/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect test model' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByRole('heading', { name: /add your website/i })).toBeInTheDocument();
  });

  it('opens the model step when ChatGPT sends the browser back', async () => {
    mockGetProfile.mockResolvedValue({
      error: null,
      data: {
        preferences: {
          onboardingProgress: {
            version: 1,
            lastCompletedStep: 1,
            formData: baseFormData,
            scopeId: null,
            targetId: null,
            targetSnapshot: '',
            updatedAt: '2026-08-11T00:00:00.000Z',
          },
        },
      },
    });

    await renderWizard(['/setup?chatgpt=connected']);
    expect(screen.getByRole('heading', { name: /connect a model/i })).toBeInTheDocument();
    expect(screen.getByTestId('model-connect')).toBeInTheDocument();
  });

  it('returns edited progress with no organization to the first step', async () => {
    mockGetProfile.mockResolvedValue({
      error: null,
      data: {
        preferences: {
          onboardingProgress: {
            version: 1,
            lastCompletedStep: 2,
            formData: { ...baseFormData, orgName: '', targetValue: 'example.com', scopeName: 'example.com Website' },
            scopeId: 'scope-1',
            targetId: 'target-1',
            targetSnapshot: 'domain:example.com:dns_txt',
            updatedAt: '2026-08-11T00:00:00.000Z',
          },
        },
      },
    });

    await renderWizard();
    expect(screen.getByRole('heading', { name: /connect a model/i })).toBeInTheDocument();
    await passModelStep();
    expect(screen.getByRole('heading', { name: /create your organization/i })).toBeInTheDocument();
  });

  it('creates the initial pending target on the inactive plan and lets verification happen later', async () => {
    await renderWizard();
    await authorize('https://Example.COM/login?from=setup');

    expect(mockCreateScope).toHaveBeenCalledWith(expect.objectContaining({ name: 'example.com Website' }));
    expect(mockAddTarget).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: 'scope-1',
      type: 'domain',
      value: 'example.com',
    }));
    expect(mockUpdateProfile).toHaveBeenCalledWith({
      preferences: expect.objectContaining({
        onboardingCompletedAt: expect.any(String),
        onboardingProgress: expect.objectContaining({
          lastCompletedStep: 2,
          scopeId: 'scope-1',
          targetId: 'target-1',
          formData: expect.objectContaining({ scopeName: 'example.com Website' }),
        }),
      }),
    });
    expect(mockSetActiveScopeId).toHaveBeenCalledWith('scope-1');
    expect(mockVerifyTarget).not.toHaveBeenCalled();
  });

  it('reuses an existing empty scope instead of creating another one', async () => {
    mockScopesState.push({ id: 'scope-existing', name: 'Old scope', status: 'active', targetCount: 0 });
    await renderWizard();
    await authorize('example.com');

    expect(mockCreateScope).not.toHaveBeenCalled();
    expect(mockUpdateScope).toHaveBeenCalledWith(expect.objectContaining({
      id: 'scope-existing',
      name: 'example.com Website',
    }));
  });

  /* Proving control of the domain stays on the website step, where the record
     it asks you to publish is shown. */
  it('keeps ownership verification on the website step', async () => {
    await renderWizard();
    const websiteInput = await advanceToWebsiteStep();
    vi.useFakeTimers();
    fireEvent.change(websiteInput, { target: { value: 'example.com' } });
    await act(async () => vi.advanceTimersByTime(3000));
    vi.useRealTimers();

    fireEvent.click(screen.getByRole('button', { name: /show dns record instructions/i }));
    await waitFor(() => expect(mockVerifyTarget).toHaveBeenCalled());
    expect(await screen.findByText('ns-verify=tok-123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify & start discovery/i })).toBeInTheDocument();
  });

  /* The statement is a separate claim from proving control, made on the step
     after, and it is what finishes setup. */
  it('records the statement when the customer authorizes', async () => {
    await renderWizard();
    await authorize('example.com');

    expect(mockUpdateScope).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: { accepted: true } }),
    );
  });

  it('does not record a statement before the last step', async () => {
    await renderWizard();
    await advanceToAuthorizeStep('example.com');

    expect(mockUpdateScope).not.toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.anything() }),
    );
    expect(mockCreateScope).not.toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.anything() }),
    );
  });

  it('offers no way to log out: the local owner is always signed in', async () => {
    await renderWizard();
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
  });
});
