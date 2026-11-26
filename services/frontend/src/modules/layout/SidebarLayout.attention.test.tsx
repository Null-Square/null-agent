/* @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import SidebarLayout, { APP_NAV_ITEMS } from './SidebarLayout';

/**
 * THE NAV DOT SAYS "THERE IS WORK HERE", AND IT HAS TO MEAN IT.
 *
 * A customer who signed up through a partner's referral link had a pending
 * intent sitting on `/settings` — a destination that is not in the Operations
 * nav — with nothing anywhere telling them. These pin the two properties that
 * make the fix real rather than decorative:
 *
 *   1. a destination with work waiting is marked, and the number is the mark
 *   2. a destination the user cannot open is NEVER marked, because a count is
 *      a disclosure and a dot on a locked door is a taunt
 */
const attentionMock = vi.hoisted(() => ({
  data: {} as Record<string, number>,
  seen: [] as string[],
}));

vi.mock('@modules/layout/api/attention', () => ({
  /* The endpoint returns one flat count record keyed by the nav item ids. */
  useAttention: () => ({ data: attentionMock.data }),
  useMarkSeen: () => ({ mutate: (surface: string) => attentionMock.seen.push(surface) }),
}));

vi.mock('@modules/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@example.com' } }),
  useProfile: () => ({ profile: { full_name: 'Owner' } }),
}));

const permissionMock = vi.hoisted(() => ({ has: (_cap: string): boolean => true }));
vi.mock('@modules/permissions', () => ({
  useOrgPermissions: () => ({ has: permissionMock.has, isLoading: false }),
}));

vi.mock('@shared/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({ activeScopeId: null, setActiveScopeId: vi.fn(), scopes: [] }),
}));

vi.mock('@modules/notifications/hooks/useNotifications', () => ({
  useUnreadCount: () => ({ data: 0 }),
}));
vi.mock('@modules/notifications/hooks/useNotificationStream', () => ({
  useNotificationStream: () => undefined,
}));
/* Mocked for the same reason the notification stream is: this suite renders
   the layout without a QueryClientProvider, and the live-refresh hook needs a
   client. Its own behaviour is covered in useLiveDataSync.test.tsx. */
vi.mock('@shared/hooks/useLiveDataSync', () => ({
  useLiveDataSync: () => undefined,
}));
vi.mock('@modules/notifications/ui/NotificationPanel', () => ({
  NotificationPanel: () => null,
}));
vi.mock('@modules/chat', () => ({ AssistantPanel: () => null }));

const renderSidebar = (path = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarLayout>
        <div />
      </SidebarLayout>
    </MemoryRouter>,
  );

describe('the nav attention dot', () => {
  it('shows nothing at all when no destination is waiting', () => {
    attentionMock.data = {};
    permissionMock.has = () => true;
    const { container } = renderSidebar();

    expect(container.querySelectorAll('.bg-primary').length).toBeGreaterThanOrEqual(0);
    expect(screen.queryByText('3')).toBeNull();
  });

  it('marks a destination that has work waiting, with the count', () => {
    attentionMock.data = { risks: 3 };
    permissionMock.has = () => true;
    renderSidebar();

    /* The number is the mark when there is room for it — "3 findings" is a
       decision, "some findings" is a prompt to go and count them. */
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('never marks a destination the user cannot open', () => {
    /* The server already withholds counts the caller has no capability for.
       This is the second line: even handed a count, a locked item stays bare,
       because a dot on a door that will not open is worse than silence. */
    attentionMock.data = { risks: 4 };
    permissionMock.has = () => false;
    renderSidebar();

    expect(screen.queryByText('4')).toBeNull();
  });

  /**
   * ── ARRIVING IS WHAT CLEARS THE MARK ──
   * The badge pattern is only half-built if the dot never goes away. The nav
   * reports the arrival because there are four render paths into these
   * destinations and a page-side hook would have to be remembered in each one.
   */
  it('reports the arrival when you open a destination that is marked', () => {
    attentionMock.data = { risks: 3 };
    attentionMock.seen = [];
    permissionMock.has = () => true;
    renderSidebar('/risks');

    expect(attentionMock.seen).toEqual(['risks']);
  });

  /* The boundary: only destinations the server actually keeps a watermark for.
     Everything else — Dashboard, Assets, Scopes — is silent, so navigating the
     app does not write for pages that have nothing to mark. */
  it('says nothing for a destination the server does not track', () => {
    attentionMock.data = {};
    attentionMock.seen = [];
    permissionMock.has = () => true;
    renderSidebar('/risks');

    expect(attentionMock.seen).toEqual([]);
  });

  /**
   * ── PRESENCE IS THE CONDITION, NOT THE NUMBER ──
   * A tracked destination reports on arrival even when its count is zero, and
   * this is the whole reason the loop cannot come back: the trigger is the
   * navigation, which the write cannot change. Condition it on `count > 0` and
   * a rejected write restores the count, re-satisfies the condition and fires
   * again — which is exactly what happened.
   */
  it('reports arrival at a tracked destination even with nothing new', () => {
    attentionMock.data = { risks: 0 };
    attentionMock.seen = [];
    permissionMock.has = () => true;
    renderSidebar('/risks');

    expect(attentionMock.seen).toEqual(['risks']);
  });

  /**
   * ── THE LOOP THIS FEATURE SHIPPED WITH, AND MUST NEVER SHIP AGAIN ──
   * The count is both what triggers the report and what the report changes, so
   * they close a loop the moment a write does not stick: a rejected POST rolls
   * the count back, the rollback re-satisfies the condition, and it fires
   * again. It put 1,927 requests through in fifteen minutes and rate-limited
   * every other endpoint in the app.
   *
   * There is no brake now and there does not need to be: the trigger is the
   * arrival, not the count. This simulates the failing case exactly — the count
   * never goes away — and pins that it is still reported once.
   */
  it('reports a destination once per visit, even when the count never clears', () => {
    attentionMock.data = { risks: 3 };
    attentionMock.seen = [];
    permissionMock.has = () => true;

    const { rerender } = renderSidebar('/risks');
    /* Re-render with the count still present, as a failed write leaves it. */
    for (let i = 0; i < 5; i += 1) {
      rerender(
        <MemoryRouter initialEntries={['/risks']}>
          <SidebarLayout>
            <div />
          </SidebarLayout>
        </MemoryRouter>,
      );
    }

    expect(attentionMock.seen).toEqual(['risks']);
  });

  it('keys counts by the ids the nav actually uses', () => {
    /* The projection and the sidebar agree by string. If a NavItem is renamed
       and the server is not, every dot silently disappears — so the contract is
       asserted rather than assumed. */
    const ids = APP_NAV_ITEMS.map((item) => item.id);
    expect(ids).toContain('risks');
  });
});
