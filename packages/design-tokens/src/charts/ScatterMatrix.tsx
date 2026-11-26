import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * ScatterMatrix — likelihood against impact, sized by reach.
 *
 * The one chart here that says something no list can: two risks with the same
 * severity are not the same risk, and the difference is where they sit. Top
 * right is what to do first; bottom left is what to leave. A ranked list
 * flattens that into one column and loses it.
 *
 * A point is a circle, which the dashboard allows, and its area carries a
 * third number — how many assets it touches — because a bubble is the only
 * mark that can hold three values without a second chart.
 *
 * Gridlines are the exception the charts rule tolerates here: a position means
 * nothing without the quadrants that give it a name.
 */

export interface ScatterPoint {
  label: string;
  /** 0–100. */
  likelihood: number;
  /** 0–100. */
  impact: number;
  /** Relative reach; drives the point's area. */
  weight?: number;
  color?: string;
  onSelect?: () => void;
}

export interface ScatterMatrixProps {
  points: ScatterPoint[];
  size?: number;
  xLabel?: string;
  yLabel?: string;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

const PAD = 28;

export const ScatterMatrix: React.FC<ScatterMatrixProps> = ({
  points,
  size = 280,
  xLabel = 'Likelihood',
  yLabel = 'Impact',
  emptyLabel = 'Not enough scored risks to plot',
  emptyIcon,
  className,
}) => {
  const [hover, setHover] = useState<ScatterPoint | null>(null);

  if (points.length === 0) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const plot = size - PAD * 2;
  const maxWeight = Math.max(...points.map((point) => point.weight ?? 1), 1);
  const toX = (value: number) => PAD + (Math.max(0, Math.min(100, value)) / 100) * plot;
  const toY = (value: number) => PAD + plot - (Math.max(0, Math.min(100, value)) / 100) * plot;

  return (
    <div className={cn('relative w-full', className)}>
      <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" style={{ maxWidth: size }}>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={toX(tick)}
              y1={PAD}
              x2={toX(tick)}
              y2={PAD + plot}
              stroke="var(--ns-border)"
              strokeWidth={1}
            />
            <line
              x1={PAD}
              y1={toY(tick)}
              x2={PAD + plot}
              y2={toY(tick)}
              stroke="var(--ns-border)"
              strokeWidth={1}
            />
          </g>
        ))}

        {points.map((point) => {
          const r = 5 + ((point.weight ?? 1) / maxWeight) * 9;
          return (
            <circle
              key={point.label}
              cx={toX(point.likelihood)}
              cy={toY(point.impact)}
              r={r}
              fill={point.color ?? 'var(--ns-fg)'}
              fillOpacity={0.85}
              className={point.onSelect ? 'cursor-pointer' : undefined}
              onMouseEnter={() => setHover(point)}
              onMouseLeave={() => setHover(null)}
              onClick={point.onSelect}
            />
          );
        })}
      </svg>

      <span className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {xLabel}
      </span>
      <span className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 -rotate-90 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {yLabel}
      </span>

      {hover ? (
        <ChartReadout
          title={hover.label}
          rows={[
            { label: 'Impact', value: hover.impact, color: hover.color },
            { label: 'Likelihood', value: hover.likelihood },
          ]}
        />
      ) : null}
    </div>
  );
};
