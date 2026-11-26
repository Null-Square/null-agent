import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * NotificationList — the notifications dropdown, for any shell.
 *
 * Presentation only: rows, the unread signal bar, the header count and the
 * verbs. It takes already-shaped items rather than a product's `Notification`
 * type, so the app, the demo, and any other service can render the same panel
 * from whatever they have.
 *
 * The glyph names the PLACE a notification is about, which is what `CellIcon`
 * is for. Deciding which place is product semantics, so the caller picks it;
 * only the drawing lives here.
 */

export interface NotificationListItem {
  id: string;
  title: React.ReactNode;
  message?: React.ReactNode;
  /** Already formatted — locale and relative-time rules are the caller's. */
  timestamp?: React.ReactNode;
  read?: boolean;
  icon?: CellIconName;
  /** Tone for the glyph, e.g. `text-success`. Bone when omitted. */
  iconClassName?: string;
}

export interface NotificationListProps {
  items: NotificationListItem[];
  unreadCount: number;
  isLoading?: boolean;
  hasError?: boolean;
  markAllPending?: boolean;
  /** Omit to render rows that are not selectable. */
  onSelect?: (item: NotificationListItem) => void;
  onDismiss?: (event: React.MouseEvent, id: string) => void;
  onMarkAllRead?: () => void;
  onClose?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  errorMessage?: string;
  className?: string;
}

export const NotificationList: React.FC<NotificationListProps> = ({
  items,
  unreadCount,
  isLoading = false,
  hasError = false,
  markAllPending = false,
  onSelect,
  onDismiss,
  onMarkAllRead,
  onClose,
  emptyTitle = 'Nothing waiting',
  emptyDescription = 'You are caught up on this organization.',
  errorMessage = 'Notifications could not be loaded.',
  className,
}) => (
  <div
    className={cn(
      'flex w-[min(420px,calc(100vw-1.5rem))] flex-col bg-background font-sans',
      className,
    )}
  >
    <div className="flex items-center justify-between border-b border-border p-6">
      <div className="flex items-center gap-3">
        <div className="relative text-foreground">
          <CellIcon name="notifications" size={16} />
          {/* The square mark means live: something is waiting for you. */}
          {unreadCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 bg-primary" aria-hidden />
          ) : null}
        </div>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
          Notifications
        </span>
        {unreadCount > 0 ? (
          <span className="bg-border px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground/85">
            {unreadCount}
          </span>
        ) : null}
      </div>
      {unreadCount > 0 && onMarkAllRead ? (
        <button
          type="button"
          onClick={onMarkAllRead}
          disabled={markAllPending}
          className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="flex-none">
            <path
              d="M3 8.5 L6.5 12 L13 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="square"
            />
          </svg>
          Clear all
        </button>
      ) : null}
    </div>

    <div className="scrollbar-slim max-h-[460px] overflow-y-auto">
      {isLoading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
          <span className="ns-live-mark" aria-hidden />
          Loading notifications
        </div>
      ) : hasError ? (
        <div className="border-l-2 border-destructive px-6 py-8 text-sm text-muted-foreground">
          {errorMessage}
        </div>
      ) : items.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <p className="text-sm font-semibold text-foreground">{emptyTitle}</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">{emptyDescription}</p>
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={onSelect ? `Open notification: ${String(item.title)}` : undefined}
            onClick={onSelect ? () => onSelect(item) : undefined}
            onKeyDown={
              onSelect
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(item);
                    }
                  }
                : undefined
            }
            className={cn(
              'group relative flex gap-5 border-b border-border p-6 transition-colors last:border-b-0',
              onSelect && 'cursor-pointer',
              item.read ? 'opacity-60 hover:opacity-100' : 'bg-foreground/[0.02]',
              'hover:bg-foreground/[0.02] focus-visible:bg-foreground/[0.02] focus-visible:outline-none',
            )}
          >
            {!item.read ? (
              <span className="absolute bottom-0 left-0 top-0 w-[2px] bg-primary" aria-hidden />
            ) : null}

            {/* Raw glyph: an icon chip would be a surface inside a surface, and
                the 18px box aligns to the title's cap height. */}
            <div className={cn('flex-none pt-[3px]', item.iconClassName ?? 'text-muted-foreground')}>
              <CellIcon name={item.icon ?? 'notifications'} size={18} />
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-3">
                <h4
                  className={cn(
                    'text-[14.5px] font-semibold leading-[1.4] tracking-[-0.01em]',
                    item.read ? 'text-foreground/70' : 'text-foreground',
                  )}
                >
                  {item.title}
                </h4>
                {onDismiss ? (
                  <button
                    type="button"
                    onClick={(event) => onDismiss(event, item.id)}
                    className="-mr-1 -mt-1 flex-none p-1.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    title="Dismiss"
                    aria-label={`Dismiss notification: ${String(item.title)}`}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path
                        d="M4 4 L12 12 M12 4 L4 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="square"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>
              {item.message ? (
                <p className="text-[13.5px] leading-[1.5] text-muted-foreground">{item.message}</p>
              ) : null}
              {item.timestamp ? (
                <span className="mt-2 font-mono text-[11px] text-muted-foreground/60">
                  {item.timestamp}
                </span>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>

    {onClose ? (
      <button
        type="button"
        onClick={onClose}
        className="w-full border-t border-border p-5 text-center font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground"
      >
        Close panel
      </button>
    ) : null}
  </div>
);
