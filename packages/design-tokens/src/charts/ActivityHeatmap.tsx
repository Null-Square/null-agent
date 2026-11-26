import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * ActivityHeatmap — cadence, as cells on the lattice.
 *
 * The one chart type this brand was already going to draw: squares on a grid,
 * filled by how much happened. No axes, no legend beyond the ramp itself, and
 * every cell square because every cell is square.
 *
 * Intensity climbs the bone ladder and stops — the last step is signal,
 * because the busiest day is the live one and signal is what "live" means
 * here. Days with nothing are not empty holes but the quietest step of the
 * same ladder, so the grid reads as one surface rather than a pegboard.
 */

export interface ActivityHeatmapProps {
  /** One entry per cell, oldest first. */
  data: Array<{ date: string; count: number }>;
  /** Cells per row. The kit's board uses fourteen. */
  columns?: number;
  /** What one cell counts, e.g. "Assessments". */
  unitLabel?: string;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

const STEPS = [
  'rgba(245,245,247,0.04)',
  'rgba(245,245,247,0.12)',
  'rgba(245,209,58,0.40)',
  'var(--ns-yellow)',
];

export const ActivityHeatmap: React.FC<ActivityHeatmapProps> = ({
  data,
  columns = 14,
  unitLabel = 'Assessments',
  emptyLabel = 'No assessments recorded yet',
  emptyIcon,
  className,
}) => {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const ceiling = Math.max(...data.map((entry) => entry.count), 1);
  const stepFor = (count: number) => {
    if (count <= 0) return 0;
    const ratio = count / ceiling;
    if (ratio > 0.66) return 3;
    if (ratio > 0.33) return 2;
    return 1;
  };

  const hovered = hover != null ? data[hover] : null;

  return (
    <div className={cn('relative flex flex-col justify-center gap-4', className)}>
      {hovered ? (
        <ChartReadout
          title={hovered.date}
          rows={[
            {
              label: unitLabel,
              value: hovered.count,
              color: STEPS[stepFor(hovered.count)],
            },
          ]}
        />
      ) : null}

      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {data.map((entry, index) => (
          <div
            key={entry.date}
            className={cn(
              'aspect-square w-full transition-opacity',
              hover != null && hover !== index && 'opacity-40',
            )}
            style={{ backgroundColor: STEPS[stepFor(entry.count)] }}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          Older
        </span>
        <div className="flex items-center gap-1">
          {STEPS.map((step) => (
            <span key={step} className="h-2 w-2" style={{ backgroundColor: step }} />
          ))}
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          Newer
        </span>
      </div>
    </div>
  );
};
