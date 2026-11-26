import React from 'react';

import { cn } from '../cn';
import { type CellIconName } from '../CellIcon';
import { ChartEmpty } from './ChartEmpty';

/**
 * RankedBars — an ordered list of categories, with the label given room.
 *
 * The label is why this exists. A classification's names are sentences —
 * "Broken access control", "Software and data integrity failures" — and in a
 * fixed label column beside a track they truncate to nothing, which is what
 * made the OWASP widget unreadable.
 *
 * So the label takes its own line at full width and the track sits under it.
 * The figure stays on the label's line, right-aligned, so the eye reads name
 * → count → length and the bars still compare down the column.
 *
 * Bars are bone by default. A category is not a severity, and colouring one
 * per row would invent a meaning the data does not carry — the ramp is for
 * severity, and everything else is the one bone.
 */

export interface RankedBarItem {
  label: string;
  value: number;
  /** Optional prefix set in mono, e.g. an OWASP code. */
  code?: string;
  color?: string;
  onSelect?: () => void;
}

export interface RankedBarsProps {
  items: RankedBarItem[];
  /** Cap the rows shown; the rest fold into a trailing count. */
  limit?: number;
  /**
   * `rank` (default) sorts by size and drops empty categories — the right
   * reading for "which of these is biggest", where a category nobody hit is
   * noise.
   *
   * `given` keeps the caller's order and keeps the zeros. A sequence is not a
   * ranking: sorting a funnel by size destroys the thing it measures, and a
   * stage that nobody reached is the most informative row on the chart.
   */
  order?: 'rank' | 'given';
  emptyLabel?: string;
  /** Names the absent subject on the empty state. */
  emptyIcon?: CellIconName;
  className?: string;
}

export const RankedBars: React.FC<RankedBarsProps> = ({
  items,
  limit = 6,
  order = 'rank',
  emptyLabel = 'Nothing to report',
  emptyIcon,
  className,
}) => {
  const finite = items.filter((item) => Number.isFinite(item.value));
  const rows = order === 'given'
    ? finite
    : finite.filter((item) => item.value > 0).sort((left, right) => right.value - left.value);

  // A sequence of zeros is still nothing to report, however it was ordered.
  if (rows.length === 0 || rows.every((item) => item.value <= 0)) {
    return (
      <ChartEmpty label={emptyLabel} icon={emptyIcon} />
    );
  }

  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  const ceiling = Math.max(...shown.map((item) => item.value), 1);

  return (
    <div className={cn('flex flex-col justify-center gap-4', className)}>
      {shown.map((item) => {
        const Row = item.onSelect ? 'button' : 'div';
        return (
          <Row
            key={item.label}
            {...(item.onSelect ? { type: 'button' as const, onClick: item.onSelect } : {})}
            className={cn(
              'flex w-full flex-col gap-2 text-left',
              item.onSelect && 'transition-opacity hover:opacity-80',
            )}
          >
            <span className="flex items-baseline justify-between gap-4">
              <span className="flex min-w-0 items-baseline gap-2">
                {item.code ? (
                  <span className="flex-none font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {item.code}
                  </span>
                ) : null}
                <span className="truncate text-sm text-foreground">{item.label}</span>
              </span>
              <span className="flex-none font-mono text-[13px] font-bold tabular-nums text-foreground">
                {item.value}
              </span>
            </span>
            {/* A 2px rule, not a bar: at this width the length is the reading,
                and thickness would make a category look like a severity. A zero
                draws nothing — the floor of 2% is for a value that exists. */}
            <span className="block h-0.5 w-full bg-card">
              {item.value > 0 ? (
                <span
                  className="block h-full"
                  style={{
                    width: `${Math.max(2, Math.round((item.value / ceiling) * 100))}%`,
                    background: item.color ?? 'var(--ns-fg)',
                  }}
                />
              ) : null}
            </span>
          </Row>
        );
      })}

      {hidden > 0 ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {hidden} more {hidden === 1 ? 'category' : 'categories'}
        </p>
      ) : null}
    </div>
  );
};
