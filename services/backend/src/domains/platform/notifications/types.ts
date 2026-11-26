/**
 * Notification Types
 * 
 * Core types for the notification system.
 */

export enum NotificationType {
  /** Automated task or session completed */
  TASK_COMPLETED = 'task_completed',
  /** Agent needs user input/approval */
  ACTION_REQUIRED = 'action_required',
  /** User credits running low */
  CREDITS_LOW = 'credits_low',
  /** Session encountered an error */
  SESSION_ERROR = 'session_error',
  /** General system notification */
  SYSTEM = 'system',
  /** Support ticket notification */
  SUPPORT = 'support',
  /** Payment failure notification */
  PAYMENT_FAILED = 'payment_failed',
  /** New user signup notification */
  USER_SIGNUP = 'user_signup',
  /** Warning notification */
  WARNING = 'warning',
  /** Alert/error notification */
  ALERT = 'alert',
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  /** Direct link to related resource (e.g., /sessions/abc123) */
  link?: string | null;
  /** Additional context data */
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
  deletedAt?: Date | null;
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  data?: Record<string, unknown>;
}

export interface NotificationListOptions {
  /** Filter by read status. Defaults to unread only. */
  unreadOnly?: boolean;
  /** Max items to return. Defaults to 20. */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface NotificationListResult {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}
