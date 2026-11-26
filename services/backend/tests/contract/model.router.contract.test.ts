import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createChatGptCallbackRouter, createModelRouter } from '@/interfaces/http/controllers/model.router';
import { ChatGptSignIn, loopbackRedirectUri } from '@/app/services/platform/models/chatGptSignIn';
import { listModelProviderOptions } from '@/app/services/platform/models/modelAppService';
import { ModelService } from '@/domains/platform/models/ModelService';
import { ChatGptCredentials } from '@/domains/platform/models/chatGptCredentials';
import { listChatGptPlanModels } from '@/domains/platform/models/modelCatalog';
import { apiErrorHandler } from '@/shared/http/apiError';
import { ErrorFactory } from '@/shared/errors';
import { startChatGptStub, type ChatGptStub } from '../helpers/chatGptStub';
import { createInMemoryModelRepo } from '../helpers/inMemoryModelRepo';

const SECRET = 'sk-ant-secret-key-000';
const APP_URL = 'http://localhost:8080';
const REDIRECT = loopbackRedirectUri(APP_URL);

describe('/api/app/model', () => {
  let stub: ChatGptStub;
  let repo: ReturnType<typeof createInMemoryModelRepo>;
  let app: express.Express;
  let probe: ReturnType<typeof vi.fn>;
  let listProviderModels: ReturnType<typeof vi.fn>;
  const bodies: string[] = [];
  const originalKey = process.env.MODEL_API_KEY_ENCRYPTION_KEY;

  beforeAll(async () => {
    stub = await startChatGptStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    repo = createInMemoryModelRepo();
    listProviderModels = vi.fn(async (_provider: string, apiKey: string) => {
      if (apiKey !== SECRET) {
        throw ErrorFactory.validation.constraintViolated('Anthropic refused this key (HTTP 401); check it and paste it again', {
          userMessage: 'Anthropic refused this key (HTTP 401); check it and paste it again',
          httpStatus: 400,
        });
      }
      return [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }];
    });
    const credentials = new ChatGptCredentials({ repo, endpoints: stub.endpoints });
    const models = new ModelService({
      repo,
      credentials,
      catalog: {
        listProviderModels: listProviderModels as any,
        listChatGptPlanModels: (token: string) => listChatGptPlanModels(token, { baseUrl: stub.apiBaseUrl }),
      },
    });
    const chatGpt = new ChatGptSignIn({ models, endpoints: stub.endpoints, apiBaseUrl: stub.apiBaseUrl });
    probe = vi.fn(async () => ({ ok: false, latencyMs: 12, message: 'Authentication failed: Anthropic refused the API key (HTTP 401).' }));

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = (req.headers['x-test-role'] as string) ?? 'admin';
      Object.assign(req, { user: { id: 'owner' }, organizationId: 'org-1', orgRole: role, orgContextSource: 'primary' });
      const send = res.send.bind(res);
      res.send = (body?: unknown) => {
        bodies.push(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
        return send(body);
      };
      next();
    });
    app.use('/api/app/model', createModelRouter({ models, probe, chatGpt, chatGptRedirectUri: REDIRECT, appUrl: APP_URL }));
    app.use('/auth/callback', createChatGptCallbackRouter(chatGpt));
    app.use(apiErrorHandler);
  });

  afterEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = originalKey;
    // No route ever answers with a key or a token.
    for (const body of bodies) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toMatch(/\b(at|rt)_[0-9a-f-]{8,}/u);
      expect(body).not.toContain('enc:v1:');
    }
    bodies.length = 0;
  });

  it('GET / answers no connection yet and the API-key providers with their key pages', async () => {
    const response = await request(app).get('/api/app/model').expect(200);
    expect(response.body).toEqual({ connection: null, providers: listModelProviderOptions() });
    expect(response.body.providers.map((provider: { id: string }) => provider.id)).toEqual(['ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'QWEN', 'MOONSHOT']);
    expect(response.body.providers[0]).toEqual({ id: 'ANTHROPIC', label: 'Anthropic (Claude)', keyUrl: expect.stringMatching(/^https:\/\//u) });
  });

  it('POST /key validates a key by listing its models, and saves nothing', async () => {
    const response = await request(app).post('/api/app/model/key').send({ provider: 'anthropic', apiKey: SECRET }).expect(200);
    expect(response.body).toEqual({ models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }] });
    expect(repo.rows).toHaveLength(0);
  });

  it('POST /key answers a refused key with 400 and a plain message', async () => {
    const response = await request(app).post('/api/app/model/key').send({ provider: 'ANTHROPIC', apiKey: 'sk-wrong' }).expect(400);
    expect(response.body).toMatchObject({ code: 'validation.constraint_violated', userMessage: expect.stringContaining('refused this key') });
  });

  it.each([
    ['an unknown provider', { provider: 'OLLAMA', apiKey: 'x' }, 'provider must be one of'],
    ['an empty key', { provider: 'OPENAI', apiKey: '  ' }, 'apiKey must not be empty'],
    ['an encrypted value', { provider: 'OPENAI', apiKey: 'enc:v1:a:b:c' }, 'not a stored'],
    ['an unknown field', { provider: 'OPENAI', apiKey: 'k', baseUrl: 'http://x' }, 'Unknown field'],
  ])('POST /key refuses %s with 400', async (_name, body, message) => {
    const response = await request(app).post('/api/app/model/key').send(body).expect(400);
    expect(response.body).toMatchObject({ code: 'validation.constraint_violated', userMessage: expect.stringContaining(message) });
  });

  it('POST /connect saves the one connection; GET / then shows it without the key', async () => {
    const connected = await request(app).post('/api/app/model/connect')
      .send({ method: 'api_key', provider: 'ANTHROPIC', model: 'claude-opus-4-8', apiKey: SECRET }).expect(200);
    const expected = { method: 'api_key', provider: 'ANTHROPIC', model: 'claude-opus-4-8', label: 'Claude Opus 4.8', account: null, server: null };
    expect(connected.body).toEqual({ connection: expected });
    expect((await request(app).get('/api/app/model').expect(200)).body.connection).toEqual(expected);

    const switched = await request(app).post('/api/app/model/connect')
      .send({ method: 'api_key', provider: 'ANTHROPIC', model: 'claude-sonnet-5' }).expect(200);
    expect(switched.body.connection.model).toBe('claude-sonnet-5');
    expect(repo.rows.filter((row: any) => row.isActive)).toHaveLength(1);
  });

  it('POST /connect refuses a model the key does not offer, and a bad method', async () => {
    await request(app).post('/api/app/model/connect')
      .send({ method: 'api_key', provider: 'ANTHROPIC', model: 'claude-made-up', apiKey: SECRET }).expect(400);
    await request(app).post('/api/app/model/connect').send({ method: 'magic', model: 'x' }).expect(400);
    await request(app).post('/api/app/model/connect').send({ method: 'chatgpt', model: 'gpt-6.2-sol' }).expect(409);
  });

  it('writes need organization.manage; reads are open to members', async () => {
    await request(app).get('/api/app/model').set('x-test-role', 'viewer').expect(200);
    for (const [method, path] of [
      ['post', '/api/app/model/key'],
      ['post', '/api/app/model/connect'],
      ['post', '/api/app/model/chatgpt/start'],
      ['post', '/api/app/model/test'],
      ['delete', '/api/app/model'],
    ] as const) {
      await request(app)[method](path).set('x-test-role', 'viewer').send({}).expect(403);
    }
  });

  it('POST /test answers the probe result, and 404 with no connection', async () => {
    const tested = await request(app).post('/api/app/model/test').expect(200);
    expect(tested.body).toEqual({ ok: false, latencyMs: 12, message: 'Authentication failed: Anthropic refused the API key (HTTP 401).' });
    probe.mockResolvedValueOnce(null);
    await request(app).post('/api/app/model/test').expect(404);
  });

  it('DELETE / disconnects', async () => {
    await request(app).post('/api/app/model/connect')
      .send({ method: 'api_key', provider: 'ANTHROPIC', model: 'claude-opus-4-8', apiKey: SECRET }).expect(200);
    const response = await request(app).delete('/api/app/model').expect(200);
    expect(response.body).toEqual({ disconnected: true, revocationConfirmed: null });
    expect((await request(app).get('/api/app/model')).body.connection).toBeNull();
  });

  it('Sign in with ChatGPT: start gives the URL, the callback stores the tokens and returns the browser to the app', async () => {
    const started = await request(app).post('/api/app/model/chatgpt/start').send({ returnTo: '/settings/models' }).expect(200);
    expect(Object.keys(started.body)).toEqual(['url']);
    expect(new URL(started.body.url).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/auth/callback');
    const query = stub.approve(started.body.url);

    const callback = await request(app).get('/auth/callback').query(query).expect(302);
    // Back to the app the person opened (NULL_AI_APP_URL), where its session cookie lives.
    expect(callback.headers.location).toBe('http://localhost:8080/settings/models?chatgpt=connected');
    expect(callback.headers['cache-control']).toBe('no-store');

    const state = (await request(app).get('/api/app/model').expect(200)).body;
    expect(state.connection).toEqual({
      method: 'chatgpt', provider: 'OPENAI', model: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', account: 'user-1@example.com', server: null,
    });
    const plan = await request(app).get('/api/app/model/chatgpt/models').expect(200);
    expect(plan.body).toEqual({ models: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }] });
    const switched = await request(app).post('/api/app/model/connect').send({ method: 'chatgpt', model: 'gpt-6.1-terra' }).expect(200);
    expect(switched.body.connection).toMatchObject({ method: 'chatgpt', model: 'gpt-6.1-terra' });

    // The same callback twice is refused: the state is one-time.
    const replay = await request(app).get('/auth/callback').query(query).expect(400);
    expect(replay.text).toContain('expired or was already used');
  });

  it('a cancelled ChatGPT sign-in returns the browser with chatgpt=error', async () => {
    const started = await request(app).post('/api/app/model/chatgpt/start').send({}).expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const callback = await request(app).get('/auth/callback').query({ state, error: 'access_denied' }).expect(302);
    expect(callback.headers.location).toBe('http://localhost:8080/?chatgpt=error&reason=denied');
  });

  it('POST /chatgpt/start refuses a returnTo that leaves the app', async () => {
    await request(app).post('/api/app/model/chatgpt/start').send({ returnTo: '//evil.example' }).expect(400);
    await request(app).post('/api/app/model/chatgpt/start').send({ returnTo: 'https://evil.example' }).expect(400);
  });
});
