import React from 'react';

import { cn } from '../cn';

/**
 * Stepper — a quantity, and the two smallest decisions you can make about it.
 *
 * The native number input hands you the browser's spinner: a stacked pair of
 * grey chevrons, four pixels tall, rounded, and drawn by the operating system
 * rather than by us. It is the one control on a page that never obeys the
 * brand, so it gets replaced rather than restyled.
 *
 * Built from the lattice like everything else: three cells on a 1px seam
 * inside one hairline, no radius, no shadow. The value is real data, so it is
 * mono and tabular — the digits hold their column while you step, instead of
 * the field twitching between 9 and 10.
 *
 * The signs are drawn, not typed. A hyphen and a plus glyph from the text font
 * arrive at different weights and sit off-centre; two 1.6px strokes on the
 * same grid as the back-link arrow do not.
 *
 * At the bounds the step is disabled rather than hidden — a control that
 * silently loses half of itself at 1 reads as broken, and the brand makes the
 * same call for locked navigation.
 *
 * `options` is for quantities that are a set rather than a range: a plan sold
 * as 1, 2 or 4 tests has no 3, and laying all three out as buttons asks the
 * reader to evaluate every choice when they only ever wanted the next one.
 * The stepper shows the answer and moves through the set.
 */

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values, when the quantity is a set rather than a range. */
  options?: readonly number[];
  /** Accessible name, e.g. "Platform seats". */
  label: string;
  /** Width of the value cell. Widen it for four-figure quantities. */
  valueWidth?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

const StepGlyph: React.FC<{ direction: 'up' | 'down' }> = ({ direction }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="flex-none">
    <path d="M3 8 H13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    {direction === 'up' ? (
      <path d="M8 3 V13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    ) : null}
  </svg>
);

export const Stepper: React.FC<StepperProps> = ({
  value,
  onChange,
  min = 1,
  max = 99,
  step = 1,
  options,
  label,
  valueWidth = '56px',
  disabled = false,
  id,
  className,
}) => {
  const clamp = (next: number) => Math.max(min, Math.min(max, next));

  const index = options ? options.indexOf(value) : -1;
  const atMin = options ? index <= 0 : value <= min;
  const atMax = options ? index < 0 || index >= options.length - 1 : value >= max;

  const shift = (direction: -1 | 1) => {
    if (options) {
      const next = options[Math.max(0, Math.min(options.length - 1, index + direction))];
      if (next != null) onChange(next);
      return;
    }
    onChange(clamp(value + direction * step));
  };

  const cellClass =
    'flex h-8 w-8 items-center justify-center bg-background text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:hover:text-muted-foreground/40';

  return (
    <div className={cn('inline-flex gap-px border border-border bg-border', className)}>
      <button
        type="button"
        onClick={() => shift(-1)}
        disabled={disabled || atMin}
        aria-label={`Decrease ${label.toLowerCase()}`}
        className={cellClass}
      >
        <StepGlyph direction="down" />
      </button>

      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        aria-label={label}
        disabled={disabled}
        readOnly={Boolean(options)}
        onChange={(event) => {
          if (options) return;
          const parsed = Number.parseInt(event.target.value.replace(/[^0-9]/g, ''), 10);
          if (!Number.isNaN(parsed)) onChange(clamp(parsed));
        }}
        style={{ width: valueWidth }}
        className="h-8 bg-background text-center font-mono text-sm font-bold tabular-nums text-foreground outline-none focus:bg-foreground/[0.06] disabled:text-muted-foreground/40"
      />

      <button
        type="button"
        onClick={() => shift(1)}
        disabled={disabled || atMax}
        aria-label={`Increase ${label.toLowerCase()}`}
        className={cellClass}
      >
        <StepGlyph direction="up" />
      </button>
    </div>
  );
};
