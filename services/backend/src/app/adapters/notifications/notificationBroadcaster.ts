/**
 * Notification Broadcaster
 *
 * Real-time notification delivery to connected clients via SSE.
 * Uses a user-keyed pub/sub pattern for broadcasting notifications.
 */

import { logger } from '@/shared/logger';
import type { Notification } from '@/domains/platform/notifications/types';

const log = logger.child({ scope: 'NotificationBroadcaster' });

export interface NotificationEventCallback {
  (notification: Notification): void;
}

/**
 * Broadcaster for real-time notification delivery
 * Allows multiple clients per user (multiple browser tabs)
 */
class NotificationBroadcaster {
  private subscribers: Map<string, Set<NotificationEventCallback>> = new Map();

  /**
   * Subscribe to notifications for a user
   * Returns unsubscribe function
   */
  subscribe(userId: string, callback: NotificationEventCallback): () => void {
    if (!this.subscribers.has(userId)) {
      this.subscribers.set(userId, new Set());
    }
    this.subscribers.get(userId)!.add(callback);

    log.debug({ userId, count: this.subscribers.get(userId)!.size }, 'Client subscribed to notifications');

    return () => {
      const userSubscribers = this.subscribers.get(userId);
      if (userSubscribers) {
        userSubscribers.delete(callback);
        log.debug({ userId, count: userSubscribers.size }, 'Client unsubscribed from notifications');
        if (userSubscribers.size === 0) {
          this.subscribers.delete(userId);
        }
      }
    };
  }

  /**
   * Broadcast a notification to all connected clients for a user
   */
  broadcast(userId: string, notification: Notification): void {
    const userSubscribers = this.subscribers.get(userId);
    if (!userSubscribers || userSubscribers.size === 0) {
      log.debug({ userId }, 'No connected clients for notification broadcast');
      return;
    }

    log.debug(
      { userId, notificationId: notification.id, clientCount: userSubscribers.size },
      'Broadcasting notification',
    );

    for (const callback of userSubscribers) {
      try {
        callback(notification);
      } catch (error) {
        log.error({ err: error, userId }, 'Error in notification broadcast callback');
        userSubscribers.delete(callback);
      }
    }
  }

  /**
   * Check if a user has any connected clients
   */
  hasSubscribers(userId: string): boolean {
    const subs = this.subscribers.get(userId);
    return subs !== undefined && subs.size > 0;
  }

  /**
   * Get count of connected clients for a user
   */
  getSubscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }

  /**
   * Get total connected clients across all users
   */
  getTotalSubscribers(): number {
    let total = 0;
    for (const subs of this.subscribers.values()) {
      total += subs.size;
    }
    return total;
  }
}

export const notificationBroadcaster = new NotificationBroadcaster();
export default notificationBroadcaster;
