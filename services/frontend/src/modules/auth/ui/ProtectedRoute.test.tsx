/* @vitest-environment jsdom */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import { useAuth } from '@modules/auth';
import { authClient } from '@modules/auth/api/authClient';

vi.mock('@modules/auth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@modules/auth/api/authClient', () => ({
  authClient: {
    getSetupStatus: vi.fn(),
  },
}));

const mockUseAuth = vi.mocked(useAuth);
const mockGetSetupStatus = vi.mocked(authClient.getSetupStatus);
const owner = { id: 'u1', email: 'owner@localhost' };

const renderWithRoutes = (initialEntry = '/protected') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/auth" element={<div>Auth Screen</div>} />
        <Route path="/welcome" element={<div>Welcome Screen</div>} />
        <Route path="/" element={<div>Home Screen</div>} />
        <Route
          path="/setup"
          element={
            <ProtectedRoute>
              <div>Setup Screen</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div>Protected Content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockGetSetupStatus.mockReset();
    mockGetSetupStatus.mockResolvedValue({
      error: null,
      data: { setup_required: false },
    });
  });

  /**
   * ── THE GUARD NO LONGER DRAWS ITS OWN WAITING SCREEN ──
   * It signals `BootScreenProvider` and renders nothing, so one element covers
   * the whole boot. What matters here is that it does NOT show the page.
   */
  it('renders no page content while the owner is loading', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true } as ReturnType<typeof useAuth>);
    renderWithRoutes();
    expect(screen.queryByText('Protected Content')).toBeNull();
  });

  it('never sends anyone to a sign-in screen, even with no owner', async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false } as ReturnType<typeof useAuth>);
    renderWithRoutes();
    expect(await screen.findByText('Protected Content')).toBeInTheDocument();
    expect(screen.queryByText('Auth Screen')).toBeNull();
  });

  it('renders children when setup is done', async () => {
    mockUseAuth.mockReturnValue({ user: owner, loading: false } as ReturnType<typeof useAuth>);
    renderWithRoutes();
    expect(await screen.findByText('Protected Content')).toBeInTheDocument();
  });

  it('redirects to setup when no scope is ready yet', async () => {
    mockGetSetupStatus.mockResolvedValue({
      error: null,
      data: { setup_required: true },
    });
    mockUseAuth.mockReturnValue({ user: owner, loading: false } as ReturnType<typeof useAuth>);
    renderWithRoutes();
    expect(await screen.findByText('Setup Screen')).toBeInTheDocument();
  });

  it('leaves a finished setup for home, never for a welcome screen', async () => {
    mockUseAuth.mockReturnValue({ user: owner, loading: false } as ReturnType<typeof useAuth>);
    renderWithRoutes('/setup');
    expect(await screen.findByText('Home Screen')).toBeInTheDocument();
    expect(screen.queryByText('Welcome Screen')).toBeNull();
  });
});
