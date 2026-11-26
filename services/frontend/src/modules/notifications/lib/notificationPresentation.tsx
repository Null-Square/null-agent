import type { CellIconName, NotificationListItem } from '@null-ai/design-tokens/ui';

import type { Notification } from '../api/notifications';

/**
 * Product semantics for a notification: which place it is about, and how its
 * age reads. The drawing lives in the shared `NotificationList`; this is the
 * part that is ours, and both the app and the demo panel use it so the two
 * shells cannot disagree about what a notification looks like.
 *
 * Signal yellow means "this one needs you"; success is the only green; the rest
 * are bone. No blues, no ambers, no emeralds.
 */
const TYPE_CONFIG: Record<string, { icon: CellIconName; className: string }> = {
  action_required: { icon: 'findings', className: 'text-primary' },
  task_completed: { icon: 'runs', className: 'text-success' },
  credits_low: { icon: 'billing', className: 'text-warning' },
  session_error: { icon: 'workbench', className: 'text-destructive' },
  system: { icon: 'settings', className: 'text-muted-foreground' },
};

export const formatNotificationDate = (dateStr: string) => {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

export const toNotificationListItem = (notification: Notification): NotificationListItem => {
  const config = TYPE_CONFIG[notification.type] ?? {
    icon: 'notifications' as CellIconName,
    className: 'text-muted-foreground',
  };

  return {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    timestamp: formatNotificationDate(notification.createdAt),
    read: notification.read,
    icon: config.icon,
    iconClassName: config.className,
  };
};
