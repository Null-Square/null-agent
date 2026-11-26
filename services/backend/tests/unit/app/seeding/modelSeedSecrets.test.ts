import { describe, expect, it } from 'vitest';
import { resolveModelApiKey } from '@/app/seeding/modelSeedSecrets';

describe('modelSeedSecrets', () => {
  it('prefers provider API key env over the seed fallback', () => {
    const apiKey = resolveModelApiKey(
      { provider: 'OPENAI', apiKey: 'seed-key' },
      { OPENAI_API_KEY: ' env-key ' },
    );

    expect(apiKey).toBe('env-key');
  });

  it('falls back to the seed key when the provider env var is missing', () => {
    const apiKey = resolveModelApiKey(
      { provider: 'ANTHROPIC', apiKey: 'seed-key' },
      {},
    );

    expect(apiKey).toBe('seed-key');
  });

  it('allows explicit per-model env key names', () => {
    const apiKey = resolveModelApiKey(
      { provider: 'OPENAI', apiKeyEnv: 'CUSTOM_MODEL_KEY', apiKey: 'seed-key' },
      { OPENAI_API_KEY: 'provider-key', CUSTOM_MODEL_KEY: 'custom-key' },
    );

    expect(apiKey).toBe('custom-key');
  });

  it('resolves Moonshot provider keys from MOONSHOT_API_KEY', () => {
    const apiKey = resolveModelApiKey(
      { provider: 'MOONSHOT', apiKey: 'seed-key' },
      { MOONSHOT_API_KEY: ' moonshot-key ' },
    );

    expect(apiKey).toBe('moonshot-key');
  });
});
