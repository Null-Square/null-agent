import React from 'react';

import { cn } from '../cn';
import type { SeverityLevel } from '../SeverityBadge';

/**
 * RecordTable — the ONE data table. Findings, runs, assets: one row.
 *
 * Brand system, Chapter III ("Findings, runs, assets — one row" / "Every list
 * is the one data table"): a severity stripe, a bold title, quiet columns. The
 * stripe alone triages the list before you read a word. No card per row, no box
 * around the table, no per-page variant — a page that lists records renders
 * this, and differs only in its columns.
 *
 * It replaced the legacy `DataTable` — the old brutalist table (yellow chrome,
 * pulse skeletons, a drop shadow), together with its `TableCheckbox` and
 * `TablePagination` parts. All three are deleted; paging is `ListPager`.
 *
 * Below `md` the row collapses to stripe + title, with any column marked
 * `showOnMobile` stacked under the title.
 */

export type RecordStripe = SeverityLevel | 'none';

export interface RecordTableColumn<T> {
  key: string;
  header: React.ReactNode;
  /** Grid track for this column, e.g. `150px` or `minmax(0,0.85fr)`. */
  width?: string;
  render: (row: T) => React.ReactNode;
  /** Real data — set in mono, tabular. Chrome stays sans. */
  mono?: boolean;
  align?: 'start' | 'end';
  /** Also render under the title on small screens. */
  showOnMobile?: boolean;
  className?: string;
}

export interface RecordTableProps<T> {
  rows: T[];
  getRowKey: (row: T) => string;
  /** The bold first cell — the one thing you read. */
  title: (row: T) => React.ReactNode;
  titleHeader?: React.ReactNode;
  titleWidth?: string;
  /** A secondary line under the title (asset value, goal, target). */
  subtitle?: (row: T) => React.ReactNode;
  /**
   * 4px severity stripe. Omit entirely for lists that have no severity.
   * Anything unrecognised falls back to a neutral hairline stripe, so pages
   * can hand over a raw severity string without casting.
   */
  stripe?: (row: T) => RecordStripe | string | null | undefined;
  columns: Array<RecordTableColumn<T>>;
  onRowClick?: (row: T) => void;
  /** Trailing per-row controls; clicks inside do not open the row. */
  actions?: (row: T) => React.ReactNode;
  actionsWidth?: string;
  /** Screen-reader prefix for the row button, e.g. "Open finding". */
  rowActionLabel?: (row: T) => string;
  rowAttributes?: (row: T) => Record<string, string | undefined>;
  rowClassName?: (row: T) => string | undefined;
  /**
   * Drop the column header row. For a short table whose columns are
   * self-evident, the header is a second label for something the row already
   * says — and stacked under a panel title it reads as a third heading level.
   */
  hideHeader?: boolean;
  className?: string;
}

const STRIPE_CLASS: Record<RecordStripe, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-muted-foreground',
  none: 'bg-border',
};

const stripeClass = (tone: RecordStripe | string | null | undefined): string =>
  STRIPE_CLASS[(tone ?? '').toString().toLowerCase() as RecordStripe] ?? STRIPE_CLASS.none;

export function RecordTable<T>({
  rows,
  getRowKey,
  title,
  titleHeader = 'Name',
  titleWidth = 'minmax(0,1.6fr)',
  subtitle,
  stripe,
  columns,
  onRowClick,
  actions,
  actionsWidth = 'max-content',
  rowActionLabel,
  rowAttributes,
  rowClassName,
  hideHeader = false,
  className,
}: RecordTableProps<T>) {
  const tracks = [
    stripe ? '4px' : null,
    titleWidth,
    ...columns.map((column) => column.width ?? 'minmax(0,0.85fr)'),
    actions ? actionsWidth : null,
  ].filter(Boolean) as string[];

  const mobileTracks = [
    stripe ? '4px' : null,
    'minmax(0,1fr)',
    actions ? 'max-content' : null,
  ].filter(Boolean) as string[];

  const mobileColumns = columns.filter((column) => column.showOnMobile);
  const interactive = Boolean(onRowClick);

  return (
    <div
      className={cn('ns-record-table', className)}
      style={{
        ['--ns-rt-cols' as string]: tracks.join(' '),
        ['--ns-rt-cols-sm' as string]: mobileTracks.join(' '),
      }}
    >
      <div
        className={cn(
          'ns-record-table__head border-b border-border/60 px-6 py-4 text-[13px] font-medium text-muted-foreground',
          hideHeader ? 'hidden' : 'hidden md:grid',
        )}
      >
        {stripe ? <span /> : null}
        <span>{titleHeader}</span>
        {columns.map((column) => (
          <span key={column.key} className={cn(column.align === 'end' && 'text-right')}>
            {column.header}
          </span>
        ))}
        {actions ? <span className="sr-only">Actions</span> : null}
      </div>

      {rows.map((row) => {
        const key = getRowKey(row);
        return (
          <div
            key={key}
            {...(rowAttributes?.(row) ?? {})}
            {...(interactive
              ? {
                  role: 'button' as const,
                  tabIndex: 0,
                  'aria-label': rowActionLabel?.(row),
                  onClick: () => onRowClick?.(row),
                  onKeyDown: (event: React.KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onRowClick?.(row);
                    }
                  },
                }
              : {})}
            className={cn(
              'ns-record-table__row group border-b border-border/60 px-6 transition-colors',
              interactive &&
                'cursor-pointer hover:bg-elevated/40 focus-visible:bg-elevated/40 focus-visible:outline-none',
              rowClassName?.(row),
            )}
          >
            {stripe ? (
              <span className={cn('h-[46px] w-[4px] self-center', stripeClass(stripe(row)))} aria-hidden />
            ) : null}

            <div className="min-w-0 py-6">
              <div className="truncate text-[15px] font-semibold text-foreground">{title(row)}</div>
              {subtitle ? (
                <div className="mt-1.5 truncate text-[13px] text-muted-foreground">{subtitle(row)}</div>
              ) : null}
              {mobileColumns.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-3 md:hidden">
                  {mobileColumns.map((column) => (
                    <span
                      key={column.key}
                      className={cn(
                        'min-w-0 truncate text-[13px] text-muted-foreground',
                        column.mono && 'font-mono tabular-nums',
                      )}
                    >
                      {column.render(row)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            {columns.map((column) => (
              <div
                key={column.key}
                className={cn(
                  'hidden min-w-0 truncate text-sm text-muted-foreground md:block',
                  column.mono && 'font-mono tabular-nums text-foreground',
                  column.align === 'end' && 'text-right',
                  column.className,
                )}
              >
                {column.render(row)}
              </div>
            ))}

            {actions ? (
              <div
                className="flex items-center justify-end gap-2 py-4 md:py-0"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
              >
                {actions(row)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
