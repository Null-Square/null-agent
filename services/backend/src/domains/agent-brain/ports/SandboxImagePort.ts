/**
 * SandboxImagePort - Port interface for sandbox image validation
 *
 * This port abstracts database operations for sandbox image status validation,
 * allowing the core domain to remain infrastructure-agnostic.
 *
 * @module agent-brain/core/ports
 */

/**
 * Build status of a sandbox image.
 */
export type SandboxImageBuildStatus = 'pending' | 'building' | 'success' | 'failed' | string | null;

/**
 * Port interface for sandbox image operations.
 *
 * Implementations:
 * - SandboxImageAdapter (Drizzle/PostgreSQL)
 */
export interface SandboxImagePort {
  /**
   * Get the build status of a sandbox image by its tag.
   * 
   * @param imageTag - The image tag to look up (e.g., 'ghcr.io/null/sandbox:base')
   * @returns The build status or null if image not found
   */
  getImageBuildStatus(imageTag: string): Promise<SandboxImageBuildStatus>;
}
