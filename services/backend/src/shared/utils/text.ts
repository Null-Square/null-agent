/**
 * Text utilities for note/summary generation.
 * 
 * Previously duplicated across 16+ files - now centralized here.
 * 
 * @example
 * import { summarizeForNote, truncateText } from '@/shared/utils/text';
 */

const DEFAULT_NOTE_MAX_CHARS = 180;
const DEFAULT_TITLE_MAX_CHARS = 80;

/**
 * Truncate text for note/summary display with ellipsis.
 * 
 * @param text - The text to truncate
 * @param max - Maximum characters (default: 180)
 * @returns Truncated text with "..." suffix if exceeded
 */
export function summarizeForNote(text: string, max: number = DEFAULT_NOTE_MAX_CHARS): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

/**
 * Truncate text for title display.
 * Shorter default limit than summarizeForNote.
 * 
 * @param text - The text to truncate
 * @param max - Maximum characters (default: 80)
 */
export function truncateTitle(text: string, max: number = DEFAULT_TITLE_MAX_CHARS): string {
  return summarizeForNote(text, max);
}

/**
 * Derive a title from user prompt text.
 * Returns undefined if text is too short or whitespace-only.
 */
export function deriveTitleFromPrompt(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return undefined;
  return truncateTitle(trimmed);
}

// Export constants for files that need custom limits
export const NOTE_MAX_CHARS = DEFAULT_NOTE_MAX_CHARS;
export const TITLE_MAX_CHARS = DEFAULT_TITLE_MAX_CHARS;
