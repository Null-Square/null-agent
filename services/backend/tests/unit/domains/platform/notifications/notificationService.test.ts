import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
/**
 * NotificationService Unit Tests
 * 
 * Tests the notification service business logic.
 */

import { NotificationType } from '@/domains/platform/notifications/types';

const mockRepo = vi.hoisted(() => ({
  create: vi.fn(),
  listByUser: vi.fn(),
  getUnreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  deleteNotification: vi.fn(),
  getById: vi.fn(),
})) as {
  create: Mock;
  listByUser: Mock;
  getUnreadCount: Mock;
  markRead: Mock;
  markAllRead: Mock;
  deleteNotification: Mock;
  getById: Mock;
};

vi.mock('@/domains/platform/notifications/notificationRepository', () => mockRepo);

describe('NotificationService', () => {
  let notificationService: typeof import('@/domains/platform/notifications/notificationService');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    notificationService = await import('@/domains/platform/notifications/notificationService');
  });

  describe('getNotifications', () => {
    const userId = 'user-123';

    it('returns notifications list', async () => {
      const mockResult = {
        notifications: [
          { id: 'n1', userId, type: NotificationType.SYSTEM, title: 'A', message: 'B', link: null, read: false, createdAt: new Date() },
        ],
        total: 1,
        unreadCount: 1,
      };
      mockRepo.listByUser.mockResolvedValue(mockResult);

      const result = await notificationService.getNotifications(userId);

      expect(mockRepo.listByUser).toHaveBeenCalled();
      expect(result.notifications).toHaveLength(1);
    });
  });

  describe('getUnreadCount', () => {
    it('returns unread count', async () => {
      mockRepo.getUnreadCount.mockResolvedValue(5);

      const result = await notificationService.getUnreadCount('user-123');

      expect(result).toBe(5);
    });
  });

  describe('markAsRead', () => {
    it('returns true when marked', async () => {
      mockRepo.markRead.mockResolvedValue(true);

      const result = await notificationService.markAsRead('notif-1', 'user-123');

      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      mockRepo.markRead.mockResolvedValue(false);

      const result = await notificationService.markAsRead('notif-999', 'user-123');

      expect(result).toBe(false);
    });
  });

  describe('markAllAsRead', () => {
    it('returns count of marked', async () => {
      mockRepo.markAllRead.mockResolvedValue(3);

      const result = await notificationService.markAllAsRead('user-123');

      expect(result).toBe(3);
    });
  });

  describe('deleteNotification', () => {
    it('returns true when deleted', async () => {
      mockRepo.deleteNotification.mockResolvedValue(true);

      const result = await notificationService.deleteNotification('notif-1', 'user-123');

      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      mockRepo.deleteNotification.mockResolvedValue(false);

      const result = await notificationService.deleteNotification('notif-999', 'user-123');

      expect(result).toBe(false);
    });
  });

  describe('getNotification', () => {
    it('returns notification when found', async () => {
      const mockNotification = {
        id: 'notif-1',
        userId: 'user-123',
        type: NotificationType.SYSTEM,
        title: 'Test',
        message: 'Message',
        link: null,
        read: false,
        createdAt: new Date(),
      };
      mockRepo.getById.mockResolvedValue(mockNotification);

      const result = await notificationService.getNotification('notif-1', 'user-123');

      expect(result).toEqual(mockNotification);
    });

    it('returns null when not found', async () => {
      mockRepo.getById.mockResolvedValue(null);

      const result = await notificationService.getNotification('notif-999', 'user-123');

      expect(result).toBeNull();
    });
  });
});




