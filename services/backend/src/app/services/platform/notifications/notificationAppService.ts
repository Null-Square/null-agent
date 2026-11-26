import type {
  Notification,
  NotificationListOptions,
  NotificationListResult,
} from '@/domains/platform/notifications/types';
import * as notificationService from '@/domains/platform/notifications/notificationService';
import {
  notificationBroadcaster,
  type NotificationEventCallback,
} from '@/app/adapters/notifications/notificationBroadcaster';

export type NotificationAppService = {
  getNotifications: (userId: string, options?: NotificationListOptions) => Promise<NotificationListResult>;
  getUnreadCount: (userId: string) => Promise<number>;
  markAsRead: (id: string, userId: string) => Promise<boolean>;
  markAllAsRead: (userId: string) => Promise<number>;
  deleteNotification: (id: string, userId: string) => Promise<boolean>;
  getNotification: (id: string, userId: string) => Promise<Notification | null>;
  subscribe: (userId: string, callback: NotificationEventCallback) => () => void;
};

type NotificationAppServiceDeps = {
  broadcaster?: typeof notificationBroadcaster;
  notification?: typeof notificationService;
};

export const createNotificationAppService = (
  deps: NotificationAppServiceDeps = {},
): NotificationAppService => {
  const broadcaster = deps.broadcaster ?? notificationBroadcaster;
  const notifications = deps.notification ?? notificationService;

  return {
    getNotifications: notifications.getNotifications,
    getUnreadCount: notifications.getUnreadCount,
    markAsRead: notifications.markAsRead,
    markAllAsRead: notifications.markAllAsRead,
    deleteNotification: notifications.deleteNotification,
    getNotification: notifications.getNotification,
    subscribe: (userId, callback) => broadcaster.subscribe(userId, callback),
  };
};

export const notificationAppService = createNotificationAppService();

export { NotificationType } from '@/domains/platform/notifications/types';
export type {
  Notification,
  NotificationListOptions,
  NotificationListResult,
} from '@/domains/platform/notifications/types';
