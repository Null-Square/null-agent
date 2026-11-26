import React from 'react';
import { RefreshCw } from 'lucide-react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * ErrorNotice — what a boundary draws when its subtree has failed.
 *
 * Five boundaries had grown five versions of this: a rounded card with a
 * circular tinted badge on the dashboard, a bordered panel on auth, centred
 * bare text with a `rounded-md` button globally, and two more besides. They
 * are the screens a user only reaches when something is already wrong, which
 * makes them the worst ones to leave looking like a different product — and
 * the least likely to be noticed by anyone reviewing a page that works.
 *
 * One shape: hairlines on black, a signal edge down the left, the kicker in
 * mono, and the verb as the one yellow. No card, no badge, no shadow.
 *
 * The copy rule is the part worth keeping. Say what broke and what the button
 * will do — "We're sorry, but something went wrong. Our team has been
 * notified" tells the reader nothing they can act on and takes three lines to
 * do it. `description` is for the consequence: what is unaffected, or what
 * resetting actually does.
 */

export interface ErrorNoticeProps {
  /** Mono kicker, e.g. "Dashboard error". Names the part that failed. */
  label: string;
  /** One sentence: what broke. */
  title: React.ReactNode;
  /** One sentence: what the action does, or what is unaffected. */
  description?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** Names the part that failed. `threat` by default: something is wrong. */
  icon?: CellIconName;
  /** `page` centres in the viewport, which is what a route-level boundary wants. */
  variant?: 'inline' | 'page';
  className?: string;
}

export const ErrorNotice: React.FC<ErrorNoticeProps> = ({
  label,
  title,
  description,
  actionLabel = 'Reset',
  onAction,
  icon = 'threat',
  variant = 'page',
  className,
}) => {
  const isPage = variant === 'page';

  const notice = (
    <div
      role="alert"
      className={cn(
        'w-full max-w-lg border border-l-2 border-border border-l-warning px-8 py-7',
        isPage && 'text-center',
        className,
      )}
    >
      {/* At page scale the mark leads, the way every other full-page state in
          the app leads with one. Inline, inside a panel that already has a
          heading, an 84px glyph would be the loudest thing on the screen. */}
      {isPage ? <CellIcon name={icon} size={64} className="mx-auto text-foreground/25" /> : null}

      <div
        className={cn(
          'flex items-center gap-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-warning',
          isPage ? 'mt-8 mb-4 justify-center' : 'mb-3',
        )}
      >
        <span aria-hidden className="h-1.5 w-1.5 bg-warning" />
        {label}
      </div>

      <p className="text-[15px] leading-relaxed text-foreground">{title}</p>
      {description ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}

      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-7 inline-flex h-11 items-center justify-center gap-2.5 bg-primary px-6 text-xs font-extrabold uppercase tracking-wider text-primary-foreground transition-opacity hover:opacity-90"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );

  if (variant === 'inline') return notice;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 font-sans">
      {notice}
    </div>
  );
};
