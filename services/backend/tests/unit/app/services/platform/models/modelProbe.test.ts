import { describe, expect, it, vi } from 'vitest';
import { createModelProbe } from '@/app/services/platform/models/modelProbe';
import { OpenAIChatProvider } from '@/domains/agent-brain/adapters/providers/OpenAIChatProvider';
import { ChatGptPlanError } from '@/domains/agent-brain/adapters/providers/chatgpt/responsesShim';
import { ChatGptAuthError } from '@/domains/platform/models/chatGptAuth';

const KEY = 'sk-fake-key-123456';

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1', modelName: 'deepseek-v4-pro', provider: 'DEEPSEEK', apiKey: KEY, isActive: true, isDefault: true, ...overrides,
});

const probeWith = (create: (...args: any[]) => any, model: Record<string, unknown> | null = connection(), timeoutMs?: number) => {
  const provider = new OpenAIChatProvider({ runtime: { apiKey: KEY, apiBaseUrl: 'http://127.0.0.1:1' } } as any);
  vi.spyOn(provider, 'getClient').mockReturnValue({ chat: { completions: { create } } } as any);
  const providers = { create: vi.fn(async () => provider) };
  const modelConfigPort = { getDefaultModel: vi.fn(async () => model) } as any;
  return { probe: createModelProbe({ providers, modelConfigPort, timeoutMs }), providers };
};

const oneChunk = async function* () {
  yield { id: 'x', choices: [{ index: 0, delta: { role: 'assistant' } }] };
};

describe('the model test: one request through the agent provider path', () => {
  it('passes when the provider streams a first chunk, and sends a tool so a model without tools fails', async () => {
    const create = vi.fn(async () => oneChunk());
    const { probe, providers } = probeWith(create);
    const result = await probe();
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('DeepSeek answered') });
    expect(providers.create).toHaveBeenCalledWith('deepseek-v4-pro', 'm1');
    const [body, options] = create.mock.calls[0] as unknown as [Record<string, any>, { signal: AbortSignal }];
    expect(body).toMatchObject({ model: 'deepseek-v4-pro', stream: true });
    expect(body.tools).toHaveLength(1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('names a refused key in plain words and never repeats the key or the provider text', async () => {
    const { probe } = probeWith(async () => {
      throw Object.assign(new Error(`Incorrect API key provided: ${KEY}`), { status: 401 });
    });
    const result = await probe();
    expect(result).toMatchObject({ ok: false, message: 'Authentication failed: DeepSeek refused the API key (HTTP 401).' });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('Incorrect');
  });

  it('gives up after the timeout with a plain message', async () => {
    const { probe } = probeWith(() => new Promise(() => undefined), connection(), 30);
    await expect(probe()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('did not answer within') });
  });

  it('says what a ChatGPT plan usage limit means', async () => {
    const { probe } = probeWith(async () => (async function* () {
      throw new ChatGptPlanError('subscription_sharing_usage_limit_exceeded', 429, 'limit');
    })(), connection({ provider: 'CHATGPT', modelName: 'gpt-6.2-sol', apiKey: '{"hostId":"h"}' }));
    await expect(probe()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Usage limit reached') });
  });

  it('says a ChatGPT sign-in has ended when its refresh token is dead', async () => {
    const { probe } = probeWith(async () => {
      throw Object.assign(new Error("Failed to get token from 'apiKey' function"), {
        cause: new ChatGptAuthError('invalid_grant', 'x', true),
      });
    }, connection({ provider: 'CHATGPT' }));
    await expect(probe()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Connect ChatGPT again') });
  });

  it('has nothing to test when no model is connected', async () => {
    const { probe } = probeWith(async () => oneChunk(), null);
    await expect(probe()).resolves.toBeNull();
    const inactive = probeWith(async () => oneChunk(), connection({ isActive: false }));
    await expect(inactive.probe()).resolves.toBeNull();
  });
});
