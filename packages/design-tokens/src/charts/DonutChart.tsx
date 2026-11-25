import React, { useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * DonutChart — a proportion, with the figure that matters in the middle.
 *
 * The circle is the documented exception: everywhere else this brand has no
 * circles, but a dashboard is where a share of a whole has to be read at a
 * glance, and a ring says "part of one thing" in a way stacked bars do not.
 * The exception stops there — the segments are square-capped, the legend rows
 * are square, and nothing rotates.
 *
 * The centre carries the one number the widget exists to report, at display
 * scale. A ring without it is a shape you have to decode; with it, the ring is
 * the supporting evidence for a figure you have already read.
 *
 * Segment colours come from the caller because only the caller knows whether a
 * slice is a severity, an outcome or a plain share — the ramp is fixed, but
 * which of it applies is not.
 *
 * The legend is optional and, on a ring you can point at, usually wrong: it
 * repeats every label permanently to answer a question you ask about one
 * segment at a time, and it costs the ring half its width. Turn it off and the
 * arc under the cursor names itself.
 */

export interface DonutSegment {
  label: string;
  value: number;
  /** A token, e.g. `var(--ns-critical)`. Defaults down the bone ladder. */
  color?: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  /** The figure in the middle — already formatted. */
  centerValue?: React.ReactNode;
  centerLabel?: string;
  size?: number;
  thickness?: number;
  /** Render the label/value rows beside the ring. */
  showLegend?: boolean;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  onSegmentSelect?: (label: string) => void;
  className?: string;
}

const FALLBACK = 'var(--ns-fg-muted)';

export const DonutChart: React.FC<DonutChartProps> = ({
  segments,
  centerValue,
  centerLabel,
  size = 148,
  thickness = 14,
  showLegend = true,
  emptyLabel = 'Nothing to report',
  emptyIcon,
  onSegmentSelect,
  className,
}) => {
  const [hover, setHover] = useState<string | null>(null);
  const rows = segments.filter((segment) => Number.isFinite(segment.value) && segment.value >= 0);
  const total = rows.reduce((sum, segment) => sum + segment.value, 0);

  if (rows.length === 0 || total === 0) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  const hovered = rows.find((segment) => segment.label === hover) ?? null;

  return (
    <div className={cn('relative flex flex-wrap items-center gap-10', className)}>
      {hovered ? (
        <ChartReadout
          title={hovered.label}
          rows={[
            { label: 'Count', value: hovered.value, color: hovered.color ?? FALLBACK },
            { label: 'Share', value: `${Math.round((hovered.value / total) * 100)}%` },
          ]}
        />
      ) : null}

      <div className="relative flex-none" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          {/* The unfilled remainder, so a partial ring still reads as a whole. */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={thickness}
            className="stroke-card"
          />
          {rows.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const offset = -consumed;
            consumed += length;
            return (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                stroke={segment.color ?? FALLBACK}
                strokeDasharray={dash}
                strokeDashoffset={offset}
                // Only the painted arc takes the pointer, so the dash gaps
                // hand the hover to the segment actually under the cursor.
                opacity={hover && hover !== segment.label ? 0.3 : 1}
                className={onSegmentSelect ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(segment.label)}
                onMouseLeave={() => setHover(null)}
                onClick={onSegmentSelect ? () => onSegmentSelect(segment.label) : undefined}
              />
            );
          })}
        </svg>

        {centerValue != null ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[1.75rem] font-extrabold leading-none tracking-[-0.045em] tabular-nums text-foreground">
              {centerValue}
            </span>
            {centerLabel ? (
              <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                {centerLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {showLegend ? (
        <div className="flex min-w-[180px] flex-1 flex-col gap-3">
          {rows.map((segment) => {
            const Row = onSegmentSelect ? 'button' : 'div';
            return (
              <Row
                key={segment.label}
                {...(onSegmentSelect
                  ? { type: 'button' as const, onClick: () => onSegmentSelect(segment.label) }
                  : {})}
                className={cn(
                  'flex w-full items-center justify-between gap-4 text-left',
                  onSegmentSelect && 'transition-opacity hover:opacity-80',
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {/* A marker is a square, even beside a ring. */}
                  <span
                    className="h-1.5 w-1.5 flex-none"
                    style={{ background: segment.color ?? FALLBACK }}
                  />
                  <span className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {segment.label}
                  </span>
                </span>
                <span className="font-mono text-xs font-bold tabular-nums text-foreground">
                  {segment.value}
                </span>
              </Row>
            );
          })}
        </div>
      ) : (
        // Without the legend the ring is the only statement of the figures, and
        // a ring is not readable by a screen reader. Say them in text instead.
        <ul className="sr-only">
          {rows.map((segment) => (
            <li key={segment.label}>{`${segment.label}: ${segment.value}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
};
