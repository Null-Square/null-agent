/**
 * Notifications API
 * 
 * Client for notification endpoints.
 */

import { authenticatedFetch } from '@shared/api';

export interface Notification {
  id: string;
  userId: string;
  type: 'task_completed' | 'action_required' | 'credits_low' | 'session_error' | 'system';
  title: string;
  message: string;
  link?: string | null;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface NotificationListResult {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}

export interface NotificationsListOptions {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Fetch notifications for current user
 */
export async function getNotifications(options?: NotificationsListOptions): Promise<NotificationListResult> {
  const params = new URLSearchParams();
  if (options?.unreadOnly) params.set('unreadOnly', 'true');
  if (options?.limit) params.set('limit', options.limit.toString());
  if (options?.offset) params.set('offset', options.offset.toString());

  const query = params.toString();
  return authenticatedFetch<NotificationListResult>(`/api/notifications${query ? `?${query}` : ''}`);
}

/**
 * Get unread count for badge
 */
export async function getUnreadCount(): Promise<number> {
  const data = await authenticatedFetch<{ count: number }>('/api/notifications/unread-count');
  return data.count;
}

/**
 * Mark a notification as read
 */
export async function markAsRead(id: string): Promise<void> {
  await authenticatedFetch(`/api/notifications/${id}/read`, {
    method: 'PATCH',
  });
}

/**
 * Mark all notifications as read
 */
export async function markAllAsRead(): Promise<number> {
  const data = await authenticatedFetch<{ count: number }>('/api/notifications/mark-all-read', {
    method: 'POST',
  });
  return data.count;
}

/**
 * Delete a notification
 */
export async function deleteNotification(id: string): Promise<void> {
  await authenticatedFetch(`/api/notifications/${id}`, {
    method: 'DELETE',
  });
}
