import React from 'react';

import { cn } from '../cn';

/**
 * StackList — the one narrow list.
 *
 * `RecordTable` is the one data table: columns, headers, a grid. In a 400px
 * panel or a centred column there are no columns, and the same shape kept being
 * hand-rolled instead — a small label, then rows of title over subtitle,
 * sometimes a signal bar, sometimes a trailing timestamp, sometimes actions on
 * hover. It was written four separate times across the assistant panel and the
 * chat page before this existed.
 *
 * Rows are separated by a seam and open at every other edge: the surface around
 * them is already a surface, so a bordered, tinted card holding a list of rows
 * is a card inside a card.
 */

export interface StackListRow {
  key: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Draws the 2px signal bar down the row's leading edge. */
  signal?: 'none' | 'primary' | 'destructive';
  /** Real data pinned to the trailing edge — a timestamp, a count. */
  meta?: React.ReactNode;
  /** Revealed on hover and focus, like the notification and history rows. */
  actions?: React.ReactNode;
  onSelect?: () => void;
  /** Replaces the row entirely — used for inline edit states. */
  render?: React.ReactNode;
}

export interface StackListProps {
  /** The section label. Say what the group is; do not explain the label. */
  label?: React.ReactNode;
  rows: StackListRow[];
  /** Shown in place of the rows while data is loading. */
  loadingLabel?: string;
  isLoading?: boolean;
  className?: string;
}

const SIGNAL_CLASS: Record<NonNullable<StackListRow['signal']>, string> = {
  none: '',
  primary: 'bg-primary',
  destructive: 'bg-destructive',
};

export const StackList: React.FC<StackListProps> = ({
  label,
  rows,
  loadingLabel = 'Loading',
  isLoading = false,
  className,
}) => (
  <section className={cn('w-full', className)}>
    {label ? (
      <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </h2>
    ) : null}

    {isLoading ? (
      <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        <span className="ns-live-mark" aria-hidden />
        {loadingLabel}
      </div>
    ) : (
      rows.map((row) =>
        row.render ? (
          <div key={row.key} className="border-b border-border py-4 last:border-b-0">
            {row.render}
          </div>
        ) : (
          <div
            key={row.key}
            className="group/row relative flex items-start gap-4 border-b border-border py-4 last:border-b-0"
          >
            {row.signal && row.signal !== 'none' ? (
              <span
                className={cn('absolute bottom-0 left-0 top-0 w-[2px]', SIGNAL_CLASS[row.signal])}
                aria-hidden
              />
            ) : null}

            {row.onSelect ? (
              <button type="button" onClick={row.onSelect} className="min-w-0 flex-1 text-left">
                <div className="font-sans text-[13.5px] font-semibold leading-snug text-foreground">
                  {row.title}
                </div>
                {row.subtitle ? (
                  <div className="mt-1 font-sans text-[13px] leading-relaxed text-muted-foreground">
                    {row.subtitle}
                  </div>
                ) : null}
              </button>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="font-sans text-[13.5px] font-semibold leading-snug text-foreground">
                  {row.title}
                </div>
                {row.subtitle ? (
                  <div className="mt-1 font-sans text-[13px] leading-relaxed text-muted-foreground">
                    {row.subtitle}
                  </div>
                ) : null}
              </div>
            )}

            {row.meta ? (
              <span className="flex-none font-mono text-[12px] text-muted-foreground/60">
                {row.meta}
              </span>
            ) : null}

            {row.actions ? (
              <div className="flex flex-none items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                {row.actions}
              </div>
            ) : null}
          </div>
        ),
      )
    )}
  </section>
);
