import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { resolveCapabilityProfile } from '@/domains/agent-brain/adapters/sandbox';

const makePolicy = (slug: string, sandbox: Record<string, unknown> = {}) =>
  ({
    id: slug,
    slug,
    parsedSpec: { sandbox, tools: {} },
  } as any);

describe('PolicyResolver contract', () => {
  // REMOVED Dec 2025: 'prefers env-specific defaults from config when resolving' test
  // stageProfile/prodProfile feature removed - single defaultProfile now used for all environments

  it('throws when no sandbox policies are configured', async () => {
    const resolver = new PolicyResolver({
      getDefaultPolicy: vi.fn(async () => null),
      getBySlug: vi.fn(async () => null),
    } as any);

    await expect(resolver.resolvePolicy()).rejects.toThrow('policy.default_missing');
  });
});

describe('Sandbox capability guard', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('rejects privileged profiles unless dev_unsafe is enabled', async () => {
    const resolver = new PolicyResolver(
      {
        getDefaultPolicy: vi.fn(async () => makePolicy('privileged', { privileged: true })),
        getBySlug: vi.fn(async () => makePolicy('privileged', { privileged: true })),
        resolvePolicy: vi.fn(async () => ({ policy: makePolicy('privileged', { privileged: true }), source: 'default' })),
      } as any,
    );

    await expect(
      resolveCapabilityProfile('privileged', { sandbox: { devUnsafe: false } } as any, resolver),
    ).rejects.toThrow('policy.capabilities.privileged_requires_dev_unsafe');
  });

  it('allows privileged profiles in non-prod when dev_unsafe is enabled', async () => {
    process.env.NODE_ENV = 'development';
    const resolver = new PolicyResolver(
      {
        getDefaultPolicy: vi.fn(async () => makePolicy('privileged', { privileged: true })),
        getBySlug: vi.fn(async () => makePolicy('privileged', { privileged: true })),
      } as any,
    );

    const profile = await resolveCapabilityProfile('privileged', { sandbox: { devUnsafe: true } } as any, resolver);

    expect(profile.name).toBe('privileged');
    expect(profile.privileged).toBe(true);
  });
});






