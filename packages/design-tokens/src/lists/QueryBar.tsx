import React from 'react';

import { cn } from '../cn';

/**
 * QueryBar — the ONE filter control, shared by every list page.
 *
 * Brand system, Chapter IV ("One bar, six lists"): findings, exposures, assets,
 * runs, compliance and evidence all filter the same way — search text plus one
 * or two enumerations. That is one control, so no page builds its own again.
 *
 * No box around it, no label above it: hairline fields on black. Facets are
 * `<FacetSelect>` children — pass as many as the page really needs, the grid
 * adapts.
 *
 * The doc pairs this bar with a result count ("38 findings"). We dropped it
 * (2026-08-11): once a page carries a `ListMetrics` strip, a small mono tally
 * hanging off the filters restates it and reads as leftover chrome. The list
 * itself is the count, and `ListEmptyState`'s filtered variant still names the
 * over-filtered case, which is the one moment the number mattered.
 */

export interface QueryBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  /**
   * Accessible name for the search input itself. Without it the field's only
   * name is its placeholder, which assistive tech is not obliged to announce.
   */
  searchAriaLabel?: string;
  /** One or more <FacetSelect> elements. */
  facets?: React.ReactNode;
  /** Trailing controls, e.g. a view toggle. */
  trailing?: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="flex-none">
    <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.2 10.2 L14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </svg>
);

export const QueryBar: React.FC<QueryBarProps> = ({
  search,
  onSearchChange,
  searchPlaceholder = 'Search',
  searchAriaLabel,
  facets,
  trailing,
  className,
  'aria-label': ariaLabel = 'Filter list',
}) => {
  return (
    <div role="search" aria-label={ariaLabel} className={cn('ns-query-bar', className)}>
      <div className="ns-query-bar__search flex h-[46px] items-center gap-3 border border-border px-4 transition-colors focus-within:border-primary">
        <span className="text-muted-foreground">
          <SearchGlyph />
        </span>
        <input
          type="search"
          value={search}
          aria-label={searchAriaLabel ?? searchPlaceholder}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground caret-primary outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
        />
      </div>

      {facets}

      {trailing ? <div className="ns-query-bar__trailing">{trailing}</div> : null}
    </div>
  );
};
