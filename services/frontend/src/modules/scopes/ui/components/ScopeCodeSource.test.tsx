import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScopeCodeSourcePanel from './ScopeCodeSource';

const mocks = vi.hoisted(() => ({
  codeSource: null as null | Record<string, unknown>,
  setSource: vi.fn(),
  refreshSource: vi.fn(),
  removeSource: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useScopeCodeSourceQuery: () => ({ data: mocks.codeSource }),
  useSetScopeCodeSourceMutation: () => ({ mutateAsync: mocks.setSource, isPending: false }),
  useRefreshScopeCodeSourceMutation: () => ({ mutateAsync: mocks.refreshSource, isPending: false }),
  useRemoveScopeCodeSourceMutation: () => ({ mutateAsync: mocks.removeSource, isPending: false }),
  invalidateScopeCodeSource: mocks.invalidate,
}));

const READY = {
  kind: 'git',
  location: 'https://github.com/juice-shop/juice-shop',
  ref: null,
  status: 'ready',
  headCommit: '3f9c2a1b8e44',
  error: null,
  reviewBrief: null,
};

const renderPanel = (canManage = true) => {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ScopeCodeSourcePanel scopeId="scope-1" canManage={canManage} />
    </QueryClientProvider>,
  );
};

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /^code/i }));

describe('ScopeCodeSourcePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.codeSource = null;
    mocks.setSource.mockResolvedValue({ codeSource: { ...READY, status: 'cloning', headCommit: null } });
    mocks.refreshSource.mockResolvedValue({ codeSource: READY });
    mocks.removeSource.mockResolvedValue(null);
  });

  it('reads None until a source is set, and explains each kind', () => {
    renderPanel();

    expect(screen.getByText('A folder on this computer, or a public git URL, for Code Review.')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();

    openPanel();
    expect(
      screen.getByText('Public repositories only. For a private one, clone it yourself and add the folder.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Folder' }));
    expect(
      screen.getByText('A folder on this computer, read where it is and never written. In Docker, put it under ./code.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Folder path')).toBeInTheDocument();
  });

  it('uses a git URL', async () => {
    renderPanel();
    openPanel();

    fireEvent.change(screen.getByLabelText('Git URL'), {
      target: { value: '  https://github.com/juice-shop/juice-shop  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this code' }));

    await waitFor(() =>
      expect(mocks.setSource).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        kind: 'git',
        location: 'https://github.com/juice-shop/juice-shop',
      }),
    );
  });

  it('uses a folder', async () => {
    renderPanel();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Folder' }));
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'C:\\code\\juice-shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this code' }));

    await waitFor(() =>
      expect(mocks.setSource).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        kind: 'folder',
        location: 'C:\\code\\juice-shop',
      }),
    );
  });

  it('shows a refused source in the words the server used', async () => {
    mocks.setSource.mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 'validation.invalid_format',
          message: 'Only https:// and ssh git URLs are accepted.',
          httpStatus: 400,
          userMessage: 'Only https:// and ssh git URLs are accepted.',
        },
      },
    });
    renderPanel();
    openPanel();

    fireEvent.change(screen.getByLabelText('Git URL'), { target: { value: 'ftp://example.com/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only https:// and ssh git URLs are accepted.');
  });

  it('shows Cloning while the clone runs', () => {
    mocks.codeSource = { ...READY, status: 'cloning', headCommit: null };
    renderPanel();

    expect(screen.getByText('Cloning')).toBeInTheDocument();
    openPanel();
    expect(screen.getByText('Cloning…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('names a ready source by its commit, and refreshes or removes it', async () => {
    mocks.codeSource = READY;
    renderPanel();

    expect(screen.getByText('juice-shop · 3f9c2a1')).toBeInTheDocument();
    openPanel();
    expect(screen.getByLabelText('Git URL')).toHaveValue('https://github.com/juice-shop/juice-shop');
    expect(screen.getByText('Ready · 3f9c2a1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.refreshSource).toHaveBeenCalledWith('scope-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith('scope-1'));
  });

  it('shows why a clone failed', () => {
    mocks.codeSource = { ...READY, status: 'failed', headCommit: null, error: 'The repository was not found.' };
    renderPanel();

    expect(screen.getByText('Failed')).toBeInTheDocument();
    openPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('The repository was not found.');
  });

  it('refreshes the scopes once a clone finishes, so the home sees it', () => {
    mocks.codeSource = { ...READY, status: 'cloning', headCommit: null };
    const { rerender } = renderPanel();
    expect(mocks.invalidate).not.toHaveBeenCalled();

    mocks.codeSource = READY;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ScopeCodeSourcePanel scopeId="scope-1" canManage />
      </QueryClientProvider>,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(expect.anything(), 'scope-1');
  });

  it('is read-only without the right to manage the scope', () => {
    renderPanel(false);
    openPanel();

    expect(screen.getByLabelText('Git URL')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this code' })).toBeDisabled();
  });
});
