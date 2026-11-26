/**
 * Cursor-Based Pagination Utilities
 * 
 * Helpers for implementing stable cursor-based pagination.
 * Uses base64-encoded composite keys (createdAt|id) for cursors.
 */

import type { CursorPage, CursorPaginationMeta } from '@null-ai/contracts';

/**
 * Encode a cursor from row data.
 * Uses base64 encoding of composite key (createdAt|id).
 * 
 * @example
 * const cursor = encodeCursor(lastRow);
 * // Returns: "MjAyNS0xMi0zMVQxMjowMDowMC4wMDBafGFiYzEyMw=="
 */
export function encodeCursor<T extends { createdAt: Date; id: string }>(row: T): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64');
}

/**
 * Decode a cursor to row data.
 * Returns undefined for invalid cursors (graceful handling).
 * 
 * @example
 * const { createdAt, id } = decodeCursor(cursor) ?? {};
 */
export function decodeCursor(cursor?: string): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [ts, id] = decoded.split('|');
    if (!ts || !id) return undefined;
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return undefined;
    return { createdAt: date, id };
  } catch {
    return undefined;
  }
}

/**
 * Build a cursor page result from query results.
 * 
 * Uses the "limit + 1" pattern:
 * - Query for `limit + 1` rows
 * - If we get more than `limit`, there's another page
 * - Return only `limit` rows, with cursor for next page
 * 
 * @param rows - Rows from database query (should query for limit + 1)
 * @param limit - Requested page size
 * @param direction - Pagination direction
 * 
 * @example
 * // In repository:
 * const rows = await db.select().from(table).limit(limit + 1);
 * return buildCursorPage(rows, limit, 'forward');
 */
export function buildCursorPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
  direction: 'forward' | 'backward' = 'forward',
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const data = direction === 'backward' ? slice.reverse() : slice;
  
  // Get cursor row based on direction
  const cursorRow = direction === 'backward' ? data[0] : data[data.length - 1];
  const nextCursor = cursorRow ? encodeCursor(cursorRow) : undefined;
  
  const meta: CursorPaginationMeta = {
    hasMore,
    nextCursor,
  };
  
  return { data, meta };
}

/**
 * Clamp a limit value to safe bounds.
 * 
 * @param limit - Requested limit
 * @param defaultLimit - Default if not provided (default: 20)
 * @param maxLimit - Maximum allowed (default: 100)
 */
export function clampLimit(
  limit: number | undefined,
  defaultLimit = 20,
  maxLimit = 100,
): number {
  if (limit === undefined) return defaultLimit;
  return Math.min(Math.max(limit, 1), maxLimit);
}
