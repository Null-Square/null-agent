import type { SandboxConfig } from './types';
import type { DockerCreateOptions } from './DockerDriver';
import type { ResolvedCapabilityProfile } from './capabilityProfiles';

export class PolicyEnforcer {
  constructor(private readonly config: SandboxConfig) {}

  applySecurityDefaults(
    options: DockerCreateOptions,
    profile: ResolvedCapabilityProfile,
  ): DockerCreateOptions {
    const securityOpts: string[] = [];

    if (profile.privileged) {
      securityOpts.push('apparmor=unconfined', 'seccomp=unconfined');
    } else {
      if (profile.capAdd.length === 0) {
        securityOpts.push('no-new-privileges');
      }
      if (options.securityOpts) {
        securityOpts.push(...options.securityOpts);
      }
    }

    return {
      ...options,
      network: profile.network,
      readonlyRootfs: profile.readonlyRootfs,
      user: profile.privileged ? 'root' : this.config.user,
      cpuQuota: options.cpuQuota ?? this.config.cpuQuota,
      memoryMb: options.memoryMb ?? this.config.memoryMb,
      pidsLimit: options.pidsLimit ?? this.config.pidsLimit,
      seccompProfilePath: profile.privileged
        ? undefined
        : options.seccompProfilePath ?? this.config.seccompProfilePath,
      capDrop: profile.privileged ? [] : profile.capDrop,
      capAdd: profile.privileged ? [] : profile.capAdd,
      privileged: profile.privileged,
      securityOpts: securityOpts.length > 0 ? securityOpts : undefined,
    };
  }
}
