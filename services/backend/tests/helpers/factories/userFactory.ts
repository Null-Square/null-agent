/**
 * User Test Factory
 * 
 * Provides typed factory functions for creating test user data.
 * 
 * @example
 * ```typescript
 * import { createUser, createAdminUser } from '@/tests/helpers/factories/userFactory';
 * 
 * const user = createUser({ email: 'test@example.com' });
 * const admin = createAdminUser();
 * ```
 */

import { v4 as uuidv4 } from 'uuid';
import type { UserRowDTO, UserResponseDTO } from '@/shared/types/dtos';

// =============================================================================
// User Factory
// =============================================================================

type UserRowOverrides = Partial<UserRowDTO>;

/**
 * Create a test UserRowDTO with sensible defaults.
 */
export function createUserRow(overrides: UserRowOverrides = {}): UserRowDTO {
  const id = overrides.id ?? `user-${uuidv4()}`;
  
  return {
    id,
    email: `${id}@test.example.com`,
    role: 'user',
    email_verified: true,
    disabled: false,
    created_at: new Date(),
    last_login_at: new Date(),
    ...overrides,
  };
}

/**
 * Create an admin user row.
 */
export function createAdminUserRow(overrides: UserRowOverrides = {}): UserRowDTO {
  return createUserRow({ role: 'admin', ...overrides });
}

// =============================================================================
// User Response Factory
// =============================================================================

type UserResponseOverrides = Partial<UserResponseDTO>;

/**
 * Create a test UserResponseDTO with sensible defaults.
 */
export function createUserResponse(overrides: UserResponseOverrides = {}): UserResponseDTO {
  const id = overrides.id ?? `user-${uuidv4()}`;
  
  return {
    id,
    email: `${id}@test.example.com`,
    role: 'user',
    email_verified: true,
    disabled: false,
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Batch Factories
// =============================================================================

/**
 * Create multiple users for testing pagination.
 */
export function createUserRows(count: number, overrides: UserRowOverrides = {}): UserRowDTO[] {
  return Array.from({ length: count }, () => createUserRow(overrides));
}
