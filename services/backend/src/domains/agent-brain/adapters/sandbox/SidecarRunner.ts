import { type DockerDriver, type DockerCreateOptions } from './DockerDriver';
import { type PolicyEnforcer } from './PolicyEnforcer';
import { type ImageResolver, type ImageRequest } from './ImageResolver';
import type { ResolvedCapabilityProfile } from './capabilityProfiles';

export type SidecarOptions = ImageRequest & {
  name: string;
  shareNetworkWith: string;
  workspaceMount: string;
  command?: string[];
  env?: Record<string, string>;
  readonlyRootfs?: boolean;
  capabilityProfile?: string;
  labels?: Record<string, string>;
};

export class SidecarRunner {
  constructor(
    private readonly docker: DockerDriver,
    private readonly policy: PolicyEnforcer,
    private readonly imageResolver: ImageResolver,
  ) {}

  async run(options: SidecarOptions, profile: ResolvedCapabilityProfile): Promise<string> {
    const image = this.imageResolver.resolve(options);
    const createOptions: DockerCreateOptions = {
      image,
      name: options.name,
      network: { shareWith: options.shareNetworkWith },
      readonlyRootfs: profile.readonlyRootfs,
      mounts: [
        {
          source: options.workspaceMount,
          target: '/workspace',
          readOnly: false,
        },
      ],
      env: options.env,
      command: options.command,
      capDrop: profile.capDrop,
      capAdd: profile.capAdd,
      privileged: profile.privileged,
      securityOpts: [],
      labels: options.labels,
      // TODO(P2): SidecarRunner should receive user config from parent, not hardcode.
      // Currently always 'root' for Docker sandbox isolation.
      user: 'root',
    };

    const secured = this.policy.applySecurityDefaults(createOptions, profile);

    const containerId = await this.docker.create(secured);
    return containerId;
  }

  async destroy(containerId: string): Promise<void> {
    await this.docker.destroy(containerId);
  }
}
