import React from 'react';

import { cn } from '../cn';

/**
 * SegmentedControl — a small set of choices, all of them visible.
 *
 * The counterpart to `Stepper`, and the difference is how many there are.
 * Three options laid out are read in one glance and chosen in one click; a
 * stepper hides two of them behind arrows and makes you click twice to reach
 * the last. Past four or five the arithmetic reverses — the row gets wider
 * than it is useful and the stepper wins.
 *
 * Built from the same lattice as everything else: cells on a 1px seam inside
 * one hairline, no radius. The selected cell inverts to bone rather than
 * taking a tint, because a filled pill is a shape this brand does not have
 * and the signal colour belongs to the action at the bottom of the card.
 *
 * Values are real data, so they set in mono and tabular — the row does not
 * reflow when 9 becomes 10.
 */

export interface SegmentedControlOption<T extends string | number> {
  value: T;
  label?: React.ReactNode;
}

export interface SegmentedControlProps<T extends string | number> {
  options: ReadonlyArray<SegmentedControlOption<T> | T>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group, e.g. "Tests each month". */
  label: string;
  /**
   * What the segments hold. `data` (the default) is mono and tabular because
   * the segments are figures -- seat counts, test counts. `label` is the
   * chrome face, for segments that are words rather than data; mono is
   * reserved for real data, so a worded segment must not borrow it.
   */
  tone?: 'data' | 'label';
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  tone = 'data',
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const items = options.map((option) =>
    typeof option === 'object' ? option : ({ value: option } as SegmentedControlOption<T>),
  );

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex gap-px border border-border bg-border', className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={String(item.value)}
            type="button"
            onClick={() => onChange(item.value)}
            aria-pressed={selected}
            disabled={disabled}
            className={cn(
              'flex h-8 min-w-8 items-center justify-center px-2 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              tone === 'data' ? 'font-mono tabular-nums' : 'px-3',
              selected
                ? 'bg-foreground text-background'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label ?? item.value}
          </button>
        );
      })}
    </div>
  );
}
