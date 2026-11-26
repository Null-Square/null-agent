/**
 * SandboxSelectionService - Sandbox profile and image resolution
 *
 * REFACTORED (Jan 2026): Now uses SandboxImagePort via dependency injection
 * instead of direct database access. This follows hexagonal architecture
 * principles - core domain logic is infrastructure-agnostic.
 *
 * @module agent-brain/core/services
 */

import type { SandboxProfileRegistryPort } from '../../ports';
import type { PolicyEngine } from './PolicyEngine';
import type { ResolvedConfig } from '@/config/configTypes';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import type { SandboxImagePort } from '../../ports';

export type SandboxSelection = {
  sandboxProfile?: string;
  sandboxImage?: string;
};

export class SandboxSelectionService {
  constructor(
    private readonly registry: SandboxProfileRegistryPort,
    private readonly policyFacade: PolicyEngine,
    private readonly config?: ResolvedConfig,
    private readonly sandboxImagePort?: SandboxImagePort,
  ) {}

  async resolve(preparation: SandboxSelection): Promise<SandboxSelection> {
    const sandboxProfile = preparation.sandboxProfile;
    const sandboxImage = preparation.sandboxImage ?? this.registry.resolveImage(sandboxProfile);

    // Validate sandbox policy exists if explicitly provided
    if (sandboxProfile) {
      const policy = await this.policyFacade.getResolver().getBySlug(sandboxProfile);
      if (!policy) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, `Sandbox policy not found: ${sandboxProfile}`, {
          context: { sandboxProfile },
        });
      }
    } else {
      const defaultPolicy = await this.policyFacade.getResolver().getDefaultPolicy();
      if (!defaultPolicy) {
        throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'No default sandbox policy configured.');
      }
    }

    // Validate image build status if port is available and image is specified
    if (sandboxImage && this.sandboxImagePort) {
      const status = await this.sandboxImagePort.getImageBuildStatus(sandboxImage);
      if (status && status !== 'success') {
        throw new AppError(
          ERROR_CODES.RESOURCE_NOT_FOUND,
          `Sandbox image ${sandboxImage} is not built or ready (status=${status}).`,
          { context: { image: sandboxImage, status } },
        );
      }
    }

    return { sandboxProfile, sandboxImage };
  }
}

// Re-export port type for convenience
export type { SandboxImagePort } from '../../ports';
