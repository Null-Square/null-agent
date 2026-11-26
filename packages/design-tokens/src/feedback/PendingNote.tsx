import React from 'react';

import { cn } from '../cn';

/**
 * PendingNote — waiting, when there is no list to draw a skeleton of.
 *
 * `ListSkeleton` covers a table that is about to arrive. This covers everything
 * else: a page resolving its session, a button mid-request, a panel fetching
 * one number. Between them there is no case left that needs a spinner, and
 * the brand allows exactly one animation — `ns-blink`, the discrete flicker —
 * so a rotating ring is not a styling choice here, it is the one motion the
 * system rules out.
 *
 * The copy rule is `ListSkeleton`'s: **name the act, not the state.** "Reading
 * your invoices" says what is happening and roughly how long it should take;
 * "Loading..." says only that the page is not the page yet. The label is
 * required for that reason — there is no default.
 *
 * `page` centres it in the viewport, which is the shape every route-level
 * waiting state was hand-writing.
 */

export interface PendingNoteProps {
  /** Names the act, e.g. "Reading your invoices". Never "Loading". */
  label: string;
  /** `page` centres in the viewport; `inline` sits in the flow. */
  variant?: 'inline' | 'page';
  className?: string;
}

export const PendingNote: React.FC<PendingNoteProps> = ({
  label,
  variant = 'inline',
  className,
}) => {
  const note = (
    <span className="flex items-center gap-3" role="status" aria-live="polite">
      <span aria-hidden className="ns-live-mark h-[7px] w-[7px] flex-none bg-foreground/50" />
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
    </span>
  );

  if (variant === 'page') {
    return (
      <div className={cn('flex min-h-screen items-center justify-center bg-background', className)}>
        {note}
      </div>
    );
  }

  return <div className={cn('flex items-center justify-center py-8', className)}>{note}</div>;
};
