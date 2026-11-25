import React from 'react';

import { cn } from '../cn';

/**
 * StatusTabs — the one tab strip, for navigation between page contents.
 *
 * Framework pickers, Controls / Evidence / Integrations — anything where the
 * choice changes *what the page is showing*, not which rows survive a filter.
 *
 * **Not for filtering a list.** A strip of statuses above a query bar is a
 * second filter language stacked on the first, and reads as noise (decided
 * 2026-08-11). Anything that narrows the rows below it is a `FacetSelect`
 * inside the one `QueryBar` line — findings status, exposure state, the asset
 * inventory lane and the compliance monitoring lane all moved there.
 *
 * On a list page the active underline is the page's one yellow (`tone="signal"`).
 * On a detail page the rail's verb owns the yellow, so the marker goes bone
 * (`tone="bone"`). Counts are real numbers — mono, tabular, and dim, because
 * the label is what you are aiming at.
 */

export interface StatusTabItem {
  value: string;
  label: string;
  count?: number;
  /**
   * A glyph for tabs that are destinations rather than filters — a settings
   * section is a place, and the icon set exists to name places. Filter strips
   * leave this off: a status is not somewhere you go.
   */
  icon?: React.ReactNode;
}

export interface StatusTabsProps {
  items: StatusTabItem[];
  value: string;
  onChange: (value: string) => void;
  tone?: 'signal' | 'bone';
  /** Extra attributes per tab (product-tour anchors, test ids). */
  itemAttributes?: (item: StatusTabItem) => Record<string, string | undefined>;
  className?: string;
  'aria-label'?: string;
}

export const StatusTabs: React.FC<StatusTabsProps> = ({
  items,
  value,
  onChange,
  tone = 'signal',
  itemAttributes,
  className,
  'aria-label': ariaLabel = 'Filter by status',
}) => (
  <div
    role="tablist"
    aria-label={ariaLabel}
    className={cn('flex flex-wrap items-center gap-x-1 border-b border-border/60', className)}
  >
    {items.map((item) => {
      const active = item.value === value;
      return (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={active}
          {...(itemAttributes?.(item) ?? {})}
          onClick={() => onChange(item.value)}
          className={cn(
            'relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {item.icon ? <span className="flex flex-none">{item.icon}</span> : null}
          {item.label}
          {item.count != null ? (
            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">{item.count}</span>
          ) : null}
          {active ? (
            <span
              aria-hidden
              className={cn(
                'absolute inset-x-0 -bottom-px h-0.5',
                tone === 'signal' ? 'bg-primary' : 'bg-foreground',
              )}
            />
          ) : null}
        </button>
      );
    })}
  </div>
);
