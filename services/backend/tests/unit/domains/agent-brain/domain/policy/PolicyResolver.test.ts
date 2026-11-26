import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';

describe('PolicyResolver', () => {
  const makePolicy = (slug: string) =>
    ({
      id: slug,
      slug,
      spec: {},
      parsedSpec: { sandbox: {}, tools: {} },
    } as any);

  it('returns explicit policy when provided', async () => {
    const policyService = {
      getBySlug: vi.fn(async (slug: string) => (slug === 'explicit' ? makePolicy(slug) : null)),
      getDefaultPolicy: vi.fn(async () => makePolicy('default-db')),
    } as any;
    const resolver = new PolicyResolver(policyService);

    const result = await resolver.resolvePolicy('explicit');

    expect(result.policy.slug).toBe('explicit');
    expect(result.source).toBe('explicit');
  });

  it('falls back to DB default when no explicit or config match', async () => {
    const dbDefault = makePolicy('db-default');
    const policyService = {
      getBySlug: vi.fn(async () => null),
      getDefaultPolicy: vi.fn(async () => dbDefault),
    } as any;
    const resolver = new PolicyResolver(policyService);

    const result = await resolver.resolvePolicy(undefined);

    expect(result.policy.slug).toBe('db-default');
    expect(result.source).toBe('default');
  });

  it('throws when no defaults exist', async () => {
    const policyService = {
      getBySlug: vi.fn(async () => null),
      getDefaultPolicy: vi.fn(async () => null),
    } as any;
    const resolver = new PolicyResolver(policyService);

    await expect(resolver.resolvePolicy(undefined)).rejects.toThrow('policy.default_missing');
  });

  // REMOVED Dec 2025: 'prefers environment-specific config defaults (stage/prod)' test
  // stageProfile/prodProfile feature removed - single defaultProfile now used for all environments
});







