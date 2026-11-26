import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MODEL_CATEGORIES, type ModelCategory } from '@null-ai/contracts';
import { ModelSeedSchema } from '@/app/seeding/schemas';
import { assertSeedRateCardMatches, configuredApiKey } from '@/app/seeding/syncServices';
import { z } from 'zod';

const loadModelSeeds = () => {
  const seedPath = path.resolve(__dirname, '../../../../config/seeds/models.seed.json');
  return z.array(ModelSeedSchema).parse(JSON.parse(fs.readFileSync(seedPath, 'utf-8')));
};

describe('models seed', () => {
  it('defines at least one seed model for each intelligence category', () => {
    const seeds = loadModelSeeds();
    const categories = new Set(seeds.map(seed => seed.selectionCategory));

    expect([...categories].sort()).toEqual([...MODEL_CATEGORIES].sort());
    for (const category of MODEL_CATEGORIES) {
      expect(seeds.some(seed => seed.selectionCategory === category)).toBe(true);
    }
  });

  it('keeps concrete model capability mapping in the seed source of truth', () => {
    const seedsByName = new Map(loadModelSeeds().map(seed => [seed.modelName, seed]));

    const expectedCategories: Record<string, ModelCategory> = {
      'deepseek-v4-pro': 'low',
      'qwen3.6-plus': 'medium',
      'gpt-5.4': 'high',
      'kimi-k2.6': 'high',
      'claude-opus-4-6': 'extra_high',
    };

    for (const [modelName, expectedCategory] of Object.entries(expectedCategories)) {
      expect(seedsByName.get(modelName)?.selectionCategory).toBe(expectedCategory);
    }
  });

  it('uses an explicit Qwen rate card and request profile', () => {
    const qwen = loadModelSeeds().find(seed => seed.modelName === 'qwen3.6-plus');

    expect(qwen).toMatchObject({
      name: 'Qwen 3.6 Plus',
      provider: 'QWEN',
      requestProfile: { thinkingMode: 'planning_only' },
      rateCards: [expect.objectContaining({
        cacheMissInputPer1m: 0.5,
        outputPer1m: 3.0,
        cacheHitInputPer1m: 0.05,
      })],
      contextWindow: 1000000,
      maxOutputTokens: 65536,
    });
  });

  it('uses the DeepSeek cutover and recurring peak windows', () => {
    const deepseek = loadModelSeeds().find(seed => seed.modelName === 'deepseek-v4-pro');

    expect(deepseek).toMatchObject({
      name: 'DeepSeek V4 Pro',
      provider: 'DEEPSEEK',
      requestProfile: { thinking: 'enabled', reasoningEffort: 'high' },
      contextWindow: 1000000,
      maxOutputTokens: 384000,
      apiBaseUrl: 'https://api.deepseek.com',
    });
    expect(deepseek?.rateCards).toHaveLength(2);
    expect(deepseek?.rateCards[1]).toMatchObject({
      effectiveFrom: '2026-08-16T16:00:00.000Z',
      cacheHitInputPer1m: 0.022,
      cacheMissInputPer1m: 0.66,
      outputPer1m: 1.98,
      windows: [
        expect.objectContaining({ startMinuteUtc: 60, endMinuteUtc: 240 }),
        expect.objectContaining({ startMinuteUtc: 360, endMinuteUtc: 600 }),
      ],
    });
  });

  it('keeps Moonshot thinking behavior in the deployment profile', () => {
    const kimi = loadModelSeeds().find(seed => seed.modelName === 'kimi-k2.6');
    expect(kimi?.requestProfile).toEqual({ thinking: 'enabled', keep: 'all' });
  });

  it('ships no entry to connect by default, so a key in .env decides the first connection', () => {
    expect(loadModelSeeds().filter(seed => seed.isDefault)).toEqual([]);
  });

  it('never hands a provider .env key to a configured model on a server of its own', () => {
    const ollama = ModelSeedSchema.parse({
      name: 'Llama', provider: 'OPENAI', modelName: 'llama3.1', apiBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(configuredApiKey(ollama, { OPENAI_API_KEY: 'sk-openai' })).toBeNull();
    expect(configuredApiKey({ ...ollama, apiKeyEnv: 'ROUTER_KEY' }, { OPENAI_API_KEY: 'sk-openai', ROUTER_KEY: 'sk-router' }))
      .toBe('sk-router');

    const hosted = ModelSeedSchema.parse({ name: 'GPT', provider: 'OPENAI', modelName: 'gpt-5.4', apiBaseUrl: 'https://api.openai.com/v1' });
    expect(configuredApiKey(hosted, { OPENAI_API_KEY: 'sk-openai' })).toBe('sk-openai');
  });

  it('accepts a configured entry without prices', () => {
    expect(ModelSeedSchema.parse({ name: 'Local', provider: 'OPENAI', modelName: 'm', apiBaseUrl: 'http://127.0.0.1:1234/v1' }).rateCards)
      .toEqual([]);
  });

  it('does not seed deprecated DeepSeek aliases', () => {
    const modelNames = new Set(loadModelSeeds().map(seed => seed.modelName));

    expect(modelNames.has('deepseek-chat')).toBe(false);
    expect(modelNames.has('deepseek-reasoner')).toBe(false);
  });

  it('does not store provider API keys in the seed file', () => {
    for (const seed of loadModelSeeds()) {
      expect(seed.apiKey).toBeUndefined();
    }
  });

  it('rejects edits to an immutable seeded rate card', () => {
    const seededRate = loadModelSeeds()[0]!.rateCards[0]!;
    const storedRate: Parameters<typeof assertSeedRateCardMatches>[1] = {
      card: {
        id: 'rate-card',
        modelId: 'model',
        effectiveFrom: new Date(seededRate.effectiveFrom),
        effectiveTo: seededRate.effectiveTo ? new Date(seededRate.effectiveTo) : null,
        currency: seededRate.currency,
        baseCacheHitInputPer1m: seededRate.cacheHitInputPer1m,
        baseCacheMissInputPer1m: seededRate.cacheMissInputPer1m,
        baseOutputPer1m: seededRate.outputPer1m,
        sourceUrl: seededRate.sourceUrl ?? null,
        sourceNote: seededRate.sourceNote ?? null,
        createdAt: new Date(),
      },
      windows: seededRate.windows.map((window, index) => ({
        ...window,
        id: String(index),
        rateCardId: 'rate-card',
        cacheHitInputPer1m: window.cacheHitInputPer1m,
        cacheMissInputPer1m: window.cacheMissInputPer1m,
        outputPer1m: window.outputPer1m,
        createdAt: new Date(),
      })),
    };

    expect(() => assertSeedRateCardMatches('test-model', storedRate, seededRate)).not.toThrow();
    expect(() => assertSeedRateCardMatches('test-model', storedRate, {
      ...seededRate,
      outputPer1m: seededRate.outputPer1m + 1,
    })).toThrow('publish a new effectiveFrom');
  });
});
