import { describe, expect, it, vi } from 'vitest';
import {
  deleteNotification,
  getNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from './notifications';
import { authenticatedFetch } from '@shared/api';

vi.mock('@shared/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

describe('notifications API', () => {
  it('fetches notifications with query params', async () => {
    mockAuthenticatedFetch.mockResolvedValue({
      notifications: [],
      total: 0,
      unreadCount: 0,
    });

    await getNotifications({ unreadOnly: true, limit: 10, offset: 5 });

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith(
      '/api/notifications?unreadOnly=true&limit=10&offset=5',
    );
  });

  it('fetches unread count and marks as read', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({ count: 3 });
    expect(await getUnreadCount()).toBe(3);

    mockAuthenticatedFetch.mockResolvedValueOnce(undefined);
    await markAsRead('n1');
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/notifications/n1/read', {
      method: 'PATCH',
    });
  });

  it('marks all as read and deletes notifications', async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce({ count: 5 });
    expect(await markAllAsRead()).toBe(5);

    mockAuthenticatedFetch.mockResolvedValueOnce(undefined);
    await deleteNotification('n2');
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/notifications/n2', {
      method: 'DELETE',
    });
  });

  it('throws when API returns an error', async () => {
    mockAuthenticatedFetch.mockRejectedValueOnce(new Error('fail'));
    await expect(getUnreadCount()).rejects.toThrow('fail');
  });
});
