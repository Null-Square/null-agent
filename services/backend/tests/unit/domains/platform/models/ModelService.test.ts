import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CATEGORIES } from '@null-ai/contracts';
import { ModelService } from '@/domains/platform/models/ModelService';
import { decryptModelApiKey, encryptModelApiKey } from '@/domains/platform/models/modelApiKeyCipher';
import { encryptCredentialRecord } from '@/domains/platform/models/chatGptCredentials';
import type { ChatGptCredentialRecord } from '@/domains/platform/models/chatGptAuth';
import { ErrorFactory } from '@/shared/errors';
import { createInMemoryModelRepo } from '../../../../helpers/inMemoryModelRepo';

type Row = Record<string, any>;

const makeRepo = createInMemoryModelRepo;

const record = (overrides: Partial<ChatGptCredentialRecord> = {}): ChatGptCredentialRecord => ({
  hostId: 'urn:uuid:host',
  clientId: 'oaiapp_issued',
  subject: 'user-1',
  email: 'person@example.com',
  idToken: 'id-token',
  accessToken: 'plan-access',
  refreshToken: 'plan-refresh',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: new Date().toISOString(),
  ...overrides,
});

describe('ModelService: the one connection', () => {
  const originalKey = process.env.MODEL_API_KEY_ENCRYPTION_KEY;
  let catalog: { listProviderModels: ReturnType<typeof vi.fn>; listChatGptPlanModels: ReturnType<typeof vi.fn> };
  let credentials: { load: ReturnType<typeof vi.fn>; accessToken: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    catalog = {
      listProviderModels: vi.fn(async () => [
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      ]),
      listChatGptPlanModels: vi.fn(async () => [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }]),
    };
    credentials = {
      load: vi.fn(async () => null),
      accessToken: vi.fn(async () => 'plan-access'),
      signOut: vi.fn(async (_row: Row, current: ChatGptCredentialRecord) => ({ revoked: true, record: current })),
    };
  });

  afterEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = originalKey;
  });

  const service = (repo: any) => new ModelService({ repo, credentials: credentials as any, catalog: catalog as any });

  it('reports no connection when no row is active and the default', async () => {
    await expect(service(makeRepo([{ id: 'm1', provider: 'DEEPSEEK', modelName: 'd', name: 'D' }])).getConnection()).resolves.toBeNull();
  });

  it('describes the connection without its key, and a ChatGPT plan as OpenAI with the account email', async () => {
    const keyed = makeRepo([{
      id: 'm1', provider: 'ANTHROPIC', modelName: 'claude-opus-4-8', name: 'Claude Opus 4.8', displayName: null,
      apiKey: encryptModelApiKey('sk-ant-secret'), isActive: true, isDefault: true,
    }]);
    const connection = await service(keyed).getConnection();
    expect(connection).toEqual({
      modelId: 'm1', method: 'api_key', provider: 'ANTHROPIC', model: 'claude-opus-4-8',
      label: 'Claude Opus 4.8', account: null, server: null,
    });
    expect(JSON.stringify(connection)).not.toContain('sk-ant-secret');

    const plan = makeRepo([{
      id: 'c1', provider: 'CHATGPT', modelName: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', displayName: 'GPT-6.2 Sol',
      apiKey: encryptCredentialRecord(record()), isActive: true, isDefault: true,
    }]);
    const planConnection = await service(plan).getConnection();
    expect(planConnection).toMatchObject({ method: 'chatgpt', provider: 'OPENAI', model: 'gpt-6.2-sol', account: 'person@example.com' });
    expect(JSON.stringify(planConnection)).not.toContain('plan-access');
  });

  it('names the server of a configured model that runs on a server of its own', async () => {
    const repo = makeRepo([{
      id: 'local', provider: 'OPENAI', modelName: 'llama3.1', name: 'Llama', apiBaseUrl: 'http://127.0.0.1:11434/v1',
      isActive: true, isDefault: true,
    }]);
    await expect(service(repo).getConnection()).resolves.toMatchObject({ method: 'api_key', server: '127.0.0.1:11434' });
  });

  it('validates a key by listing the provider models with it, and refuses a provider the agent cannot call', async () => {
    const repo = makeRepo();
    await expect(service(repo).listModelsForKey(' anthropic ', ' sk-ant ')).resolves.toHaveLength(2);
    expect(catalog.listProviderModels).toHaveBeenCalledWith('ANTHROPIC', 'sk-ant');
    await expect(service(repo).listModelsForKey('OLLAMA', 'x')).rejects.toThrow('Choose one of');
  });

  it('connecting with a key makes that row the only active default and the only row holding a key', async () => {
    const repo = makeRepo([
      { id: 'old', provider: 'DEEPSEEK', modelName: 'deepseek-v4-pro', name: 'DeepSeek', apiKey: encryptModelApiKey('sk-old'), isActive: true, isDefault: true },
      { id: 'catalogue', provider: 'QWEN', modelName: 'qwen3.6-plus', name: 'Qwen' },
    ]);
    const connection = await service(repo).connectWithKey({ provider: 'ANTHROPIC', model: 'claude-sonnet-5', apiKey: 'sk-ant-new' });

    expect(connection).toMatchObject({ method: 'api_key', provider: 'ANTHROPIC', model: 'claude-sonnet-5', label: 'Claude Sonnet 5' });
    const active = repo.rows.filter((row: Row) => row.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ provider: 'ANTHROPIC', modelName: 'claude-sonnet-5', isDefault: true });
    expect(active[0].apiKey).toMatch(/^enc:v1:/u);
    expect(decryptModelApiKey(active[0].apiKey)).toBe('sk-ant-new');
    expect(repo.rows.find((row: Row) => row.id === 'old').apiKey).toBeNull();
  });

  it('refuses a model the key cannot use, and connects nothing', async () => {
    const repo = makeRepo();
    await expect(service(repo).connectWithKey({ provider: 'ANTHROPIC', model: 'claude-made-up', apiKey: 'sk' }))
      .rejects.toThrow('is not among the models this key can use');
    expect(repo.rows).toHaveLength(0);
  });

  it('a refused key connects nothing', async () => {
    catalog.listProviderModels.mockRejectedValueOnce(
      ErrorFactory.validation.constraintViolated('Anthropic refused this key (HTTP 401)', { httpStatus: 400 }),
    );
    const repo = makeRepo();
    await expect(service(repo).connectWithKey({ provider: 'ANTHROPIC', model: 'claude-opus-4-8', apiKey: 'sk-bad' })).rejects.toThrow('refused');
    expect(repo.rows).toHaveLength(0);
  });

  it('without a key, a model change keeps the connected key of the same provider, and only that one', async () => {
    const repo = makeRepo([{
      id: 'm1', provider: 'ANTHROPIC', modelName: 'claude-opus-4-8', name: 'Opus', apiKey: encryptModelApiKey('sk-ant-kept'),
      isActive: true, isDefault: true,
    }]);
    await service(repo).connectWithKey({ provider: 'ANTHROPIC', model: 'claude-sonnet-5' });
    expect(catalog.listProviderModels).toHaveBeenCalledWith('ANTHROPIC', 'sk-ant-kept');
    const active = repo.rows.find((row: Row) => row.isActive);
    expect(active.modelName).toBe('claude-sonnet-5');
    expect(decryptModelApiKey(active.apiKey)).toBe('sk-ant-kept');

    await expect(service(repo).connectWithKey({ provider: 'OPENAI', model: 'gpt-5.4' })).rejects.toThrow('Paste the API key');
  });

  it('connecting a key signs a ChatGPT plan out (revoked, tokens forgotten) and keeps its registration row', async () => {
    const planRow = { id: 'c1', provider: 'CHATGPT', modelName: 'gpt-6.2-sol', name: 'Sol', apiKey: encryptCredentialRecord(record()), isActive: true, isDefault: true };
    const repo = makeRepo([planRow]);
    credentials.load.mockResolvedValue({ row: repo.rows[0], record: record() });
    await service(repo).connectWithKey({ provider: 'ANTHROPIC', model: 'claude-opus-4-8', apiKey: 'sk-ant' });
    expect(credentials.signOut).toHaveBeenCalledTimes(1);
    expect(repo.rows.find((row: Row) => row.id === 'c1')).toMatchObject({ isActive: false, isDefault: false });
  });

  it('every tier the run composer offers is available once a model is connected', async () => {
    const repo = makeRepo([{ id: 'm1', provider: 'ANTHROPIC', modelName: 'claude-opus-4-8', name: 'Opus', selectionCategory: 'medium', isActive: true, isDefault: true }]);
    const options = await service(repo).listAvailableCategories();
    expect(options.map((option) => option.category)).toEqual([...MODEL_CATEGORIES]);
    expect(options.every((option) => option.availableCount === 1)).toBe(true);

    const empty = await service(makeRepo()).listAvailableCategories();
    expect(empty.every((option) => option.availableCount === 0)).toBe(true);
  });

  it('disconnecting an API key clears the key; the agent then has no model', async () => {
    const repo = makeRepo([{ id: 'm1', provider: 'DEEPSEEK', modelName: 'd', name: 'D', apiKey: encryptModelApiKey('sk'), isActive: true, isDefault: true }]);
    await expect(service(repo).disconnect()).resolves.toEqual({ disconnected: true, revocationConfirmed: null });
    expect(repo.rows[0]).toMatchObject({ apiKey: null, isActive: false, isDefault: false });
    await expect(service(repo).getConnection()).resolves.toBeNull();
    await expect(service(repo).disconnect()).resolves.toEqual({ disconnected: false, revocationConfirmed: null });
  });

  it('disconnecting ChatGPT revokes the plan and says whether OpenAI confirmed it', async () => {
    const repo = makeRepo([{ id: 'c1', provider: 'CHATGPT', modelName: 'gpt-6.2-sol', name: 'Sol', apiKey: encryptCredentialRecord(record()), isActive: true, isDefault: true }]);
    credentials.signOut.mockResolvedValueOnce({ revoked: false, record: record() });
    await expect(service(repo).disconnect()).resolves.toEqual({ disconnected: true, revocationConfirmed: false });
    expect(credentials.signOut).toHaveBeenCalledTimes(1);
    expect(repo.rows[0]).toMatchObject({ isActive: false, isDefault: false });
  });

  it('a completed ChatGPT sign-in connects the plan, on the model already chosen if the plan still offers it', async () => {
    catalog.listChatGptPlanModels.mockResolvedValue([{ id: 'gpt-6.2-sol', label: 'Sol' }, { id: 'gpt-6.1-terra', label: 'Terra' }]);
    const repo = makeRepo([{ id: 'c1', provider: 'CHATGPT', modelName: 'gpt-6.1-terra', name: 'Terra', apiKey: null }]);
    const connection = await service(repo).saveChatGptSignIn(record(), [{ id: 'gpt-6.2-sol', label: 'Sol' }, { id: 'gpt-6.1-terra', label: 'Terra' }]);
    expect(connection).toMatchObject({ method: 'chatgpt', model: 'gpt-6.1-terra' });
    expect(repo.rows[0]).toMatchObject({ isActive: true, isDefault: true });

    const fresh = makeRepo();
    await expect(service(fresh).saveChatGptSignIn(record(), [{ id: 'gpt-6.2-sol', label: 'Sol' }])).resolves.toMatchObject({ model: 'gpt-6.2-sol' });
    expect(fresh.rows[0]).toMatchObject({ provider: 'CHATGPT', isActive: true });
  });

  it('a sign-in without plan permission keeps the registration and connects nothing', async () => {
    const repo = makeRepo();
    const connection = await service(repo).saveChatGptSignIn(record({ accessToken: null, refreshToken: null, scopes: ['openid'] }), []);
    expect(connection).toBeNull();
    expect(repo.rows[0]).toMatchObject({ provider: 'CHATGPT', isActive: false, modelName: 'chatgpt-model-not-chosen' });
  });

  it('switches the ChatGPT connection to another model only if the plan offers it', async () => {
    const repo = makeRepo([{ id: 'c1', provider: 'CHATGPT', modelName: 'gpt-6.2-sol', name: 'Sol', apiKey: encryptCredentialRecord(record()), isActive: true, isDefault: true }]);
    credentials.load.mockResolvedValue({ row: repo.rows[0], record: record() });
    catalog.listChatGptPlanModels.mockResolvedValue([{ id: 'gpt-6.2-sol', label: 'Sol' }, { id: 'gpt-6.1-luna', label: 'Luna' }]);
    await expect(service(repo).connectChatGpt({ model: 'gpt-6.1-luna' })).resolves.toMatchObject({ model: 'gpt-6.1-luna', label: 'Luna' });
    await expect(service(repo).connectChatGpt({ model: 'gpt-9' })).rejects.toThrow('not among the models your ChatGPT plan offers');
  });

  describe('keys in .env still work', () => {
    it('with no connection, the first provider key in .env becomes the connection on its newest model', async () => {
      const repo = makeRepo();
      const connection = await service(repo).connectFromEnv({ DEEPSEEK_API_KEY: 'sk-ds', MOONSHOT_API_KEY: 'sk-ms' });
      expect(catalog.listProviderModels).toHaveBeenCalledWith('DEEPSEEK', 'sk-ds');
      expect(connection).toMatchObject({ provider: 'DEEPSEEK', model: 'claude-opus-4-8' });
    });

    it('skips a refused key and tries the next provider', async () => {
      catalog.listProviderModels
        .mockRejectedValueOnce(ErrorFactory.validation.constraintViolated('refused', { httpStatus: 400 }))
        .mockResolvedValueOnce([{ id: 'kimi-k2.6', label: 'kimi-k2.6' }]);
      const connection = await service(makeRepo()).connectFromEnv({ OPENAI_API_KEY: 'sk-bad', MOONSHOT_API_KEY: 'sk-ms' });
      expect(connection).toMatchObject({ provider: 'MOONSHOT', model: 'kimi-k2.6' });
    });

    it('uses the configured model for a provider that cannot be reached', async () => {
      catalog.listProviderModels.mockRejectedValueOnce(ErrorFactory.validation.constraintViolated('unreachable', { httpStatus: 502 }));
      const connection = await service(makeRepo()).connectFromEnv({ QWEN_API_KEY: 'sk-qw' }, { QWEN: 'qwen3.6-plus' });
      expect(connection).toMatchObject({ provider: 'QWEN', model: 'qwen3.6-plus' });
    });

    it('never replaces a connection the person made', async () => {
      const repo = makeRepo([{ id: 'm1', provider: 'ANTHROPIC', modelName: 'claude-opus-4-8', name: 'Opus', isActive: true, isDefault: true }]);
      await expect(service(repo).connectFromEnv({ OPENAI_API_KEY: 'sk' })).resolves.toBeNull();
      expect(catalog.listProviderModels).not.toHaveBeenCalled();
    });
  });
});
