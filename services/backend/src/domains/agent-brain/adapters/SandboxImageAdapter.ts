/**
 * SandboxImageAdapter - File-config backed implementation of SandboxImagePort.
 *
 * Docker profile and sandbox image DB tables were removed from the baseline schema.
 * This adapter now validates image tags against config/sandbox/profiles.json.
 */

import { loadSandboxProfilesConfig } from '@/config/sandboxProfilesConfig';
import type { SandboxImagePort, SandboxImageBuildStatus } from '../ports';

export class SandboxImageAdapter implements SandboxImagePort {
  private knownImageTagsPromise: Promise<Set<string>> | null = null;

  private async getKnownImageTags(): Promise<Set<string>> {
    if (!this.knownImageTagsPromise) {
      this.knownImageTagsPromise = loadSandboxProfilesConfig().then((config) => {
        const tags = Object.values(config.profiles);
        return new Set(tags);
      });
    }
    return this.knownImageTagsPromise;
  }

  async getImageBuildStatus(imageTag: string): Promise<SandboxImageBuildStatus> {
    const knownImageTags = await this.getKnownImageTags();
    return knownImageTags.has(imageTag) ? 'success' : null;
  }
}

export const sandboxImageAdapter = new SandboxImageAdapter();
