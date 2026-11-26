/**
 * The API resolver — S1's Gate B, at the unit level.
 *
 * The claim S1 has to defend is "production did not move". The strongest form of that claim is
 * that the API path reaches the *same objects* through narrower types, and caches them in the same
 * places, so there is nothing left for a behaviour difference to hide in. These tests pin exactly
 * that, because the caching moved from `OrchestratorAdapter` into this class and a resolver that
 * quietly re-created providers would change request identity and cache lineage with no error
 * anywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiModelExecutionResolver } from '@/domains/agent-brain/adapters/execution/ApiModelExecutionResolver';
import type { ChatProvider, ModelConfig, ProviderFactoryPort } from '@/domains/agent-brain/ports';

const provider = (name = 'openai'): ChatProvider =>
  ({
    name,
    getCapabilities: () => ({
      explicitCacheControl: false,
      automaticCaching: true,
      contextWindow: 128_000,
      toolCalling: true,
      streaming: true,
      rateLimitHeaders: true,
    }),
    getClient: () => ({}) as never,
    buildSystemMessages: () => [],
    decorateRequest: (body: unknown) => body,
    normalizeUsage: () => undefined,
    mapError: (error: unknown) => error as never,
    supportsCacheControl: () => false,
  }) as unknown as ChatProvider;

const factory = (impl?: ProviderFactoryPort['create']): { port: ProviderFactoryPort; create: ReturnType<typeof vi.fn> } => {
  const create = vi.fn(impl ?? (async () => provider()));
  return { port: { create } as unknown as ProviderFactoryPort, create };
};

const model = (over: Partial<ModelConfig> = {}): ModelConfig =>
  ({ id: 'm1', modelName: 'gpt-x', provider: 'OPENAI', isActive: true, apiKey: 'sk-real', ...over }) as ModelConfig;

describe('resolution', () => {
  it('returns the provider itself as the prompt profile', async () => {
    // Not a wrapper. The narrowing is a type, so there is no adapter object between BuildStage and
    // the provider that could behave differently from the one that shipped.
    const built = provider('deepseek');
    const { port } = factory(async () => built);
    const resolved = await new ApiModelExecutionResolver(port).resolve('gpt-x');
    expect(resolved.promptProfile).toBe(built);
  });

  it('binds the model name onto the execution, as the orchestrator used to', async () => {
    const { port } = factory();
    const resolved = await new ApiModelExecutionResolver(port).resolve('  gpt-x  ');
    expect(resolved.execution.providerName).toBe('openai');
    // `setModelName` was called with the trimmed name at construction; the prepared envelope is
    // where that shows, and getting it wrong sends requests for a model called "  gpt-x  ".
    const prepared = resolved.execution.prepare({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(prepared.envelope['model']).toBe('gpt-x');
  });

  it('caches per deployment, not per model name', async () => {
    const { port, create } = factory();
    const resolver = new ApiModelExecutionResolver(port);
    await resolver.resolve('gpt-x', 'deploy-a');
    await resolver.resolve('gpt-x', 'deploy-a');
    await resolver.resolve('gpt-x', 'deploy-b');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('caches by model name when no deployment is pinned', async () => {
    const { port, create } = factory();
    const resolver = new ApiModelExecutionResolver(port);
    await resolver.resolve('gpt-x');
    await resolver.resolve('gpt-x');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    // The old orchestrator deleted the rejected promise from its cache. A cached rejection would
    // make one transient database blip permanently break a model for the life of the process.
    let attempt = 0;
    const { port } = factory(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('db blip');
      return provider();
    });
    const resolver = new ApiModelExecutionResolver(port);
    await expect(resolver.resolve('gpt-x')).rejects.toThrow('db blip');
    await expect(resolver.resolve('gpt-x')).resolves.toBeDefined();
  });
});

describe('the descriptor keeps the five axes apart (§4.3)', () => {
  it('reports the API backend, API auth, platform accounting and the API fault domain', async () => {
    const { port } = factory();
    const { descriptor } = await new ApiModelExecutionResolver(port).resolve('gpt-x');
    expect(descriptor).toEqual({
      providerIdentity: 'openai',
      executionBackend: 'api',
      authMode: 'platform-api-key',
      accountingMode: 'platform',
      faultDomain: 'api',
    });
  });

  it('accounts an API attempt as metered platform usage', async () => {
    const { port } = factory();
    const { accounting } = await new ApiModelExecutionResolver(port).resolve('gpt-x');
    expect(accounting).toEqual({
      accountingMode: 'platform',
      consumesPlatformCredits: true,
      requiresPlatformCreditAdmission: true,
    });
  });
});

describe('availability is the rule the three gates used to apply inline', () => {
  const resolver = new ApiModelExecutionResolver(factory().port);

  it('serves a model with a real key', () => {
    expect(resolver.unavailableReason(model())).toBeNull();
  });

  it('refuses a missing, empty or whitespace key with the message customers already see', () => {
    for (const apiKey of [null, '', '   ']) {
      const reason = resolver.unavailableReason(model({ apiKey }));
      expect(reason?.code).toBe('missing_api_key');
      expect(reason?.detail).toBe('Selected model gpt-x is missing apiKey in database');
    }
  });

  it('refuses an inactive model', () => {
    expect(resolver.unavailableReason(model({ isActive: false }))?.code).toBe('inactive');
  });

  it('treats a missing model as unknown rather than as a missing key', () => {
    // The two produce different errors for the operator, and conflating them sends someone to add
    // a key to a row that does not exist.
    expect(resolver.unavailableReason(null)?.code).toBe('unknown_model');
  });
});
