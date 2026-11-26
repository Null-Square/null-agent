import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateScopeModal from './CreateScopeModal';

const mockNavigate = vi.fn();
const mockMutate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/modules/security-ops/api', () => ({
  useCreateScopeMutation: vi.fn(),
}));

import { useCreateScopeMutation } from '@/modules/security-ops/api';

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

describe('CreateScopeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useCreateScopeMutation as any).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
  });

  it('renders nothing when closed', () => {
    render(
      <MemoryRouter>
        <CreateScopeModal open={false} onClose={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders form fields when open', () => {
    render(
      <MemoryRouter>
        <CreateScopeModal open={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText(/create new scope/i)).toBeInTheDocument();
    expect(screen.getByText('Scope name')).toBeInTheDocument();
    // Creating a scope asks for a name and nothing else. Execution target and
    // plan approval have defaults and live on the scope, next to what they
    // affect.
    expect(screen.queryByText(/require plan approval/i)).toBeNull();
    expect(screen.queryByText(/execution model/i)).toBeNull();
  });

  it('disables create button if name is empty', () => {
    render(
      <MemoryRouter>
        <CreateScopeModal open={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    const createBtn = screen.getByText(/^create scope$/i);
    expect(createBtn).toBeDisabled();
  });

  it('calls mutation on submit', async () => {
    render(
      <MemoryRouter>
        <CreateScopeModal open={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    const nameInput = screen.getAllByRole('textbox')[0]; // First input is name
    fireEvent.change(nameInput, { target: { value: 'New Scope' } });

    const createBtn = screen.getByText(/^create scope$/i);
    expect(createBtn).not.toBeDisabled();
    
    fireEvent.click(createBtn);

    expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
            name: 'New Scope',
        }),
        expect.any(Object)
    );
  });

  it('never limits scope creation on a plan', () => {
    render(
      <MemoryRouter>
        <CreateScopeModal open={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/scope name/i), { target: { value: 'Fourth scope' } });
    expect(screen.queryByText(/scope limit reached/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^create scope$/i)).not.toBeDisabled();
  });
});
