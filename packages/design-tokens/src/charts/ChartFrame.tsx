import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * ChartFrame — the heading every dashboard widget wears, and nothing else.
 *
 * A widget is a title, a line saying what it measures, and the drawing. It is
 * not a card: no border, no ground, no radius. What separates one widget from
 * the next is space and, between bands, a single rule — the same reasoning the
 * dashboard chapter gives for its cells ("a seam divides; it never encloses").
 *
 * The title sets in mono because it labels a measurement and is read with the
 * figures under it, not as page chrome. That is the one place mono is right on
 * a surface otherwise set in sans.
 *
 * `height` fixes the drawing area so a row of widgets lines up on its
 * baselines rather than each one sizing to its own content.
 *
 * `span` is its width in twelfths of the band — see `ChartBand`.
 */

/** Twelfths. A widget's width is a number of columns, nothing else. */
export type ChartSpan = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * Written out rather than built, because Tailwind reads source text: a class
 * assembled at runtime is a class that was never compiled.
 *
 * The ladder below the widest breakpoint is fixed and deliberate. Anything
 * narrower than half goes to half on a tablet and full on a phone; anything
 * wider than half goes straight to full, because a nine-twelfths widget
 * squeezed into six is worse than one that simply takes the row.
 */
const SPAN: Record<ChartSpan, string> = {
  1: 'col-span-12 sm:col-span-6 lg:col-span-1',
  2: 'col-span-12 sm:col-span-6 lg:col-span-2',
  3: 'col-span-12 sm:col-span-6 lg:col-span-3',
  4: 'col-span-12 sm:col-span-6 lg:col-span-4',
  5: 'col-span-12 sm:col-span-6 lg:col-span-5',
  6: 'col-span-12 sm:col-span-6',
  7: 'col-span-12 lg:col-span-7',
  8: 'col-span-12 lg:col-span-8',
  9: 'col-span-12 lg:col-span-9',
  10: 'col-span-12 lg:col-span-10',
  11: 'col-span-12 lg:col-span-11',
  12: 'col-span-12',
};

/** A band tells its children how wide they are unless they say otherwise. */
const BandSpanContext = React.createContext<ChartSpan>(12);

export interface ChartFrameProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  /**
   * The section mark — one of the icon doc's stated uses for a `CellIcon`
   * ("empty states and section marks"). It names what the widget is about, so
   * a board of eight measurements can be scanned by subject before it is read
   * by title.
   */
  icon?: CellIconName;
  /** One line: what the figures below actually measure. */
  caption?: React.ReactNode;
  /** Top-right control — at most one. */
  action?: React.ReactNode;
  /** Fixed drawing height, so sibling widgets align. */
  height?: number;
  /** Width in twelfths. Defaults to the band's own division. */
  span?: ChartSpan;
  children: React.ReactNode;
}

export const ChartFrame: React.FC<ChartFrameProps> = ({
  title,
  icon,
  caption,
  action,
  height,
  span,
  children,
  className,
  ...rest
}) => {
  const bandSpan = React.useContext(BandSpanContext);

  return (
    <section className={cn('flex min-w-0 flex-col', SPAN[span ?? bandSpan], className)} {...rest}>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          {icon ? <CellIcon name={icon} size={20} className="mt-px text-foreground/55" /> : null}
          <div className="min-w-0">
            <h3 className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
              {title}
            </h3>
            {caption ? (
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {caption}
              </p>
            ) : null}
          </div>
        </div>
        {action ? <div className="flex flex-none items-center gap-3">{action}</div> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col" style={height ? { height } : undefined}>
        {children}
      </div>
    </section>
  );
};

/**
 * ChartBand — a row of widgets, divided from the previous row by one rule.
 *
 * Twelve columns, always. `columns` is only a shorthand for the width its
 * children take when they do not say — two means each child is six twelfths —
 * so the common cases stay one word while an uneven row stays possible:
 *
 *     <ChartBand columns={2}>
 *       <ChartFrame span={8} .../>
 *       <ChartFrame span={4} .../>
 *     </ChartBand>
 *
 * Twelve rather than the four the band used to offer, because twelve is what
 * divides cleanly by two, three, four and six. A widget that needs the whole
 * row asks for the whole row; before this, a lone child in a two-column band
 * silently drew at half width with an empty column beside it.
 *
 * The rule runs the full width and stops; it never wraps a band, because a
 * rule on every edge is a box drawn one side at a time.
 */
export interface ChartBandProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Even division for children that declare no `span` of their own. */
  columns?: 1 | 2 | 3 | 4 | 6;
  /** The first band on a page has nothing above it to be divided from. */
  first?: boolean;
  children: React.ReactNode;
}

const DEFAULT_SPAN: Record<number, ChartSpan> = { 1: 12, 2: 6, 3: 4, 4: 3, 6: 2 };

export const ChartBand: React.FC<ChartBandProps> = ({
  columns = 3,
  first = false,
  children,
  className,
  ...rest
}) => (
  <BandSpanContext.Provider value={DEFAULT_SPAN[columns] ?? 12}>
    <div
      className={cn(
        /* THE COLUMN GAP IS BREAKPOINT-BOUND, and it has to be.
           `grid-cols-12` with a flat `gap-x-16` needs 11 × 64px = 704px of gap
           before a single track gets a pixel, so on a 375px screen the grid
           could not fit and overflowed by ~330px — with no scroller to reach
           it. Charts lost two of three series and seven of nine axis labels off
           the right edge, on the marketing platform band and the product
           dashboard alike.
           Below `sm` every frame is `col-span-12` already, so a horizontal gap
           separates nothing; `gap-y-14` is what does the work there. */
        'grid grid-cols-12 gap-x-0 gap-y-14 sm:gap-x-10 lg:gap-x-16',
        !first && 'border-t border-border pt-16',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  </BandSpanContext.Provider>
);
