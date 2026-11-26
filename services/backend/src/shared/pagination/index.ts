/**
 * Pagination Utilities
 * 
 * Shared helpers for implementing consistent pagination across the backend.
 * 
 * @example
 * import { buildCursorPage, encodeCursor, decodeCursor } from '@/shared/pagination';
 * import { buildOffsetPage } from '@/shared/pagination';
 */

// Cursor-based pagination (preferred)
export {
  encodeCursor,
  decodeCursor,
  buildCursorPage,
  clampLimit,
} from './cursor';

// Offset-based pagination (legacy/simple)
export {
  buildOffsetPage,
  calculateTotalPages,
  calculateCurrentPage,
  pageToOffset,
} from './offset';

// Re-export types from contracts for convenience
export type {
  CursorPaginationInput,
  CursorPaginationMeta,
  CursorPage,
  OffsetPaginationInput,
  OffsetPaginationMeta,
  OffsetPage,
} from '@null-ai/contracts';

export {
  cursorPaginationInputSchema,
  offsetPaginationInputSchema,
  parseCursorPaginationInput,
  parseOffsetPaginationInput,
} from '@null-ai/contracts';
