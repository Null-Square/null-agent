import { describe, expect, it } from 'vitest';

import { resolveNotificationLink } from './resolveNotificationLink';
import type { Notification } from '../api/notifications';

const baseNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notification-1',
  userId: 'user-1',
  type: 'action_required',
  title: 'Action Required',
  message: 'Review this item.',
  link: null,
  data: undefined,
  read: false,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('resolveNotificationLink', () => {
  it('uses explicit run detail destination from notification data', () => {
    const link = resolveNotificationLink(
      baseNotification({
        type: 'action_required',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          destination: 'run_detail',
        },
      }),
    );

    expect(link).toBe('/runs/run-1');
  });

  it('rewrites legacy session links to run workbench when run context is available', () => {
    const link = resolveNotificationLink(
      baseNotification({
        link: '/session/session-22',
        data: {
          runId: 'run-22',
          sessionId: 'session-22',
        },
      }),
    );

    expect(link).toBe('/runs/run-22/workbench?session=session-22');
  });

  it('rewrites legacy task completion session links to the run detail page', () => {
    const link = resolveNotificationLink(
      baseNotification({
        type: 'task_completed',
        link: '/sessions/session-99',
        data: {
          runId: 'run-99',
        },
      }),
    );

    expect(link).toBe('/runs/run-99');
  });
});
