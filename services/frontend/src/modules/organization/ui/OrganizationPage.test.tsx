import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import OrganizationPage from './OrganizationPage';
import {
  useOrganizationQuery,
  useUpdateOrganizationMutation,
} from '@/modules/security-ops/api';

const permissionMocks = vi.hoisted(() => ({
  has: vi.fn(() => true),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useOrganizationQuery: vi.fn(),
  useUpdateOrganizationMutation: vi.fn(),
}));

vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({
    has: permissionMocks.has,
  }),
}));

// The Model tab's own behaviour is tested in modules/model.
vi.mock('@modules/model', () => ({
  ModelSettingsPanel: ({ returnTo }: { returnTo: string }) => <div data-testid="model-settings">{returnTo}</div>,
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const mockUseOrganizationQuery = vi.mocked(useOrganizationQuery);
const mockUseUpdateOrganizationMutation = vi.mocked(useUpdateOrganizationMutation);
let mockUpdateMutate = vi.fn();

describe('OrganizationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMocks.has.mockReturnValue(true);

    mockUseOrganizationQuery.mockReturnValue({
      data: {
        id: 'org-1',
        name: 'Acme Corp',
        slug: 'acme-corp',
        operationalContext: 'High security context',
      },
      isLoading: false,
    } as never);

    mockUpdateMutate = vi.fn();
    mockUseUpdateOrganizationMutation.mockReturnValue({
      mutate: mockUpdateMutate,
      isPending: false,
    } as never);
  });

  it('renders only the organization section: no members, billing, trust, partner, plan or delete', async () => {
    render(
      <MemoryRouter>
        <OrganizationPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /organization/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /members/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /billing/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /trust/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /partner/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /organization details/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.queryByText(/delete organization/i)).toBeNull();
  });

  /* The brief is a field on this page now. It was a three-step wizard that
     composed a markdown document, opened by an Edit button. */
  it('edits the organization description inline, with no wizard to open', () => {
    render(
      <MemoryRouter>
        <OrganizationPage />
      </MemoryRouter>,
    );

    expect(screen.getByDisplayValue('High security context')).toBeInTheDocument();
    expect(screen.getByText('21/500')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit brief/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /organization brief/i })).toBeNull();
  });

  /* The cap dropped from 4,000 when the brief stopped being a document, so an
     organization written under the old wizard can be over it. Rejecting the
     whole save at the API would block a rename that has nothing to do with it. */
  it('refuses to save a description left over the new limit, and says why', () => {
    mockUseOrganizationQuery.mockReturnValue({
      data: {
        id: 'org-1',
        name: 'Acme Corp',
        slug: 'acme-corp',
        operationalContext: 'x'.repeat(900),
      },
    } as never);

    render(
      <MemoryRouter>
        <OrganizationPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('900/500')).toBeInTheDocument();
    expect(screen.getByText(/predates the 500-character limit/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'Acme Two' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockUpdateMutate).not.toHaveBeenCalled();
  });

  it('has a Model tab beside Organization', () => {
    render(
      <MemoryRouter>
        <OrganizationPage />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('model-settings')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /model/i }));

    expect(screen.getByTestId('model-settings')).toHaveTextContent('/settings');
    expect(screen.queryByRole('heading', { name: /organization details/i })).toBeNull();
  });

  it('opens the Model tab when ChatGPT sends the browser back', () => {
    render(
      <MemoryRouter initialEntries={['/settings?chatgpt=connected']}>
        <OrganizationPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: /model/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('model-settings')).toBeInTheDocument();
  });
});
