/**
 * NotificationPanel — the app's notifications dropdown.
 *
 * Data and mutations only. The markup is the shared `NotificationList`, and the
 * product semantics (which glyph, how the age reads) are in
 * `notificationPresentation`, so the demo panel renders the identical thing.
 */

import { useNavigate } from 'react-router-dom';
import { NotificationList } from '@null-ai/design-tokens/ui';

import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
} from '../hooks/useNotifications';
import { resolveNotificationLink } from '../lib/resolveNotificationLink';
import { toNotificationListItem } from '../lib/notificationPresentation';

interface NotificationPanelProps {
  onClose: () => void;
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useNotifications({ limit: 20 });
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const deleteNotification = useDeleteNotification();

  const notifications = data?.notifications ?? [];

  return (
    <NotificationList
      items={notifications.map(toNotificationListItem)}
      unreadCount={data?.unreadCount ?? 0}
      isLoading={isLoading}
      hasError={Boolean(error)}
      markAllPending={markAllAsRead.isPending}
      onSelect={(item) => {
        const notification = notifications.find((entry) => entry.id === item.id);
        if (!notification) return;

        if (!notification.read) {
          markAsRead.mutate(notification.id);
        }

        const nextLink = resolveNotificationLink(notification);
        if (nextLink) {
          navigate(nextLink);
          onClose();
        }
      }}
      onDismiss={(event, id) => {
        event.stopPropagation();
        deleteNotification.mutate(id);
      }}
      onMarkAllRead={() => markAllAsRead.mutate()}
      onClose={onClose}
    />
  );
}
