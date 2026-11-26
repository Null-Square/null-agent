/**
 * Message DTOs - API Response Types
 *
 * These types replace `any` usage in toMessageResponse() and related handlers.
 */

// =============================================================================
// Database Row Types (from MessageRepository)
// =============================================================================

/**
 * Message row as returned from MessageRepository.
 * Note: Database returns null for absent values, not undefined.
 */
export interface MessageRowDTO {
  id: string;
  role: string;
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
  createdAt?: Date | number | string | null;
  timestamp?: number | null;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Message response for GET /sessions/:id/messages endpoint.
 * Note: Preserves null from database instead of converting to undefined.
 */
export interface MessageResponseDTO {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
  timestamp: number;
  createdAt?: string;
}

/**
 * Tool call embedded in assistant messages.
 */
export interface ToolCallDTO {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
