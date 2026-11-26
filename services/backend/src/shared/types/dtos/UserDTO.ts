/**
 * User DTOs - API Response Types
 *
 * These types replace `any` usage in admin user handlers.
 */

// =============================================================================
// Database Row Types (from userService)
// =============================================================================

/**
 * User row as returned from userService queries.
 */
export interface UserRowDTO {
  id: string;
  email: string;
  role: string;
  email_verified?: boolean;
  disabled?: boolean;
  created_at?: Date | string;
  last_login_at?: Date | string | null;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * User response for GET /users/:id endpoint.
 */
export interface UserResponseDTO {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  disabled: boolean;
  created_at?: string;
  last_login_at: string | null;
}

/**
 * Enriched user response for GET /users (list) endpoint.
 */
export interface EnrichedUserResponseDTO extends UserResponseDTO {
  location: string;
  risk: string;
  tasks: number;
  lastSeen: string;
}

