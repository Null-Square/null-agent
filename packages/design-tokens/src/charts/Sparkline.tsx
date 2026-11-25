import React, { useId, useState } from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';
import { ChartReadout } from './ChartReadout';

/**
 * Sparkline — a trajectory, drawn the way the kit draws one.
 *
 * Product kit, charts: "flat, drawn inside a dashboard cell. no axes, no
 * legend, no gridlines." So there are none. The shape is the information: a
 * line that falls is a backlog closing, and that reads without a y-axis to
 * check it against.
 *
 * Two series at most, and they are distinguished by weight rather than by
 * inventing a second colour — the open line is solid bone, the resolved line
 * is a dashed hairline. The severity ramp stays for severity; a trend is not
 * a severity.
 *
 * The hover readout is the tooltip the kit specifies: black, a 3px signal
 * edge, mono figures. It is the one place signal appears here, because it
 * marks where you are pointing.
 */

export interface SparklineSeries {
  key: string;
  label: string;
  values: number[];
  /** The lead series draws solid and heavier; it is the one you read first. */
  lead?: boolean;
  /**
   * How the line is drawn. Three series need three treatments, and weight and
   * dash carry that without inventing three colours — a trend is not a
   * severity, so the ramp stays out of it.
   */
  stroke?: 'solid' | 'dashed' | 'dotted';
  color?: string;
}

export interface SparklineProps {
  /** X labels, one per point. */
  labels: string[];
  series: SparklineSeries[];
  height?: number;
  /**
   * Show a handful of labels along the bottom. A trajectory without dates is
   * a shape you cannot place — "when did it turn" is the question the chart
   * exists to answer, and it needs an anchor to answer it.
   */
  showAxis?: boolean;
  /** How many x labels to print. Evenly spaced, ends always included. */
  axisTicks?: number;
  /** A legend, because three lines need naming once they carry colour. */
  showLegend?: boolean;
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

const VIEW_W = 300;

const dashFor = (line: SparklineSeries): string | undefined => {
  const style = line.stroke ?? (line.lead ? 'solid' : 'dashed');
  if (style === 'solid') return undefined;
  return style === 'dotted' ? '1 4' : '4 4';
};

export const Sparkline: React.FC<SparklineProps> = ({
  labels,
  series,
  height = 120,
  showAxis = false,
  axisTicks = 5,
  showLegend = false,
  emptyLabel = 'No history yet',
  emptyIcon,
  className,
}) => {
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const points = Math.max(...series.map((line) => line.values.length), 0);
  if (points < 2) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const ceiling = Math.max(...series.flatMap((line) => line.values), 1);
  const stepX = VIEW_W / (points - 1);
  const toPath = (values: number[]) =>
    values
      .map((value, index) => {
        const x = index * stepX;
        const y = height - (value / ceiling) * (height - 8) - 4;
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');

  const tickIndexes = showAxis
    ? Array.from({ length: Math.min(axisTicks, points) }, (_, index) =>
        Math.round((index * (points - 1)) / Math.max(1, Math.min(axisTicks, points) - 1)),
      )
    : [];

  return (
    <div className={cn('flex w-full flex-col', className)}>
      <div className="relative w-full" style={{ height }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        className="block h-full w-full overflow-visible"
        onMouseLeave={() => setHover(null)}
      >
        <clipPath id={clipId}>
          <rect x="0" y="0" width={VIEW_W} height={height} />
        </clipPath>

        {series.map((line) => (
          <path
            key={line.key}
            d={toPath(line.values)}
            fill="none"
            stroke={line.color ?? (line.lead ? 'var(--ns-fg)' : 'var(--ns-fg-muted)')}
            strokeWidth={line.lead ? 2 : 1.5}
            strokeDasharray={dashFor(line)}
            strokeLinecap="square"
            clipPath={`url(#${clipId})`}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hover != null ? (
          <line
            x1={hover * stepX}
            y1={0}
            x2={hover * stepX}
            y2={height}
            stroke="var(--ns-yellow)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* One hit column per point, so the readout follows the cursor without
            the line itself having to be hoverable. */}
        {Array.from({ length: points }).map((_, index) => (
          <rect
            key={index}
            x={index * stepX - stepX / 2}
            y={0}
            width={stepX}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>

      {hover != null ? (
        <ChartReadout
          data-sparkline-readout
          title={labels[hover] ?? ''}
          rows={series.map((line) => ({
            label: line.label,
            value: line.values[hover] ?? 0,
            color: line.color,
          }))}
          className="right-auto"
          style={{ left: `min(calc(${(hover / (points - 1)) * 100}% + 12px), calc(100% - 180px))` }}
        />
      ) : null}
      </div>

      {showAxis ? (
        <div className="mt-2 flex justify-between">
          {tickIndexes.map((index) => (
            <span
              key={index}
              className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground"
            >
              {labels[index] ?? ''}
            </span>
          ))}
        </div>
      ) : null}

      {showLegend ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {series.map((line) => (
            <span key={line.key} className="flex items-center gap-2">
              <span
                className="h-0.5 w-4 flex-none"
                style={{
                  background: line.color ?? (line.lead ? 'var(--ns-fg)' : 'var(--ns-fg-muted)'),
                }}
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                {line.label}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};
