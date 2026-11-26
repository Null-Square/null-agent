import { describe, it, expect } from 'vitest';
import { PolicyEnforcer } from '@/domains/agent-brain/adapters/sandbox';

describe('PolicyEnforcer', () => {
  it('applies non-privileged defaults and preserves security options', () => {
    const config = { user: 'agent', seccompProfilePath: '/seccomp.json' } as any;
    const enforcer = new PolicyEnforcer(config);
    const options = {
      image: 'img',
      name: 'sandbox',
      network: 'none',
      readonlyRootfs: false,
      securityOpts: ['label=disable'],
      capDrop: [],
      capAdd: [],
    } as any;
    const profile = {
      privileged: false,
      readonlyRootfs: true,
      network: 'bridge',
      capDrop: ['ALL'],
      capAdd: [],
    } as any;

    const result = enforcer.applySecurityDefaults(options, profile);

    expect(result).toEqual(
      expect.objectContaining({
        network: 'bridge',
        readonlyRootfs: true,
        user: 'agent',
        seccompProfilePath: '/seccomp.json',
        capDrop: ['ALL'],
        capAdd: [],
        privileged: false,
      }),
    );
    expect(result.securityOpts).toEqual(['no-new-privileges', 'label=disable']);
  });

  it('forces privileged profiles to run as root with unconfined security', () => {
    const config = { user: 'agent', seccompProfilePath: '/seccomp.json' } as any;
    const enforcer = new PolicyEnforcer(config);
    const options = {
      image: 'img',
      name: 'sandbox',
      network: 'none',
      readonlyRootfs: false,
      securityOpts: ['label=disable'],
      capDrop: ['ALL'],
      capAdd: ['NET_ADMIN'],
      seccompProfilePath: '/override.json',
    } as any;
    const profile = {
      privileged: true,
      readonlyRootfs: false,
      network: 'bridge',
      capDrop: ['ALL'],
      capAdd: ['NET_ADMIN'],
    } as any;

    const result = enforcer.applySecurityDefaults(options, profile);

    expect(result).toEqual(
      expect.objectContaining({
        network: 'bridge',
        readonlyRootfs: false,
        user: 'root',
        seccompProfilePath: undefined,
        capDrop: [],
        capAdd: [],
        privileged: true,
      }),
    );
    expect(result.securityOpts).toEqual(['apparmor=unconfined', 'seccomp=unconfined']);
  });

  it('avoids no-new-privileges when capAdd is present', () => {
    const config = { user: 'agent', seccompProfilePath: '/seccomp.json' } as any;
    const enforcer = new PolicyEnforcer(config);
    const options = {
      image: 'img',
      name: 'sandbox',
      network: 'none',
      readonlyRootfs: false,
      capDrop: [],
      capAdd: ['NET_RAW'],
    } as any;
    const profile = {
      privileged: false,
      readonlyRootfs: false,
      network: 'bridge',
      capDrop: ['ALL'],
      capAdd: ['NET_RAW'],
    } as any;

    const result = enforcer.applySecurityDefaults(options, profile);

    expect(result).toEqual(
      expect.objectContaining({
        network: 'bridge',
        readonlyRootfs: false,
        user: 'agent',
        seccompProfilePath: '/seccomp.json',
        capDrop: ['ALL'],
        capAdd: ['NET_RAW'],
        privileged: false,
      }),
    );
    expect(result.securityOpts).toBeUndefined();
  });
});
