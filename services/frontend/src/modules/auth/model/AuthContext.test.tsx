/* @vitest-environment jsdom */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@modules/auth';
import { authClient } from '@modules/auth/api/authClient';

vi.mock('@modules/auth/api/authClient', () => ({
  authClient: {
    getUser: vi.fn(),
  },
}));

const mockAuthClient = vi.mocked(authClient);

const AuthConsumer = () => {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="loading">{String(auth.loading)}</div>
      <div data-testid="email">{auth.user?.email ?? ''}</div>
      <div data-testid="keys">{Object.keys(auth).sort().join(',')}</div>
    </div>
  );
};

describe('AuthContext', () => {
  beforeEach(() => {
    mockAuthClient.getUser.mockReset();
  });

  it('reads the local owner once from /api/auth/me on mount', async () => {
    mockAuthClient.getUser.mockResolvedValue({
      error: null,
      data: { id: 'u1', email: 'owner@localhost', created_at: '2025-01-01' },
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('email').textContent).toBe('owner@localhost');
    expect(mockAuthClient.getUser).toHaveBeenCalledTimes(1);
  });

  it('offers only the owner and the loading flag: no sign-in, sign-up, OAuth or sign-out', async () => {
    mockAuthClient.getUser.mockResolvedValue({
      error: null,
      data: { id: 'u1', email: 'owner@localhost', created_at: '2025-01-01' },
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('keys').textContent).toBe('loading,user');
  });

  it('leaves the owner empty when the backend cannot be read', async () => {
    mockAuthClient.getUser.mockResolvedValue({ error: { message: 'unreachable' }, data: null });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('email').textContent).toBe('');
  });

  it('shows the door, and nothing of the app, when this browser does not hold the owner key', async () => {
    mockAuthClient.getUser.mockResolvedValue({ error: { message: 'key required', status: 401 }, data: null });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    expect(await screen.findByText('Open Null AI from its link')).toBeTruthy();
    expect(screen.queryByTestId('loading')).toBeNull();
  });
});
