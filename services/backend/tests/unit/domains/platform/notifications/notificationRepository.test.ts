import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  randomUUID: vi.fn(),
}));

let repo: typeof import('@/domains/platform/notifications/notificationRepository');
let NotificationType: typeof import('@/domains/platform/notifications/types').NotificationType;

describe('notificationRepository', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.query.mockReset();
    mocks.randomUUID.mockReturnValue('notif-1');
    vi.doMock('@/db/client', () => ({
      getPool: () => ({ query: mocks.query }),
    }));
    vi.doMock('crypto', () => ({ randomUUID: mocks.randomUUID }));
    repo = await import('@/domains/platform/notifications/notificationRepository');
    ({ NotificationType } = await import('@/domains/platform/notifications/types'));
  });

  it('creates notifications with defaults', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await repo.create({
      userId: 'user-1',
      type: NotificationType.SYSTEM,
      title: 'Hello',
      message: 'World',
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'notif-1',
        userId: 'user-1',
        read: false,
      }),
    );
    expect(mocks.query.mock.calls[0][0]).toContain('INSERT INTO notifications');
  });

  it('lists notifications with unread filters', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'notif-1',
            user_id: 'user-1',
            type: 'info',
            title: 'Hello',
            message: 'World',
            link: null,
            data: null,
            read: false,
            created_at: now,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });

    const result = await repo.listByUser('user-1', { unreadOnly: true, limit: 5, offset: 0 });

    expect(mocks.query.mock.calls[0][0]).toContain('read = false');
    expect(result.total).toBe(5);
    expect(result.unreadCount).toBe(2);
    expect(result.notifications[0].id).toBe('notif-1');
  });

  it('lists notifications without unread filter', async () => {
    const now = new Date('2025-01-02T00:00:00Z');
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'notif-2',
            user_id: 'user-1',
            type: NotificationType.SYSTEM,
            title: 'Hello',
            message: 'World',
            link: null,
            data: { k: 'v' },
            read: true,
            created_at: now,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await repo.listByUser('user-1', { unreadOnly: false, limit: 10, offset: 5 });

    expect(mocks.query.mock.calls[0][0]).not.toContain('read = false');
    expect(mocks.query.mock.calls[0][1]).toEqual(['user-1', 10, 5]);
    expect(result.notifications[0].data).toEqual({ k: 'v' });
  });

  it('returns unread count', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });

    const result = await repo.getUnreadCount('user-1');

    expect(result).toBe(4);
    expect(mocks.query.mock.calls[0][0]).toContain('read = false');
  });

  it('marks a notification as read', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.markRead('notif-1', 'user-1');

    expect(result).toBe(true);
  });

  it('marks all notifications as read', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 3 });

    const result = await repo.markAllRead('user-1');

    expect(result).toBe(3);
  });

  it('soft deletes notifications', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.deleteNotification('notif-1', 'user-1');

    expect(result).toBe(true);
  });

  it('returns null when notification not found', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await repo.getById('missing', 'user-1');

    expect(result).toBeNull();
  });

  it('returns notification when found', async () => {
    const now = new Date('2025-01-03T00:00:00Z');
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'notif-3',
          user_id: 'user-1',
          type: NotificationType.SYSTEM,
          title: 'Notice',
          message: 'Message',
          link: '/link',
          data: { foo: 'bar' },
          read: false,
          created_at: now,
        },
      ],
    });

    const result = await repo.getById('notif-3', 'user-1');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'notif-3',
        userId: 'user-1',
        link: '/link',
        data: { foo: 'bar' },
        createdAt: now,
      }),
    );
  });
});
