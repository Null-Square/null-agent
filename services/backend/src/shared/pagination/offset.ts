/**
 * Offset-Based Pagination Utilities
 * 
 * Helpers for implementing simple offset-based pagination.
 * Use for lists where total count is meaningful.
 */

import type { OffsetPage, OffsetPaginationMeta } from '@null-ai/contracts';

/**
 * Build an offset page result.
 * 
 * @param data - Items for this page
 * @param total - Total count of all items
 * @param limit - Page size
 * @param offset - Items skipped
 * 
 * @example
 * const [data, total] = await Promise.all([
 *   db.select().from(table).limit(limit).offset(offset),
 *   db.select({ count: count() }).from(table),
 * ]);
 * return buildOffsetPage(data, total[0].count, limit, offset);
 */
export function buildOffsetPage<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number,
): OffsetPage<T> {
  const meta: OffsetPaginationMeta = {
    total,
    limit,
    offset,
    hasMore: offset + data.length < total,
  };
  
  return { data, meta };
}

/**
 * Calculate total pages from total count and limit.
 */
export function calculateTotalPages(total: number, limit: number): number {
  return Math.ceil(total / limit);
}

/**
 * Calculate current page number from offset and limit.
 * Page numbers are 1-indexed.
 */
export function calculateCurrentPage(offset: number, limit: number): number {
  return Math.floor(offset / limit) + 1;
}

/**
 * Convert page number to offset.
 * Page numbers are 1-indexed.
 */
export function pageToOffset(page: number, limit: number): number {
  return Math.max(0, (page - 1) * limit);
}
