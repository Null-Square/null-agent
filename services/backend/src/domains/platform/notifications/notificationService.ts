/**
 * Notification Service
 *
 * The in-app inbox, and its only writer. Null AI tells its one person what happened on this
 * computer through this feed and the live stream that carries it; nothing is sent by email or push.
 */

import * as notificationRepository from '@/domains/platform/notifications/notificationRepository';
import { NotificationType } from './types';
import type {
  Notification,
  NotificationListOptions,
  NotificationListResult,
} from './types';
import { notificationBroadcaster } from '@/app/adapters/notifications/notificationBroadcaster';
import { logger } from '@/shared/logger';

export type InAppNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  data?: Record<string, unknown>;
  /** One notification per key and user: a repeated event does not notify twice. */
  dedupeKey?: string;
};

/**
 * Record an in-app notification and push it to the user's open streams.
 * Returns null when a notification with the same dedupe key already exists.
 */
export async function notifyInApp(input: InAppNotificationInput): Promise<Notification | null> {
  if (input.dedupeKey && await notificationRepository.existsWithDedupeKey(input.userId, input.dedupeKey)) {
    return null;
  }
  const notification = await notificationRepository.create({
    userId: input.userId,
    type: input.type,
    title: input.title,
    message: input.message,
    link: input.link ?? null,
    data: input.dedupeKey ? { ...(input.data ?? {}), dedupeKey: input.dedupeKey } : input.data,
  });
  notificationBroadcaster.broadcast(input.userId, notification);
  return notification;
}

export type AppNotificationKind =
  | 'task_completed'
  | 'action_required'
  | 'credits_low'
  | 'session_error'
  | 'threat_watch_exposure';

const APP_NOTIFICATION_TYPES: Record<AppNotificationKind, NotificationType> = {
  task_completed: NotificationType.TASK_COMPLETED,
  action_required: NotificationType.ACTION_REQUIRED,
  credits_low: NotificationType.CREDITS_LOW,
  session_error: NotificationType.SESSION_ERROR,
  threat_watch_exposure: NotificationType.SYSTEM,
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Tell the user about something the agent did: a run finished, needs them, or failed, or Threat
 * Watch found an exposure. One notification per run (or session) and reason, or per exposure.
 */
export async function notifyAppEvent(input: {
  userId: string;
  type: AppNotificationKind;
  title: string;
  message: string;
  link?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const data = input.data ?? {};
  const reason = readString(data.reason) ?? readString(data.destination) ?? input.type;
  const runId = readString(data.runId);
  const sessionId = readString(data.sessionId);
  const exposureMatchId = readString(data.exposureMatchId);
  const dedupeKey = runId
    ? `${input.type}:run:${runId}:reason:${reason}`
    : sessionId
      ? `${input.type}:session:${sessionId}:reason:${reason}`
      : exposureMatchId
        ? `${input.type}:exposure:${exposureMatchId}`
        : undefined;
  await notifyInApp({
    userId: input.userId,
    type: APP_NOTIFICATION_TYPES[input.type],
    title: input.title,
    message: input.message,
    link: input.link ?? null,
    data,
    dedupeKey,
  });
}

/**
 * Get notifications for a user
 */
export async function getNotifications(
  userId: string,
  options?: NotificationListOptions
): Promise<NotificationListResult> {
  return notificationRepository.listByUser(userId, options);
}

/**
 * Get unread count for badge
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return notificationRepository.getUnreadCount(userId);
}

/**
 * Mark a notification as read
 */
export async function markAsRead(id: string, userId: string): Promise<boolean> {
  const success = await notificationRepository.markRead(id, userId);
  if (success) {
    logger.debug({ id, userId }, '[NotificationService] Marked notification as read');
  }
  return success;
}

/**
 * Mark all notifications as read
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const count = await notificationRepository.markAllRead(userId);
  logger.info({ userId, count }, '[NotificationService] Marked all notifications as read');
  return count;
}

/**
 * Delete a notification
 */
export async function deleteNotification(id: string, userId: string): Promise<boolean> {
  const success = await notificationRepository.deleteNotification(id, userId);
  if (success) {
    logger.debug({ id, userId }, '[NotificationService] Deleted notification');
  }
  return success;
}

/**
 * Get a single notification
 */
export async function getNotification(id: string, userId: string): Promise<Notification | null> {
  return notificationRepository.getById(id, userId);
}

// Re-export types for convenience
export { NotificationType };
export type { Notification, NotificationListResult } from './types';
