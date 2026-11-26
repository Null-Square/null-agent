import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';

/**
 * The seed and the connection on a real database. `syncModels` uses the app's own db client, so run
 * this with DATABASE_URL and TEST_DATABASE_URL pointing at the same throwaway database.
 */
const maybeDescribe =
  process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL === process.env.DATABASE_URL ? describe : describe.skip;

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'MOONSHOT_API_KEY'];

/** Stands in for the providers' free model lists; any other request is a test failure. */
const providerModels = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url === 'https://api.deepseek.com/models') {
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-v5-pro' }, { id: 'deepseek-v4-pro' }] }), { status: 200 });
  }
  if (url.startsWith('https://api.anthropic.com/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-09-01T00:00:00Z' }] }), { status: 200 });
  }
  throw new Error(`unexpected request to ${url}`);
});

maybeDescribe('models seed and the one connection (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    harness = await setupTestDb();
    for (const name of [...PROVIDER_KEYS, 'MODEL_API_KEY_ENCRYPTION_KEY']) saved[name] = process.env[name];
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
    vi.stubGlobal('fetch', providerModels);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await harness?.pool.query('DELETE FROM model_rate_windows; DELETE FROM model_rate_cards; DELETE FROM models;');
    await harness?.dispose();
    const { closeDb } = await import('@/db/client');
    await closeDb();
  });

  beforeEach(async () => {
    for (const name of PROVIDER_KEYS) delete process.env[name];
    providerModels.mockClear();
    await harness!.pool.query('DELETE FROM model_rate_windows; DELETE FROM model_rate_cards; DELETE FROM models;');
  });

  const active = async () =>
    (await harness!.pool.query('SELECT provider, model_name, api_key, is_default FROM models WHERE is_active')).rows;

  it('with no connection, the seed connects the first .env key on that provider\'s newest chat model', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    const { syncModels } = await import('@/app/seeding/syncServices');
    const { decryptModelApiKey } = await import('@/domains/platform/models/modelApiKeyCipher');

    await syncModels();

    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'DEEPSEEK', model_name: 'deepseek-v5-pro', is_default: true });
    expect(decryptModelApiKey(rows[0].api_key)).toBe('sk-test-deepseek');
    const keyed = await harness!.pool.query('SELECT count(*)::int AS n FROM models WHERE api_key IS NOT NULL');
    expect(keyed.rows[0].n).toBe(1);
  });

  it('a connection made in the app survives a later seed, even with another key in .env', async () => {
    const { syncModels } = await import('@/app/seeding/syncServices');
    const { ModelService } = await import('@/domains/platform/models/ModelService');
    const { decryptModelApiKey } = await import('@/domains/platform/models/modelApiKeyCipher');
    await syncModels();
    await new ModelService().connectWithKey({ provider: 'ANTHROPIC', model: 'claude-opus-4-8', apiKey: 'sk-ant-app' });

    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    await syncModels();

    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'ANTHROPIC', model_name: 'claude-opus-4-8' });
    expect(decryptModelApiKey(rows[0].api_key)).toBe('sk-ant-app');
  });

  it('after a disconnect, the next seed connects the .env key again', async () => {
    const { syncModels } = await import('@/app/seeding/syncServices');
    const { ModelService } = await import('@/domains/platform/models/ModelService');
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    await syncModels();
    await new ModelService().disconnect();
    expect(await active()).toHaveLength(0);

    await syncModels();
    expect((await active())[0]).toMatchObject({ provider: 'DEEPSEEK' });
  });

  it('every effort tier resolves to the connection through the agent model port', async () => {
    const { syncModels } = await import('@/app/seeding/syncServices');
    const { createModelConfigPort } = await import('@/app/adapters/portFactories');
    const { MODEL_CATEGORIES } = await import('@null-ai/contracts');
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    await syncModels();

    const port = createModelConfigPort();
    for (const category of MODEL_CATEGORIES) {
      const [model] = await port.listModelsForCategory(category);
      expect(model).toMatchObject({ provider: 'DEEPSEEK', modelName: 'deepseek-v5-pro', apiKey: 'sk-test-deepseek' });
    }
  });
});
