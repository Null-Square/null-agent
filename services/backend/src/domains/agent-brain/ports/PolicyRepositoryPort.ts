/**
 * PolicyRepositoryPort - Port interface for policy persistence
 *
 * This port abstracts policy storage operations,
 * allowing the core domain to remain infrastructure-agnostic.
 *
 * @module agent-brain/core/ports
 */

import type { ToolAccessPolicy } from '../domain/types';

/**
 * Sandbox policy specification.
 */
export interface SandboxPolicySpec {
  network?: 'none' | 'bridge' | `container:${string}` | (string & {});
  readonlyRootfs?: boolean;
  capDrop?: string[];
  capAdd?: string[];
  privileged?: boolean;
  seccompProfilePath?: string | null;
  user?: string;
}

/**
 * Policy specification combining sandbox and tool policies.
 */
export interface PolicySpec {
  sandbox?: SandboxPolicySpec;
  tools?: ToolAccessPolicy;
  toolPolicy?: ToolAccessPolicy; // backwards-compatible key
}

/**
 * Domain representation of a policy with parsed spec.
 * Matches the runtime policy shape used by resolver/facade.
 */
export interface PolicyWithSpec {
  id: string;
  slug: string;
  name: string;
  spec: Record<string, unknown>;
  isDefaultSandbox?: boolean;
  createdAt: Date;
  updatedAt: Date;
  parsedSpec: PolicySpec;
  sandboxImage?: string;
  /**
   * Declared image name from the yaml `sandboxImageName` field. Surfaced to
   * the admin catalog so operators can see which docker image a policy is
   * pinned to. Distinct from `sandboxImage` which is a runtime override.
   */
  sandboxImageName?: string;
}

/**
 * Port interface for policy repository operations.
 *
 * Implementations:
 * - PolicyConfigRepositoryAdapter (file-backed in-memory)
 */
export interface PolicyRepositoryPort {
  /**
   * Get a policy by slug.
   */
  getBySlug(slug: string): Promise<PolicyWithSpec | null>;

  /**
   * Get a policy by ID.
   */
  getById(id: string): Promise<PolicyWithSpec | null>;

  /**
   * Get the default policy (marked as isDefaultSandbox = true).
   */
  getDefaultPolicy(): Promise<PolicyWithSpec | null>;
}
