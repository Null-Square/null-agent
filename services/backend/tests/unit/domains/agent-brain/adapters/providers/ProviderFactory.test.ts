import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderFactory } from '@/domains/agent-brain/adapters/providers';
import type { ModelConfigPort } from '@/domains/agent-brain/ports';

describe('ProviderFactory', () => {
  let modelConfigPort: ModelConfigPort;

  beforeEach(() => {
    vi.restoreAllMocks();
    modelConfigPort = {
      getByModelName: vi.fn(),
      getDefaultModel: vi.fn(),
      getModel: vi.fn(),
      listModelsForCategory: vi.fn(),
    };
  });

  it('injects model credentials and returns OpenAI provider for gpt models', async () => {
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'gpt-4o',
      provider: 'OPENAI',
      isDefault: false,
      apiKey: 'model-key',
      apiBaseUrl: 'https://api.model.test',
    } as any);

    const config = { runtime: { apiKey: 'fallback', apiBaseUrl: 'https://api.fallback' } } as any;
    const factory = new ProviderFactory(config, modelConfigPort);

    const provider = await factory.create('gpt-4o');

    expect(provider).toBeTruthy();
    expect(modelConfigPort.getByModelName).toHaveBeenCalledWith('gpt-4o');

  });

  it('injects model credentials and returns Moonshot provider for Kimi models', async () => {
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'kimi-k2.6',
      provider: 'MOONSHOT',
      isDefault: false,
      apiKey: 'moonshot-key',
      apiBaseUrl: 'https://api.moonshot.ai/v1',
    } as any);

    const config = { runtime: { apiKey: 'fallback', apiBaseUrl: 'https://api.fallback' } } as any;
    const factory = new ProviderFactory(config, modelConfigPort);

    const provider = await factory.create('kimi-k2.6');

    expect(provider.name).toBe('moonshot');
    expect(provider.getCapabilities().automaticCaching).toBe(true);
    expect(modelConfigPort.getByModelName).toHaveBeenCalledWith('kimi-k2.6');
  });

  it('throws when model lookup misses', async () => {
    const config = { runtime: { apiKey: 'fallback-key', apiBaseUrl: 'https://api.fallback' } } as any;
    const factory = new ProviderFactory(config, modelConfigPort);
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(factory.create('openai')).rejects.toThrow(
      'Model "openai" not found in database',
    );
  });

  it('resolves a pinned deployment by id and rejects a name mismatch', async () => {
    (modelConfigPort.getModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'model-1',
      modelName: 'different-model',
      provider: 'OPENAI',
      apiKey: 'model-key',
    } as any);
    const config = { runtime: { apiKey: 'fallback', apiBaseUrl: 'https://api.fallback' } } as any;
    const factory = new ProviderFactory(config, modelConfigPort);

    await expect(factory.create('gpt-4o', 'model-1')).rejects.toThrow('does not match');
    expect(modelConfigPort.getByModelName).not.toHaveBeenCalled();
  });

  it('throws when model name is missing', async () => {
    const config = { runtime: { apiKey: 'fallback-key', apiBaseUrl: 'https://api.fallback' } } as any;
    const factory = new ProviderFactory(config, modelConfigPort);

    await expect(factory.create('')).rejects.toThrow(
      'ProviderFactory requires a valid modelName from the database.',
    );

    expect(modelConfigPort.getByModelName).not.toHaveBeenCalled();
  });

  it('creates the ChatGPT plan provider, whose client is the Responses shim, without using the stored token set as a key', async () => {
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'gpt-6.2-sol',
      provider: 'CHATGPT',
      isDefault: true,
      apiKey: '{"hostId":"urn:uuid:h","clientId":"oaiapp_x","accessToken":"at_secret"}',
    } as any);
    const factory = new ProviderFactory({ runtime: {} } as any, modelConfigPort);

    const provider = await factory.create('gpt-6.2-sol');

    expect(provider.name).toBe('chatgpt');
    expect(typeof (provider.getClient() as any).chat.completions.create).toBe('function');
    expect(JSON.stringify((provider as any).config.runtime)).not.toContain('at_secret');
  });

  it('lets a configured model on a server of its own run without a key, and never with the environment key', async () => {
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'llama3.1',
      provider: 'OPENAI',
      apiKey: null,
      apiBaseUrl: 'http://127.0.0.1:11434/v1',
    } as any);
    const provider = await new ProviderFactory({ runtime: {} } as any, modelConfigPort).create('llama3.1');
    expect((provider as any).config.runtime).toMatchObject({ apiKey: 'no-key', apiBaseUrl: 'http://127.0.0.1:11434/v1' });
  });

  it('still refuses a hosted model with no key', async () => {
    (modelConfigPort.getByModelName as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'deepseek-v4-pro', provider: 'DEEPSEEK', apiKey: null, apiBaseUrl: 'https://api.deepseek.com',
    } as any);
    await expect(new ProviderFactory({ runtime: {} } as any, modelConfigPort).create('deepseek-v4-pro'))
      .rejects.toThrow('missing apiKey');
  });
});
