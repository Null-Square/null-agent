/**
 * useNotifications Hook
 * 
 * React Query hooks for notification data with optimistic updates.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as notificationsApi from '../api/notifications';
import type { Notification, NotificationListResult } from '../api/notifications';

/** Query keys for notifications */
export const notificationKeys = {
  all: ['notifications'] as const,
  list: () => [...notificationKeys.all, 'list'] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
};

/**
 * Fetch notifications list
 * Default: returns all (read + unread) with limit 20
 * Auto-refetches every 30 seconds and on window focus
 */
export function useNotifications(options?: { unreadOnly?: boolean; limit?: number; enabled?: boolean }) {
  return useQuery({
    queryKey: [...notificationKeys.list(), options],
    queryFn: () => notificationsApi.getNotifications(options),
    enabled: options?.enabled ?? true,
    staleTime: 30_000, // 30 seconds
    refetchOnWindowFocus: true,
    refetchInterval: 30_000, // Auto-refetch every 30s
  });
}

/**
 * Fetch unread count for badge
 * Auto-refetches every 30 seconds and on window focus
 */
export function useUnreadCount(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: notificationsApi.getUnreadCount,
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}

/**
 * Mark a notification as read - with optimistic update
 */
export function useMarkAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: notificationsApi.markAsRead,
    // Optimistic update - instant UI response
    onMutate: async (id: string) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });

      // Snapshot previous values
      const previousData = queryClient.getQueriesData({ queryKey: notificationKeys.list() });
      const previousCount = queryClient.getQueryData<number>(notificationKeys.unreadCount());

      // Optimistically update the list
      queryClient.setQueriesData(
        { queryKey: notificationKeys.list() },
        (old: NotificationListResult | undefined) => {
          if (!old) return old;
          return {
            ...old,
            notifications: old.notifications.map((n: Notification) =>
              n.id === id ? { ...n, read: true } : n
            ),
            unreadCount: Math.max(0, old.unreadCount - 1),
          };
        }
      );

      // Optimistically update the count
      queryClient.setQueryData(notificationKeys.unreadCount(), (old: number | undefined) =>
        old !== undefined ? Math.max(0, old - 1) : old
      );

      return { previousData, previousCount };
    },
    // Rollback on error
    onError: (_err, _id, context) => {
      if (context?.previousData) {
        context.previousData.forEach(([queryKey, data]) => {
          queryClient.setQueryData(queryKey, data);
        });
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(notificationKeys.unreadCount(), context.previousCount);
      }
    },
    // Refetch after mutation settles
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/**
 * Mark all notifications as read
 */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: notificationsApi.markAllAsRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });

      const previousData = queryClient.getQueriesData({ queryKey: notificationKeys.list() });

      // Optimistically mark all as read
      queryClient.setQueriesData(
        { queryKey: notificationKeys.list() },
        (old: NotificationListResult | undefined) => {
          if (!old) return old;
          return {
            ...old,
            notifications: old.notifications.map((n: Notification) => ({ ...n, read: true })),
            unreadCount: 0,
          };
        }
      );

      queryClient.setQueryData(notificationKeys.unreadCount(), 0);

      return { previousData };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        context.previousData.forEach(([queryKey, data]) => {
          queryClient.setQueryData(queryKey, data);
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/**
 * Delete a notification
 */
export function useDeleteNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: notificationsApi.deleteNotification,
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });

      const previousData = queryClient.getQueriesData({ queryKey: notificationKeys.list() });

      // Optimistically remove the notification
      queryClient.setQueriesData(
        { queryKey: notificationKeys.list() },
        (old: NotificationListResult | undefined) => {
          if (!old) return old;
          const notification = old.notifications.find((n: Notification) => n.id === id);
          const wasUnread = notification && !notification.read;
          return {
            ...old,
            notifications: old.notifications.filter((n: Notification) => n.id !== id),
            total: old.total - 1,
            unreadCount: wasUnread ? old.unreadCount - 1 : old.unreadCount,
          };
        }
      );

      return { previousData };
    },
    onError: (_err, _id, context) => {
      if (context?.previousData) {
        context.previousData.forEach(([queryKey, data]) => {
          queryClient.setQueryData(queryKey, data);
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
