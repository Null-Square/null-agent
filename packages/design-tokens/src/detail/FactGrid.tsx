import React from 'react';
import { cn } from '../cn';

/**
 * FactGrid — the labelled facts of a record, in the main column.
 *
 * The kit had `DetailRailField` for the rail and `DetailSection` for prose, but
 * nothing for the plainest thing a detail page does: name a dozen fields and
 * show their values. So every page wrote it again — as the legacy
 * `DescriptionList`, or as a local `Fact` helper, three of which existed by the
 * time anyone noticed they had drifted apart on label size and rule placement.
 *
 * It is a grid of hairline-topped cells, not a table and not a card: the rule
 * above each fact is the only structure, matching `DetailSection`. Values set
 * in mono when they are real data — an id, a version, an address — and sans
 * when they are a sentence, per the brand's mono rule.
 */

export interface FactGridProps extends React.HTMLAttributes<HTMLDListElement> {
  /** Cells across at the widest breakpoint. Two for a rail-width column. */
  columns?: 2 | 3 | 4;
  children: React.ReactNode;
}

const COLUMNS: Record<NonNullable<FactGridProps['columns']>, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

export const FactGrid: React.FC<FactGridProps> = ({
  columns = 3,
  children,
  className,
  ...rest
}) => (
  <dl className={cn('grid grid-cols-1 gap-x-10 gap-y-0', COLUMNS[columns], className)} {...rest}>
    {children}
  </dl>
);

export interface FactProps {
  label: React.ReactNode;
  /** Real data — an id, a host, a version — sets in mono. Prose stays sans. */
  mono?: boolean;
  /** Rendered when `children` is null, undefined or an empty string. */
  empty?: React.ReactNode;
  /** Widen this cell across the grid. */
  span?: 2 | 3 | 4;
  children?: React.ReactNode;
  className?: string;
}

const SPAN: Record<NonNullable<FactProps['span']>, string> = {
  2: 'sm:col-span-2',
  3: 'sm:col-span-2 lg:col-span-3',
  4: 'sm:col-span-2 lg:col-span-4',
};

export const Fact: React.FC<FactProps> = ({
  label,
  mono,
  empty = '—',
  span,
  children,
  className,
}) => {
  const absent = children === null || children === undefined || children === '';
  return (
    <div className={cn('border-t border-border py-3', span && SPAN[span], className)}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1.5 break-words text-[13px]',
          mono && 'font-mono text-[12px]',
          absent ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {absent ? empty : children}
      </dd>
    </div>
  );
};
