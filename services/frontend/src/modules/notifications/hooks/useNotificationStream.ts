/**
 * Keeps the notification bell current from the server-sent-events stream.
 *
 * The socket itself belongs to `shared/lib/liveEventStream` — this hook owns
 * only what a notification means for the cache. See that module for why the
 * connection is not held in component state.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notificationKeys } from './useNotifications';
import type { Notification, NotificationListResult } from '../api/notifications';
import { subscribeToStream } from '@/shared/lib/liveEventStream';

interface UseNotificationStreamOptions {
  /** Whether to connect to the stream (default: true) */
  enabled?: boolean;
  /** Called when a new notification arrives */
  onNotification?: (notification: Notification) => void;
}

export function useNotificationStream(options: UseNotificationStreamOptions = {}): void {
  const { enabled = true, onNotification } = options;
  const queryClient = useQueryClient();

  /* Held in a ref so an inline callback — the ordinary way to pass one — does
     not change the effect's identity and re-subscribe on every render. */
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  useEffect(() => {
    if (!enabled) return undefined;

    return subscribeToStream('notification', (data) => {
      const notification = data as Notification;

      queryClient.setQueriesData(
        { queryKey: notificationKeys.list() },
        (old: NotificationListResult | undefined) => {
          if (!old) return old;

          // The same notification can arrive twice across a reconnect.
          const exists = old.notifications.some((n) => n.id === notification.id);
          if (exists) return old;

          return {
            ...old,
            notifications: [notification, ...old.notifications],
            total: old.total + 1,
            unreadCount: old.unreadCount + 1,
          };
        },
      );

      queryClient.setQueryData(
        notificationKeys.unreadCount(),
        (old: number | undefined) => (old ?? 0) + 1,
      );

      onNotificationRef.current?.(notification);
    });
  }, [enabled, queryClient]);
}

export default useNotificationStream;
