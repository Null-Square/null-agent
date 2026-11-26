/**
 * PolicyService - Domain service for policy operations
 *
 * REFACTORED (Jan 2026): Now uses PolicyRepositoryPort via dependency injection
 * instead of direct database access. This follows hexagonal architecture
 * principles - core domain logic is infrastructure-agnostic.
 *
 * @module agent-brain/core/policy
 */

import type {
  PolicyRepositoryPort,
  PolicyWithSpec,
} from '../../ports';

// Re-export types for convenience
export type { SandboxPolicySpec, PolicySpec, PolicyWithSpec } from '../../ports';

/**
 * Domain service for policy operations.
 *
 * Delegates persistence to PolicyRepositoryPort, keeping this service
 * focused on business logic.
 */
export class PolicyService {
  constructor(private readonly repository: PolicyRepositoryPort) {}

  async getBySlug(slug: string): Promise<PolicyWithSpec | null> {
    return this.repository.getBySlug(slug);
  }

  async getById(id: string): Promise<PolicyWithSpec | null> {
    return this.repository.getById(id);
  }

  async getDefaultPolicy(): Promise<PolicyWithSpec | null> {
    return this.repository.getDefaultPolicy();
  }

  // Legacy helper retained for callers expecting a sandbox-only default
  async getDefaultSandboxPolicy(): Promise<PolicyWithSpec | null> {
    return this.getDefaultPolicy();
  }
}

// Re-export port type
export type { PolicyRepositoryPort } from '../../ports';
