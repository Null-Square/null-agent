import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * ListEmptyState — the two empty states, told apart.
 *
 * Brand system, Chapter IV: "Nothing matched is not nothing exists." An empty
 * scope is the win state and says so; an over-filtered list is a dead end whose
 * only job is to offer the way back. Every list page gets both from here rather
 * than inventing a dashed box each time.
 *
 * `icon` names what is missing. The icon doc lists empty states as one of the
 * places a `CellIcon` belongs, and it is the difference between a page that
 * says "nothing here" and one that says *what* is not here — on the one screen
 * where there is no data to say it for you. It is drawn at 40px, well above
 * the doc's 18px floor, because with nothing else on the surface it is the
 * subject rather than a marker.
 *
 * Without one, the generic four-cell mark stands in: an empty state should
 * still look like this system even when its page has no icon of its own.
 *
 * It is not a box. A bordered panel announcing that a list is empty is a card
 * drawn around nothing, and it made "no results" look like a row of data. The
 * state now takes the space the rows would have taken and centres in it, so an
 * empty page reads as empty rather than as a page with one odd item on it.
 * `variant` no longer changes the frame — the difference between "nothing
 * exists" and "nothing matched" is what the words say and whether there is a
 * way back, which is what `onClear` provides. It still picks the icon: an
 * over-filtered list is about the query, so it gets `search` unless the caller
 * names something better.
 */

export interface ListEmptyStateProps {
  variant?: 'empty' | 'filtered';
  /** What is missing — `findings`, `assets`, `runs`. */
  icon?: CellIconName;
  title: string;
  description?: React.ReactNode;
  /** Shown on the `filtered` variant — wires up the "Clear all" button. */
  onClear?: () => void;
  clearLabel?: string;
  /** Anything else to offer (e.g. a primary verb on the `empty` variant). */
  action?: React.ReactNode;
  /**
   * Below the action. For a first-run state, what will fill this page once
   * there is something — the one thing an empty page can usefully say beyond
   * "empty" is what it is going to become.
   */
  footer?: React.ReactNode;
  className?: string;
}

export const ListEmptyState: React.FC<ListEmptyStateProps> = ({
  variant = 'empty',
  icon,
  title,
  description,
  onClear,
  clearLabel = 'Clear all',
  action,
  footer,
  className,
}) => {
  const resolvedIcon = icon ?? (variant === 'filtered' ? 'search' : undefined);

  return (
  <div
    className={cn(
      'flex min-h-[420px] flex-col items-center justify-center px-6 py-24 text-center',
      className,
    )}
  >
    {resolvedIcon ? (
      // Dimmed, because the subject is absent — the outline of the thing that
      // would be here, not an alert that it is not. Large, because on this
      // screen it is the only thing to look at.
      <CellIcon name={resolvedIcon} size={72} className="text-foreground/25" />
    ) : (
      <span aria-hidden className="grid grid-cols-2 gap-[6px]">
        <i className="block h-[18px] w-[18px] bg-foreground/20" />
        <i className="block h-[18px] w-[18px] bg-foreground/8" />
        <i className="block h-[18px] w-[18px] bg-foreground/8" />
        <i className="block h-[18px] w-[18px] bg-foreground/20" />
      </span>
    )}

    <h2 className="mt-9 text-[1.6rem] font-extrabold tracking-[-0.03em] text-foreground">
      {title}
    </h2>
    {description ? (
      <p className="mt-3 max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
        {description}
      </p>
    ) : null}

    {onClear || action ? (
      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        {action}
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="border border-border px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
    ) : null}

      {footer ? <div className="mt-14 w-full max-w-2xl">{footer}</div> : null}
    </div>
  );
};
