import React from 'react';

import { cn } from '../cn';

/**
 * GaugeArc — one figure against its ceiling.
 *
 * A half ring, because the question is always "how close to full", and a full
 * circle answers a different one: a whole circle implies the parts sum to
 * something, and here there is one part and its headroom.
 *
 * The arc colours by pressure rather than by category: comfortable is bone,
 * and it climbs the ramp as the ceiling approaches, because a runner pool at
 * 90% is a problem in a way that 40% is not. That is the one place a
 * utilisation figure earns severity colour.
 */

export interface GaugeArcProps {
  /** 0–100. */
  value: number;
  label?: string;
  /** Ratios at which the arc warms. Ordered low to high. */
  thresholds?: { medium: number; high: number };
  size?: number;
  thickness?: number;
  className?: string;
}

export const GaugeArc: React.FC<GaugeArcProps> = ({
  value,
  label = 'Of capacity',
  thresholds = { medium: 60, high: 85 },
  size = 200,
  thickness = 18,
  className,
}) => {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - thickness) / 2;
  const centerX = size / 2;
  const centerY = size / 2;
  // Half the circumference is the whole track, so the sweep is the value.
  const half = Math.PI * radius;
  const filled = (clamped / 100) * half;

  const tone =
    clamped >= thresholds.high
      ? 'var(--ns-critical)'
      : clamped >= thresholds.medium
        ? 'var(--ns-medium)'
        : 'var(--ns-fg)';

  return (
    <div
      className={cn('relative flex w-full justify-center', className)}
      style={{ height: size / 2 + 28 }}
    >
      <svg width={size} height={size / 2 + 2} viewBox={`0 0 ${size} ${size / 2 + 2}`}>
        <g transform={`rotate(180 ${centerX} ${centerY})`}>
          <circle
            cx={centerX}
            cy={centerY}
            r={radius}
            fill="none"
            strokeWidth={thickness}
            className="stroke-card"
            strokeDasharray={`${half} ${half * 3}`}
          />
          <circle
            cx={centerX}
            cy={centerY}
            r={radius}
            fill="none"
            strokeWidth={thickness}
            stroke={tone}
            strokeDasharray={`${filled} ${half * 3}`}
          />
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex flex-col items-center">
        <span
          className="text-[2rem] font-extrabold leading-none tracking-[-0.045em] tabular-nums"
          style={{ color: tone }}
        >
          {Math.round(clamped)}
          <span className="text-base">%</span>
        </span>
        <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
};
