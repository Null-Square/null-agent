import React from 'react';

import { cn } from '../cn';

/**
 * CellMeter — progress, drawn on the lattice.
 *
 * Straight out of `brand-system.html`:
 *
 *     .cmeter   { display: flex; gap: 3px; }
 *     .cmeter i { flex: 1; height: 10px; background: var(--line); }
 *     .cmeter i.f    { background: var(--signal); }
 *     .cmeter i.beat { background: var(--signal); animation: blink … }
 *
 * A determinate meter fills cells left to right and beats the leading one. An
 * indeterminate one — "we are working, we cannot say how far" — sends a single
 * lit cell travelling across the row, which is the icon set's motion rule
 * applied to a meter: the structure holds still and the signal cell moves.
 *
 * This is the loading treatment for anything that is neither a list (that is
 * `ListSkeleton`) nor a single line of text (`PendingNote`). No spinner, no
 * sliding bar, no shimmer.
 */

export interface CellMeterProps {
  /** How many cells. The doc's meter is a dozen-ish across 280px. */
  cells?: number;
  /** 0–1. Omit for the indeterminate scan. */
  value?: number;
  className?: string;
  /** Accessible name, e.g. "Checking your website platform". */
  label?: string;
}

/** One full sweep of the travelling cell. */
const SCAN_DURATION_MS = 1200;

export const CellMeter: React.FC<CellMeterProps> = ({ cells = 12, value, className, label }) => {
  const indeterminate = value == null;
  const filled = indeterminate ? 0 : Math.round(Math.max(0, Math.min(1, value)) * cells);

  return (
    <div
      className={cn('flex w-full gap-[3px]', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round((value ?? 0) * 100)}
    >
      {Array.from({ length: cells }).map((_, index) => {
        if (indeterminate) {
          return (
            <i
              key={index}
              className="ns-cell-scan block h-[10px] flex-1 bg-border"
              style={{ animationDelay: `${(index * SCAN_DURATION_MS) / cells}ms` }}
            />
          );
        }
        const isFilled = index < filled;
        const isLeading = index === filled - 1;
        return (
          <i
            key={index}
            className={cn(
              'block h-[10px] flex-1',
              isFilled ? 'bg-primary' : 'bg-border',
              isLeading && 'ns-live-mark',
            )}
          />
        );
      })}
    </div>
  );
};
