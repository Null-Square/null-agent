/**
 * PolicyResolver - Centralized policy resolution with caching
 *
 * REFACTORED (Jan 2026): Now accepts PolicyRepositoryPort for hexagonal compliance.
 * Core domain logic remains infrastructure-agnostic.
 *
 * @module agent-brain/core/policy
 */

import type { PolicyWithSpec, PolicyRepositoryPort } from './PolicyService';
import { PolicyService } from './PolicyService';

export type ResolvedPolicyResult = {
  policy: PolicyWithSpec;
  source: 'explicit' | 'default';
};

/**
 * Centralized policy resolver with a tiny in-memory cache.
 * Unifies the logic for:
 * - default sandbox/tool policy selection
 * - explicit profile lookup
 */
export class PolicyResolver {
  private readonly policyService: PolicyService;
  private readonly cacheBySlug = new Map<string, PolicyWithSpec | null>();
  private cachedDefault: PolicyWithSpec | null | undefined;

  /**
   * Create a PolicyResolver.
   * @param repositoryOrService - Either a PolicyRepositoryPort (for DI) or a PolicyService instance
   */
  constructor(
    repositoryOrService: PolicyRepositoryPort | PolicyService
  ) {
    if (repositoryOrService instanceof PolicyService) {
      this.policyService = repositoryOrService;
      return;
    }
    if (!repositoryOrService) {
      throw new Error('policy.resolver_uninitialized');
    }
    this.policyService = new PolicyService(repositoryOrService);
  }

  resetCache(): void {
    this.cacheBySlug.clear();
    this.cachedDefault = undefined;
  }

  async getBySlug(slug: string): Promise<PolicyWithSpec | null> {
    if (this.cacheBySlug.has(slug)) {
      return this.cacheBySlug.get(slug) ?? null;
    }
    const result = await this.policyService.getBySlug(slug);
    this.cacheBySlug.set(slug, result);
    return result;
  }

  async getDefaultPolicy(): Promise<PolicyWithSpec | null> {
    if (this.cachedDefault !== undefined) {
      return this.cachedDefault;
    }
    const result = await this.policyService.getDefaultPolicy();
    this.cachedDefault = result;
    return result;
  }

  /**
   * Resolve the policy to use for sandbox + tools.
   * Order:
   * 1) explicit profile if provided and exists
   * 2) DB default policy
   */
  async resolvePolicy(profile?: string | null): Promise<ResolvedPolicyResult> {
    const trimmed = typeof profile === 'string' ? profile.trim() : '';
    if (trimmed.length > 0) {
      const explicit = await this.getBySlug(trimmed);
      if (explicit) {
        return { policy: explicit, source: 'explicit' };
      }
    }

    const fallback = await this.getDefaultPolicy();
    if (fallback) {
      return { policy: fallback, source: 'default' };
    }

    throw new Error('policy.default_missing');
  }
}

