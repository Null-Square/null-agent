import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * RadarChart — several scores of the same kind, read at once.
 *
 * The case for it is the case against tabs: five frameworks behind a picker is
 * five clicks to learn one thing, and the thing you actually want to know —
 * where you are weakest — is invisible until you have visited them all. On one
 * web the weak axis is the dent, and you see it without asking.
 *
 * It is drawn in polygons, not circles: the rings are straight-sided, so the
 * grid stays on the lattice even though the shape is radial. Signal fills the
 * plot because this is the one figure the widget reports, and a hollow outline
 * at this size reads as a diagram rather than a measurement.
 *
 * Three axes minimum — below that the shape carries no information a pair of
 * figures would not carry better.
 */

export interface RadarAxis {
  label: string;
  /** 0–100. */
  value: number;
}

export interface RadarChartProps {
  axes: RadarAxis[];
  size?: number;
  /** Concentric rings, excluding the outer edge. */
  rings?: number;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

const LABEL_PAD = 34;

export const RadarChart: React.FC<RadarChartProps> = ({
  axes,
  size = 260,
  rings = 3,
  emptyLabel = 'Not enough frameworks to compare',
  emptyIcon,
  className,
}) => {
  const [hover, setHover] = useState<number | null>(null);

  if (axes.length < 3) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const center = size / 2;
  const radius = center - LABEL_PAD;
  const step = (Math.PI * 2) / axes.length;

  const pointAt = (index: number, ratio: number) => {
    // Start at twelve o'clock so the first axis reads as the heading.
    const angle = index * step - Math.PI / 2;
    return [center + Math.cos(angle) * radius * ratio, center + Math.sin(angle) * radius * ratio];
  };

  const polygon = (ratio: number) =>
    axes
      .map((_, index) => {
        const [x, y] = pointAt(index, ratio);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const plot = axes
    .map((axis, index) => {
      const ratio = Math.max(0, Math.min(100, axis.value)) / 100;
      const [x, y] = pointAt(index, ratio);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const hovered = hover != null ? axes[hover] : null;

  return (
    <div className={cn('relative flex w-full items-center justify-center', className)}>
      {hovered ? (
        <ChartReadout
          title={hovered.label}
          rows={[{ label: 'Ready', value: `${Math.round(hovered.value)}%` }]}
        />
      ) : null}
      <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" style={{ maxWidth: size }}>
        {Array.from({ length: rings + 1 }).map((_, ring) => (
          <polygon
            key={ring}
            points={polygon((ring + 1) / (rings + 1))}
            fill="none"
            stroke="var(--ns-border)"
            strokeWidth={1}
          />
        ))}

        {axes.map((axis, index) => {
          const [x, y] = pointAt(index, 1);
          return (
            <line
              key={axis.label}
              x1={center}
              y1={center}
              x2={x}
              y2={y}
              stroke="var(--ns-border)"
              strokeWidth={1}
            />
          );
        })}

        <polygon
          points={plot}
          fill="var(--ns-yellow)"
          fillOpacity={0.12}
          stroke="var(--ns-yellow)"
          strokeWidth={1.5}
          strokeLinejoin="miter"
        />

        {axes.map((axis, index) => {
          const ratio = Math.max(0, Math.min(100, axis.value)) / 100;
          const [hx, hy] = pointAt(index, ratio);
          return (
            <circle
              key={`${axis.label}-hit`}
              cx={hx}
              cy={hy}
              r={10}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {axes.map((axis, index) => {
          const [x, y] = pointAt(index, 1.16);
          const anchor = Math.abs(x - center) < 4 ? 'middle' : x > center ? 'start' : 'end';
          return (
            <text
              key={axis.label}
              x={x}
              y={y}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="fill-muted-foreground font-mono text-[9px] uppercase tracking-[0.08em]"
            >
              {axis.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
};
