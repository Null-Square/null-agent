import React from 'react';

import { cn } from '../cn';

/**
 * The dashboard lattice — the Field at information scale.
 *
 * Product kit, §the dashboard: one lattice, hairline seams, **no card
 * borders**, no radius, no shadow. A seam divides; it never encloses. Rules run
 * between cells and stop — they do not wrap the strip, because a rule on every
 * edge is a box drawn one side at a time, and half-closing it (top and bottom
 * but not the sides) is worse: the shape reads as an unfinished box rather than
 * an open field.
 *
 * This is why a dashboard panel is not a `SectionPanel`. A SectionPanel is a
 * surface and takes a border; a dashboard cell is a region of one field and
 * takes a seam. Using the first for the second turns the board into a tray of
 * floating boxes, which is the exact failure the rule was written against.
 *
 * A cell with nothing to report goes quiet; a healthy board is mostly black.
 */

export interface DashboardGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Columns at the widest breakpoint. The doc's board is four. */
  columns?: 2 | 3 | 4;
  children: React.ReactNode;
}

const COLUMN_CLASS: Record<number, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-2 lg:grid-cols-3',
  4: 'md:grid-cols-2 lg:grid-cols-4',
};

export const DashboardGrid: React.FC<DashboardGridProps> = ({
  columns = 4,
  children,
  className,
  ...rest
}) => (
  // The 1px gap on a line-coloured ground *is* the seam: no element draws a
  // border, so nothing encloses anything.
  //
  // `[grid-auto-rows:1fr]` makes every row the same height, so a short cell
  // stretches to its neighbour instead of leaving a void of page-coloured
  // background below it — on a board with no card borders an unfilled cell
  // does not read as an empty card, it reads as a hole.
  //
  // `[grid-auto-flow:dense]` backfills the gaps left when cells are
  // conditional, which here they always are: a plan without compliance, an
  // organization without Threat Watch, results mode hiding the asset cell.
  <div
    className={cn(
      'grid grid-cols-1 gap-px bg-border [grid-auto-flow:dense] [grid-auto-rows:1fr]',
      COLUMN_CLASS[columns],
      className,
    )}
    {...rest}
  >
    {children}
  </div>
);

export interface DashboardCellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Cell heading. Chrome, so it sets in sans. */
  title?: React.ReactNode;
  /** One line under the title, when the figure needs saying in words. */
  description?: React.ReactNode;
  /** At most one control, top right. */
  actions?: React.ReactNode;
  /** How many columns this cell occupies. */
  span?: 1 | 2 | 3 | 4;
  children?: React.ReactNode;
}

const SPAN_CLASS: Record<number, string> = {
  1: '',
  2: 'md:col-span-2',
  3: 'md:col-span-2 lg:col-span-3',
  4: 'md:col-span-2 lg:col-span-4',
};

export const DashboardCell: React.FC<DashboardCellProps> = ({
  title,
  description,
  actions,
  span = 1,
  children,
  className,
  ...rest
}) => (
  <div
    className={cn(
      'flex min-h-[176px] min-w-0 flex-col bg-background px-6 py-7',
      SPAN_CLASS[span],
      className,
    )}
    {...rest}
  >
    {title || actions ? (
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {title ? (
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h3>
          ) : null}
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-none items-center gap-3">{actions}</div> : null}
      </div>
    ) : null}
    <div className="flex min-h-0 flex-1 flex-col justify-center">{children}</div>
  </div>
);
