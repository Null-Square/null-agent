/**
 * Pagination Types
 * 
 * Shared pagination types for consistent API design across services.
 * Supports both cursor-based (preferred) and offset-based pagination.
 */

import { z } from 'zod';

// ============================================================================
// Cursor-Based Pagination (Preferred for Most APIs)
// ============================================================================

/**
 * Input schema for cursor-based pagination.
 * Use for APIs that need stable pagination across concurrent updates.
 */
export const cursorPaginationInputSchema = z.object({
  /** Maximum items to return (1-100, default 20) */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque cursor from previous page */
  cursor: z.string().optional(),
  /** Pagination direction */
  direction: z.enum(['forward', 'backward']).default('forward'),
});

export type CursorPaginationInput = z.infer<typeof cursorPaginationInputSchema>;

/**
 * Metadata for cursor-paginated responses.
 */
export const cursorPaginationMetaSchema = z.object({
  /** Whether more items exist beyond this page */
  hasMore: z.boolean(),
  /** Cursor for the next page (undefined if no more items) */
  nextCursor: z.string().optional(),
  /** Cursor for the previous page (optional, for bidirectional navigation) */
  prevCursor: z.string().optional(),
});

export type CursorPaginationMeta = z.infer<typeof cursorPaginationMetaSchema>;

/**
 * Generic cursor-paginated response.
 * @template T The type of items in the page
 */
export interface CursorPage<T> {
  data: T[];
  meta: CursorPaginationMeta;
}

// ============================================================================
// Offset-Based Pagination (Simple Cases / Legacy)
// ============================================================================

/**
 * Input schema for offset-based pagination.
 * Use for simple lists where total count is needed.
 */
export const offsetPaginationInputSchema = z.object({
  /** Maximum items to return (1-100, default 20) */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Number of items to skip (default 0) */
  offset: z.coerce.number().int().min(0).default(0),
});

export type OffsetPaginationInput = z.infer<typeof offsetPaginationInputSchema>;

/**
 * Metadata for offset-paginated responses.
 */
export const offsetPaginationMetaSchema = z.object({
  /** Total number of items (across all pages) */
  total: z.number().int(),
  /** Items per page (from request) */
  limit: z.number().int(),
  /** Items skipped (from request) */
  offset: z.number().int(),
  /** Whether more items exist beyond this page */
  hasMore: z.boolean(),
});

export type OffsetPaginationMeta = z.infer<typeof offsetPaginationMetaSchema>;

/**
 * Generic offset-paginated response.
 * @template T The type of items in the page
 */
export interface OffsetPage<T> {
  data: T[];
  meta: OffsetPaginationMeta;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate cursor pagination input.
 * Returns validated input with defaults applied.
 */
export function parseCursorPaginationInput(input: unknown): CursorPaginationInput {
  return cursorPaginationInputSchema.parse(input);
}

/**
 * Parse and validate offset pagination input.
 * Returns validated input with defaults applied.
 */
export function parseOffsetPaginationInput(input: unknown): OffsetPaginationInput {
  return offsetPaginationInputSchema.parse(input);
}
