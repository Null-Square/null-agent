/**
 * notificationBroadcaster Unit Tests
 * 
 * Tests the in-memory SSE broadcaster for real-time notifications.
 * This module has no external dependencies, making it easy to test.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotificationType } from '@/domains/platform/notifications/types';
import type { Notification } from '@/domains/platform/notifications/types';

// Create a mock logger that returns itself for child()
const mockChildLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('@/shared/logger', () => ({
  logger: {
    child: () => mockChildLogger,
  },
}));

// Helper to create test notifications
const createNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notif-1',
  userId: 'user-1',
  type: NotificationType.TASK_COMPLETED,
  title: 'Test Title',
  message: 'Test message',
  link: '/session/sess-1',
  data: { sessionId: 'sess-1' },
  read: false,
  createdAt: new Date(),
  deletedAt: null,
  ...overrides,
});

describe('NotificationBroadcaster', () => {
  let notificationBroadcaster: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Import fresh instance for each test
    vi.resetModules();
    const mod = await import('@/app/adapters/notifications/notificationBroadcaster');
    notificationBroadcaster = mod.notificationBroadcaster;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('subscribe', () => {
    it('registers a callback for a user', () => {
      const callback = vi.fn();
      notificationBroadcaster.subscribe('user-1', callback);

      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(true);
      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(1);
    });

    it('allows multiple subscribers for same user (multiple tabs)', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      notificationBroadcaster.subscribe('user-1', callback1);
      notificationBroadcaster.subscribe('user-1', callback2);
      notificationBroadcaster.subscribe('user-1', callback3);

      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(3);
    });

    it('returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = notificationBroadcaster.subscribe('user-1', callback);

      expect(typeof unsubscribe).toBe('function');
      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(1);

      unsubscribe();

      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(0);
      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(false);
    });

    it('removes user entry when last subscriber unsubscribes', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsub1 = notificationBroadcaster.subscribe('user-1', callback1);
      const unsub2 = notificationBroadcaster.subscribe('user-1', callback2);

      unsub1();
      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(1);

      unsub2();
      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(false);
    });

    it('handles unsubscribe called multiple times gracefully', () => {
      const callback = vi.fn();
      const unsubscribe = notificationBroadcaster.subscribe('user-1', callback);

      unsubscribe();
      unsubscribe(); // Should not throw
      unsubscribe(); // Should not throw

      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('calls all subscribers for the target user', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      notificationBroadcaster.subscribe('user-1', callback1);
      notificationBroadcaster.subscribe('user-1', callback2);

      const notification = createNotification();
      notificationBroadcaster.broadcast('user-1', notification);

      expect(callback1).toHaveBeenCalledWith(notification);
      expect(callback2).toHaveBeenCalledWith(notification);
    });

    it('does not call subscribers for other users', () => {
      const user1Callback = vi.fn();
      const user2Callback = vi.fn();

      notificationBroadcaster.subscribe('user-1', user1Callback);
      notificationBroadcaster.subscribe('user-2', user2Callback);

      const notification = createNotification({ userId: 'user-1' });
      notificationBroadcaster.broadcast('user-1', notification);

      expect(user1Callback).toHaveBeenCalledWith(notification);
      expect(user2Callback).not.toHaveBeenCalled();
    });

    it('handles broadcast to user with no subscribers gracefully', () => {
      const notification = createNotification();

      // Should not throw
      expect(() => notificationBroadcaster.broadcast('nonexistent-user', notification)).not.toThrow();
    });

    it('removes callback that throws an error and continues', () => {
      const goodCallback = vi.fn();
      const badCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      notificationBroadcaster.subscribe('user-1', goodCallback);
      notificationBroadcaster.subscribe('user-1', badCallback);

      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(2);

      const notification = createNotification();
      notificationBroadcaster.broadcast('user-1', notification);

      // Good callback should still be called
      expect(goodCallback).toHaveBeenCalledWith(notification);

      // Bad callback should have been removed
      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(1);

      // Second broadcast should only call good callback
      goodCallback.mockClear();
      notificationBroadcaster.broadcast('user-1', notification);
      expect(goodCallback).toHaveBeenCalledTimes(1);
    });

    it('continues to other callbacks when one throws', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn(() => { throw new Error('Error'); });
      const callback3 = vi.fn();

      notificationBroadcaster.subscribe('user-1', callback1);
      notificationBroadcaster.subscribe('user-1', callback2);
      notificationBroadcaster.subscribe('user-1', callback3);

      const notification = createNotification();
      notificationBroadcaster.broadcast('user-1', notification);

      expect(callback1).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();
    });
  });

  describe('hasSubscribers', () => {
    it('returns false for non-existent user', () => {
      expect(notificationBroadcaster.hasSubscribers('nonexistent')).toBe(false);
    });

    it('returns true when user has at least one subscriber', () => {
      notificationBroadcaster.subscribe('user-1', vi.fn());
      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(true);
    });

    it('returns false after all subscribers unsubscribe', () => {
      const unsub = notificationBroadcaster.subscribe('user-1', vi.fn());
      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(true);

      unsub();
      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(false);
    });
  });

  describe('getSubscriberCount', () => {
    it('returns 0 for non-existent user', () => {
      expect(notificationBroadcaster.getSubscriberCount('nonexistent')).toBe(0);
    });

    it('returns correct count for user', () => {
      notificationBroadcaster.subscribe('user-1', vi.fn());
      notificationBroadcaster.subscribe('user-1', vi.fn());
      notificationBroadcaster.subscribe('user-1', vi.fn());

      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(3);
    });
  });

  describe('getTotalSubscribers', () => {
    it('returns 0 when no subscribers', () => {
      expect(notificationBroadcaster.getTotalSubscribers()).toBe(0);
    });

    it('returns total across all users', () => {
      notificationBroadcaster.subscribe('user-1', vi.fn());
      notificationBroadcaster.subscribe('user-1', vi.fn());
      notificationBroadcaster.subscribe('user-2', vi.fn());
      notificationBroadcaster.subscribe('user-3', vi.fn());
      notificationBroadcaster.subscribe('user-3', vi.fn());
      notificationBroadcaster.subscribe('user-3', vi.fn());

      expect(notificationBroadcaster.getTotalSubscribers()).toBe(6);
    });

    it('updates correctly after unsubscribes', () => {
      const unsub1 = notificationBroadcaster.subscribe('user-1', vi.fn());
      const unsub2 = notificationBroadcaster.subscribe('user-2', vi.fn());

      expect(notificationBroadcaster.getTotalSubscribers()).toBe(2);

      unsub1();
      expect(notificationBroadcaster.getTotalSubscribers()).toBe(1);

      unsub2();
      expect(notificationBroadcaster.getTotalSubscribers()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles same callback subscribed multiple times (Set deduplication)', () => {
      const callback = vi.fn();

      // Sets deduplicate same reference
      notificationBroadcaster.subscribe('user-1', callback);
      notificationBroadcaster.subscribe('user-1', callback);

      // Should only be registered once (Set behavior)
      expect(notificationBroadcaster.getSubscriberCount('user-1')).toBe(1);

      const notification = createNotification();
      notificationBroadcaster.broadcast('user-1', notification);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('handles rapid subscribe/unsubscribe cycles', () => {
      for (let i = 0; i < 100; i++) {
        const unsub = notificationBroadcaster.subscribe('user-1', vi.fn());
        unsub();
      }

      expect(notificationBroadcaster.hasSubscribers('user-1')).toBe(false);
      expect(notificationBroadcaster.getTotalSubscribers()).toBe(0);
    });

    it('broadcasts notification with all optional fields', () => {
      const callback = vi.fn();
      notificationBroadcaster.subscribe('user-1', callback);

      const notification = createNotification({
        link: undefined,
        data: undefined,
        deletedAt: new Date(),
      });

      notificationBroadcaster.broadcast('user-1', notification);

      expect(callback).toHaveBeenCalledWith(notification);
    });
  });
});
