import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * StackedBars — severity density, per thing.
 *
 * Where `RankedBars` ranks one number across categories, this splits each
 * category into the ramp: how much of this asset's risk is critical, how much
 * is high. The column height is the total, so the tallest bar is the worst
 * asset and the reddest bar is the most urgent one — two different questions,
 * answered by the same picture.
 *
 * Vertical because the categories are short names and there are few of them;
 * horizontal bars would waste the width the labels do not need.
 *
 * No axes, per the charts rule. The scale ticks are the only exception, and
 * only because a stack without them is a shape whose size you cannot name.
 */

export interface StackedBarSegment {
  key: string;
  label: string;
  color: string;
}

export interface StackedBarColumn {
  label: string;
  values: Record<string, number>;
  onSelect?: () => void;
}

export interface StackedBarsProps {
  columns: StackedBarColumn[];
  segments: StackedBarSegment[];
  height?: number;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

export const StackedBars: React.FC<StackedBarsProps> = ({
  columns,
  segments,
  height = 200,
  emptyLabel = 'Nothing to report',
  emptyIcon,
  className,
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const totals = columns.map((column) =>
    segments.reduce((sum, segment) => sum + (column.values[segment.key] ?? 0), 0),
  );
  const ceiling = Math.max(...totals, 1);

  if (columns.length === 0 || ceiling === 0) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const hovered = hover != null ? columns[hover] : null;

  return (
    <div className={cn('relative flex w-full flex-col gap-3', className)}>
      {hovered ? (
        <ChartReadout
          title={hovered.label}
          rows={segments.map((segment) => ({
            label: segment.label,
            value: hovered.values[segment.key] ?? 0,
            color: segment.color,
          }))}
        />
      ) : null}
      <div className="flex items-end gap-4" style={{ height }}>
        {/* Three ticks: floor, middle, ceiling. Enough to size the stack. */}
        <div className="flex h-full flex-none flex-col justify-between py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
          <span>{ceiling}</span>
          <span>{Math.round(ceiling / 2)}</span>
          <span>0</span>
        </div>

        <div className="flex h-full flex-1 items-end justify-around gap-3">
          {columns.map((column, index) => {
            const total = totals[index] ?? 0;
            const Column = column.onSelect ? 'button' : 'div';
            return (
              <Column
                key={column.label}
                {...(column.onSelect ? { type: 'button' as const, onClick: column.onSelect } : {})}
                className={cn(
                  'flex h-full min-w-0 flex-1 flex-col justify-end',
                  column.onSelect && 'transition-opacity hover:opacity-80',
                )}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
              >
                <span
                  className="flex w-full flex-col-reverse"
                  style={{ height: `${(total / ceiling) * 100}%` }}
                >
                  {segments.map((segment) => {
                    const value = column.values[segment.key] ?? 0;
                    if (value <= 0) return null;
                    return (
                      <span
                        key={segment.key}
                        className="block w-full"
                        style={{
                          height: `${(value / Math.max(total, 1)) * 100}%`,
                          background: segment.color,
                        }}
                      />
                    );
                  })}
                </span>
              </Column>
            );
          })}
        </div>
      </div>

      <div className="flex gap-4 pl-8">
        <div className="flex flex-1 justify-around gap-3">
          {columns.map((column) => (
            <span
              key={column.label}
              className="min-w-0 flex-1 truncate text-center font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground"
              title={column.label}
            >
              {column.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
