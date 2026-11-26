import React from 'react';

import { cn } from '../cn';
import { Button } from '../Button';

/**
 * ListPager — the one previous/next control under a RecordTable.
 *
 * A seam, not a box: the page controls belong to the table above them, so they
 * hang off its bottom rule rather than sitting in a second bordered card. This
 * was hand-rolled per page, which is how one list said "Prev" and the next
 * said "Previous", and how two of them reported a page number the reader could
 * not act on because the last page was unknowable.
 *
 * The pager renders nothing at all on a single page — a control that can only
 * be pressed to no effect is noise.
 */

export interface ListPagerProps {
  /** Zero-based, so it matches the offset arithmetic pages already do. */
  page: number;
  onPageChange: (page: number) => void;
  /**
   * Whether another page exists. Cursor-style APIs know this; count-style APIs
   * can pass `page + 1 < totalPages`.
   */
  hasMore?: boolean;
  /** Only when the API returns a real total. Omit rather than guess. */
  totalPages?: number;
  className?: string;
}

export const ListPager: React.FC<ListPagerProps> = ({
  page,
  onPageChange,
  hasMore = false,
  totalPages,
  className,
}) => {
  if (page === 0 && !hasMore) return null;

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'mt-6 flex items-center justify-between border-t border-border pt-4',
        className,
      )}
    >
      <span className="font-mono text-[11px] text-muted-foreground">
        Page {page + 1}
        {totalPages ? ` / ${totalPages}` : null}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
        >
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!hasMore} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
};
