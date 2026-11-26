import { describe, expect, it, vi } from 'vitest';
import { isChatModel, listChatGptPlanModels, listProviderModels } from '@/domains/platform/models/modelCatalog';

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('listProviderModels: a key is validated by listing its models', () => {
  it('asks Anthropic with x-api-key and returns its chat models newest first, with display names', async () => {
    const fetch = respond(200, {
      data: [
        { type: 'model', id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-01T00:00:00Z' },
        { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-09-01T00:00:00Z' },
      ],
    });
    await expect(listProviderModels('ANTHROPIC', 'sk-ant', { fetch })).resolves.toEqual([
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' });
  });

  it('keeps only chat models for OpenAI-compatible providers, newest first by created', async () => {
    const fetch = respond(200, {
      data: [
        { id: 'gpt-5.4', created: 100 },
        { id: 'text-embedding-3-large', created: 300 },
        { id: 'gpt-image-1', created: 250 },
        { id: 'gpt-5.5', created: 200 },
        { id: 'gpt-5-pro', created: 400 },
        { id: 'whisper-1', created: 50 },
        { id: 'o4-mini', created: 150 },
      ],
    });
    const models = await listProviderModels('OPENAI', 'sk-openai', { fetch });
    expect(models.map((model) => model.id)).toEqual(['gpt-5.5', 'o4-mini', 'gpt-5.4']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-openai' });
  });

  it('keeps the provider order when the provider does not date its models', async () => {
    const fetch = respond(200, { data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] });
    const models = await listProviderModels('DEEPSEEK', 'sk-ds', { fetch });
    expect(models.map((model) => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.deepseek.com/models');
  });

  it('says a refused key in plain words and never repeats what the provider wrote', async () => {
    const fetch = respond(401, { error: { message: 'Incorrect API key provided: sk-fa****1234' } });
    const failure = listProviderModels('OPENAI', 'sk-fake-1234', { fetch });
    await expect(failure).rejects.toThrow('OpenAI refused this key (HTTP 401)');
    await expect(failure).rejects.not.toThrow('sk-fa');
    await expect(failure).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('separates a provider that cannot be reached (502) from a refused key', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(listProviderModels('MOONSHOT', 'sk', { fetch })).rejects.toMatchObject({ httpStatus: 502 });
  });

  it('filters by provider family', () => {
    expect(isChatModel('QWEN', 'qwen3.6-plus')).toBe(true);
    expect(isChatModel('QWEN', 'text-embedding-v4')).toBe(false);
    expect(isChatModel('MOONSHOT', 'kimi-k2.6')).toBe(true);
    expect(isChatModel('OPENAI', 'codex-mini-latest')).toBe(false);
  });
});

describe('listChatGptPlanModels', () => {
  it('keeps models whose visibility is list, in the server order, labelled by display_name', async () => {
    const fetch = respond(200, {
      models: [
        { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
        { slug: 'internal', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list' },
      ],
    });
    await expect(listChatGptPlanModels('plan-token', { fetch })).resolves.toEqual([
      { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer plan-token' });
  });
});
