/* @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import SidebarLayout from './SidebarLayout';

const themeMocks = vi.hoisted(() => ({ toggleTheme: vi.fn() }));

vi.mock('@modules/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@example.com' } }),
  useProfile: () => ({ profile: { full_name: 'Owner' } }),
}));

vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({ has: () => true }),
}));

vi.mock('@shared/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: themeMocks.toggleTheme }),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({
    activeScopeId: 'scope-1',
    setActiveScopeId: vi.fn(),
    scopes: [{ id: 'scope-1', name: 'example.com Website' }],
  }),
}));

/* The sidebar asks what work is waiting behind each destination. Mocked here
   for the same reason the unread count is: both are react-query hooks, and this
   file is about the compact shell's layout, not about wiring a QueryClient. */
vi.mock('@modules/layout/api/attention', () => ({
  useAttention: () => ({ data: {} }),
  useMarkSeen: () => ({ mutate: vi.fn() }),
}));

vi.mock('@modules/notifications/hooks/useNotifications', () => ({
  useUnreadCount: () => ({ data: 3 }),
}));

vi.mock('@modules/notifications/hooks/useNotificationStream', () => ({
  useNotificationStream: () => ({ connected: false }),
}));

/* Mocked for the same reason the notification stream is: this suite renders
   the layout without a QueryClientProvider, and the live-refresh hook needs a
   client. Its own behaviour is covered in useLiveDataSync.test.tsx. */
vi.mock('@shared/hooks/useLiveDataSync', () => ({
  useLiveDataSync: () => undefined,
}));

vi.mock('@modules/notifications/ui/NotificationPanel', () => ({
  NotificationPanel: () => <div>Notification panel</div>,
}));

vi.mock('@modules/chat', () => ({
  AssistantPanel: () => null,
}));

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

describe('SidebarLayout workbench shell', () => {
  it('always renders the full workbench rail, with no results dock, credits, plan badge or profile link', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const { container } = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <SidebarLayout>
          <div>Dashboard content</div>
        </SidebarLayout>
      </MemoryRouter>,
    );

    expect(container.querySelector('aside')).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Core application navigation' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Risks' })).toHaveAttribute('href', '/risks');
    expect(screen.getByRole('link', { name: 'Assessments' })).toHaveAttribute('href', '/runs');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('link', { name: 'Integrations' })).toBeNull();
    expect(screen.queryByTitle(/credits/i)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull();
    expect(screen.getByLabelText('Profile')).toHaveTextContent('owner@example.com');
    expect(screen.getByText('Dashboard content')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Switch to Light Mode'));
    expect(themeMocks.toggleTheme).toHaveBeenCalledOnce();
  });
});
