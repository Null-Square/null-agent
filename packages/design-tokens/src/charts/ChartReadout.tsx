import React from 'react';

import { cn } from '../cn';

/**
 * ChartReadout — what a chart says when you point at it.
 *
 * Every chart on the board needs the same thing: name the mark under the
 * cursor and give its figures. Written once, it is written the same way
 * everywhere — one voice instead of six, and a legend is no longer the only
 * way to learn what a colour means.
 *
 * It is not a tooltip in the browser's sense. `title` attributes wait a second,
 * cannot be styled, and do not exist on touch; this is drawn, immediate, and on
 * the brand: black ground, one signal edge down the left, figures in mono.
 *
 * It never takes the pointer — hovering the readout must not count as leaving
 * the mark that opened it, or a mark near the corner flickers.
 */

export interface ChartReadoutRow {
  label: string;
  value: React.ReactNode;
  /** Segment colour, drawn as the square marker the legend would have used. */
  color?: string;
}

export interface ChartReadoutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  rows: ChartReadoutRow[];
}

export const ChartReadout: React.FC<ChartReadoutProps> = ({
  title,
  rows,
  className,
  ...rest
}) => (
  <div
    data-chart-readout
    className={cn(
      'pointer-events-none absolute right-0 top-0 z-10 max-w-[220px]',
      'border-l-[3px] border-primary bg-background px-4 py-3',
      className,
    )}
    {...rest}
  >
    <p className="mb-2.5 truncate font-mono text-[10.5px] font-bold uppercase tracking-[0.08em] text-foreground">
      {title}
    </p>
    {rows.map((row) => (
      <div key={row.label} className="mb-1.5 flex items-center justify-between gap-6 last:mb-0">
        <span className="flex min-w-0 items-center gap-2">
          {row.color ? (
            <span className="h-1.5 w-1.5 flex-none" style={{ background: row.color }} />
          ) : null}
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
            {row.label}
          </span>
        </span>
        <span className="flex-none font-mono text-[11.5px] font-bold tabular-nums text-foreground">
          {row.value}
        </span>
      </div>
    ))}
  </div>
);
