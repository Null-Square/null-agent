import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * MatrixHeatmap — two dimensions crossed, filled by count.
 *
 * Classification against architecture: which OWASP category lands on which
 * part of the estate. A ranked list answers "what is most common"; only the
 * crossing answers "and where", which is the question that decides who fixes
 * it.
 *
 * Cells take the severity ramp by count, and an empty crossing is not a hole
 * but a single dim cell mark — so a sparse matrix reads as a surface with
 * gaps rather than a broken grid. That is the same reasoning the heatmap's
 * quiet day uses.
 */

export interface MatrixHeatmapProps {
  rows: string[];
  columns: string[];
  /** `values[rowIndex][columnIndex]`. */
  values: number[][];
  /** Row label column width. */
  labelWidth?: number;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

const toneFor = (value: number, ceiling: number): string => {
  if (value <= 0) return 'rgba(245,245,247,0.02)';
  const ratio = value / ceiling;
  if (ratio > 0.66) return 'var(--ns-critical)';
  if (ratio > 0.33) return 'var(--ns-high)';
  return 'var(--ns-medium)';
};

export const MatrixHeatmap: React.FC<MatrixHeatmapProps> = ({
  rows,
  columns,
  values,
  labelWidth = 96,
  emptyLabel = 'Nothing to cross-reference yet',
  emptyIcon,
  className,
}) => {
  const [hover, setHover] = useState<{ row: string; column: string; value: number } | null>(null);
  const ceiling = Math.max(...values.flat(), 1);

  if (rows.length === 0 || columns.length === 0) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const template = `${labelWidth}px repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <div className={cn('relative flex w-full flex-col gap-0.5', className)}>
      {hover ? (
        <ChartReadout
          title={hover.row}
          rows={[
            { label: hover.column, value: hover.value, color: toneFor(hover.value, ceiling) },
          ]}
        />
      ) : null}

      <div className="grid gap-0.5" style={{ gridTemplateColumns: template }}>
        <div />
        {columns.map((column) => (
          <span
            key={column}
            className="truncate text-center font-mono text-[9px] uppercase tracking-[0.08em] text-foreground"
            title={column}
          >
            {column}
          </span>
        ))}
      </div>

      {rows.map((row, rowIndex) => (
        <div key={row} className="grid gap-0.5" style={{ gridTemplateColumns: template }}>
          <span
            className="flex items-center truncate pr-2 font-mono text-[9px] font-bold uppercase tracking-[0.04em] text-muted-foreground"
            title={row}
          >
            {row}
          </span>
          {columns.map((column, columnIndex) => {
            const value = values[rowIndex]?.[columnIndex] ?? 0;
            return (
              <div
                key={`${row}-${column}`}
                className="relative h-6"
                style={{ backgroundColor: toneFor(value, ceiling) }}
                onMouseEnter={() => setHover({ row, column, value })}
                onMouseLeave={() => setHover(null)}
              >
                {value === 0 ? (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="h-0.5 w-0.5 bg-foreground/10" />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
