import React from 'react';

import { cn } from '../cn';

/**
 * ListSkeleton — the one waiting state for a list.
 *
 * Brand system, Chapter IV ("There is only one loading animation"): nothing
 * spins, and there is no grey shimmer. The skeleton is the scan — rows drawn at
 * line weight, holding the shape of the table that is about to arrive — and the
 * copy names the act ("Mapping your surface"), never "Loading".
 *
 * Replaces the per-page spinner + "Initialising Inbox…" treatments.
 */

export interface ListSkeletonProps {
  /** Names the act, e.g. "Reading your findings". Never "Loading". */
  label: string;
  rows?: number;
  className?: string;
}

export const ListSkeleton: React.FC<ListSkeletonProps> = ({ label, rows = 6, className }) => (
  <div className={cn('w-full', className)} role="status" aria-live="polite">
    <div className="flex items-center gap-3 border-b border-border/60 px-6 py-4">
      <span aria-hidden className="ns-live-mark h-[7px] w-[7px] flex-none bg-foreground/50" />
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
    </div>
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="flex items-center gap-6 border-b border-border/60 px-6 py-[30px]">
        <span aria-hidden className="h-[46px] w-[4px] flex-none bg-border" />
        <span aria-hidden className="h-px flex-1 bg-border" style={{ maxWidth: `${68 - index * 6}%` }} />
        <span aria-hidden className="hidden h-px w-[90px] flex-none bg-border md:block" />
      </div>
    ))}
  </div>
);
