import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { resolveCapabilityProfile } from '@/domains/agent-brain/adapters/sandbox';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';

const makePolicy = (slug: string, sandbox: any = {}) =>
  ({
    id: slug,
    slug,
    parsedSpec: { sandbox, tools: {} },
  } as any);

describe('resolveCapabilityProfile', () => {
  it('throws when requesting privileged without dev_unsafe', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => makePolicy('hardened', { privileged: true })),
      getBySlug: vi.fn(async () => makePolicy('hardened', { privileged: true })),
    } as any);

    await expect(
      resolveCapabilityProfile('hardened', { sandbox: { devUnsafe: false } } as any, resolver),
    ).rejects.toThrow('policy.capabilities.privileged_requires_dev_unsafe');
  });

  it('uses default profile when explicit missing', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => makePolicy('bridge-readonly', { network: 'bridge' })),
      getBySlug: vi.fn(async () => null),
    } as any);

    const profile = await resolveCapabilityProfile(undefined, { sandbox: { network: 'bridge' } } as any, resolver);

    expect(profile.name).toBe('bridge-readonly');
    expect(profile.network).toBe('bridge');
  });

  it('puts every sandbox on the deployment network, even when a policy names another', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => makePolicy('network-enabled', { network: 'bridge' })),
      getBySlug: vi.fn(async () => null),
    } as any);

    const profile = await resolveCapabilityProfile(
      undefined,
      { sandbox: { network: 'null-ai-sandbox' } } as any,
      resolver,
    );

    expect(profile.network).toBe('null-ai-sandbox');
  });

  it('lets a policy turn networking off, and nothing more', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => makePolicy('offline', { network: 'none' })),
      getBySlug: vi.fn(async () => null),
    } as any);

    const profile = await resolveCapabilityProfile(
      undefined,
      { sandbox: { network: 'null-ai-sandbox' } } as any,
      resolver,
    );

    expect(profile.network).toBe('none');
  });

  it('preserves a configured Docker network name for sandbox/browser proxy parity', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => makePolicy('webpentest-core', {})),
      getBySlug: vi.fn(async () => null),
    } as any);

    const profile = await resolveCapabilityProfile(
      undefined,
      { sandbox: { network: 'nullai-db_default' } } as any,
      resolver,
    );

    expect(profile.network).toBe('nullai-db_default');
  });

  it('throws when no default sandbox policy is configured', async () => {
    const resolver = {
      getDefaultPolicy: vi.fn(async () => null),
      getBySlug: vi.fn(async () => null),
      resolvePolicy: vi.fn(async () => {
        throw new Error('policy.default_missing');
      }),
    } as any;

    await expect(
      resolveCapabilityProfile(undefined, { sandbox: {} } as any, resolver),
    ).rejects.toThrow('policy.default_missing');
  });

  // REMOVED Dec 2025: 'selects env-specific defaults (stage/prod)' test
  // stageProfile/prodProfile feature removed - single defaultProfile now used for all environments
});







