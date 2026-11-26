import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatGptSignIn, ChatGptSignInError } from '@/app/services/platform/models/chatGptSignIn';
import { ModelService } from '@/domains/platform/models/ModelService';
import { ChatGptCredentials, readCredentialRecord } from '@/domains/platform/models/chatGptCredentials';
import { listChatGptPlanModels, listProviderModels } from '@/domains/platform/models/modelCatalog';
import { startChatGptStub, type ChatGptStub } from '../../../../../helpers/chatGptStub';
import { createInMemoryModelRepo } from '../../../../../helpers/inMemoryModelRepo';

const REDIRECT = 'http://127.0.0.1:8081/auth/callback';

describe('Sign in with ChatGPT, against a stub of OpenAI over real HTTP', () => {
  let stub: ChatGptStub;
  const originalKey = process.env.MODEL_API_KEY_ENCRYPTION_KEY;

  beforeAll(async () => {
    stub = await startChatGptStub();
  });
  afterAll(async () => {
    await stub.close();
  });
  beforeEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    stub.requests.length = 0;
  });
  afterEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = originalKey;
  });

  const setup = (repo = createInMemoryModelRepo()) => {
    const credentials = new ChatGptCredentials({ repo, endpoints: stub.endpoints });
    const models = new ModelService({
      repo,
      credentials,
      catalog: {
        listProviderModels,
        listChatGptPlanModels: (token: string) => listChatGptPlanModels(token, { baseUrl: stub.apiBaseUrl }),
      },
    });
    const signIn = new ChatGptSignIn({ models, endpoints: stub.endpoints, apiBaseUrl: stub.apiBaseUrl });
    return { repo, credentials, models, signIn };
  };

  it('starts the documented authorization request: first registration, loopback redirect, PKCE S256', async () => {
    const { signIn } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: 'http://127.0.0.1:8081/settings' });
    const params = new URL(url).searchParams;
    expect(url.startsWith(stub.endpoints.authorizeUrl)).toBe(true);
    expect(params.get('client_id')).toBe('dynamic_agent_client');
    expect(params.get('agent_name_hint')).toBe('Null AI');
    expect(params.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(params.get('resource')).toBe('https://api.openai.com/v1');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(params.has('id_token_hint')).toBe(false);
  });

  it('the callback exchanges the code, verifies the ID token and stores the tokens encrypted; the plan becomes the connection', async () => {
    const { repo, signIn, models } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: 'http://127.0.0.1:8081/settings' });
    const outcome = await signIn.complete(stub.approve(url));

    expect(outcome).toMatchObject({ outcome: 'connected', returnTo: 'http://127.0.0.1:8081/settings' });
    expect(outcome.connection).toMatchObject({ method: 'chatgpt', provider: 'OPENAI', model: 'gpt-6.2-sol', account: 'user-1@example.com' });
    const exchange = stub.requests.find((request) => request.body.grant_type === 'authorization_code');
    expect(exchange?.body).toMatchObject({ client_id: stub.issuedClientId, redirect_uri: REDIRECT, resource: 'https://api.openai.com/v1' });

    const row = repo.rows.find((entry: any) => entry.provider === 'CHATGPT');
    expect(row.apiKey).toMatch(/^enc:v1:/u);
    expect(row.apiKey).not.toContain('at_');
    const record = readCredentialRecord(row.apiKey);
    expect(record).toMatchObject({ clientId: stub.issuedClientId, subject: 'user-1', email: 'user-1@example.com' });
    expect(record?.accessToken).toMatch(/^at_/u);
    expect(record?.refreshToken).toMatch(/^rt_/u);
    await expect(models.getConnection()).resolves.toMatchObject({ method: 'chatgpt' });
  });

  it('a returning sign-in reuses the issued client id, the host id and the ID token hint', async () => {
    const { signIn } = setup();
    const first = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    await signIn.complete(stub.approve(first.url));
    const hostId = new URL(first.url).searchParams.get('ext_agent_host_id');

    const again = new URL((await signIn.start({ redirectUri: REDIRECT, returnTo: null })).url).searchParams;
    expect(again.get('client_id')).toBe(stub.issuedClientId);
    expect(again.get('ext_agent_host_id')).toBe(hostId);
    expect(again.get('id_token_hint')).toBeTruthy();
    expect(again.get('login_hint')).toBe('user-1@example.com');
    expect(again.has('agent_name_hint')).toBe(false);
  });

  it('refuses a callback with an unknown or reused state, before exchanging anything', async () => {
    const { signIn } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    const query = stub.approve(url);
    await signIn.complete(query);
    await expect(signIn.complete(query)).rejects.toMatchObject({ reason: 'expired' });
    await expect(signIn.complete({ ...query, state: 'forged' })).rejects.toBeInstanceOf(ChatGptSignInError);
  });

  it('stops on access_denied without exchanging a code', async () => {
    const { signIn } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: 'http://127.0.0.1:8081/' });
    const state = new URL(url).searchParams.get('state') as string;
    await expect(signIn.complete({ state, error: 'access_denied' })).rejects.toMatchObject({
      reason: 'denied',
      returnTo: 'http://127.0.0.1:8081/',
    });
    expect(stub.requests.some((request) => request.body.grant_type === 'authorization_code')).toBe(false);
  });

  it('treats a first registration without an issued client id as incomplete', async () => {
    const { signIn } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    const { client_id: _issued, ...withoutClient } = stub.approve(url);
    await expect(signIn.complete(withoutClient)).rejects.toMatchObject({ reason: 'incomplete' });
  });

  it('without plan permission it keeps the registration, stores no tokens and connects nothing', async () => {
    const { repo, signIn, models } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    const outcome = await signIn.complete(stub.approve(url, { scope: 'openid profile email offline_access resource.invoke' }));
    expect(outcome.outcome).toBe('no_plan');
    const record = readCredentialRecord(repo.rows[0].apiKey);
    expect(record).toMatchObject({ clientId: stub.issuedClientId, accessToken: null, refreshToken: null });
    await expect(models.getConnection()).resolves.toBeNull();
    // The next attempt asks for consent again, with the saved client id.
    const next = new URL((await signIn.start({ redirectUri: REDIRECT, returnTo: null })).url).searchParams;
    expect(next.get('prompt')).toBe('consent');
    expect(next.get('client_id')).toBe(stub.issuedClientId);
  });

  it('refreshes a token near expiry, storing the rotated set; a dead refresh token ends the connection', async () => {
    const { repo, signIn, credentials, models } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    await signIn.complete(stub.approve(url));
    const row = repo.rows[0];
    const before = readCredentialRecord(row.apiKey)!;
    await expect(credentials.accessToken()).resolves.toBe(before.accessToken);

    row.apiKey = (await import('@/domains/platform/models/chatGptCredentials')).encryptCredentialRecord({ ...before, expiresAt: Date.now() - 1 });
    const refreshed = await credentials.accessToken();
    const after = readCredentialRecord(row.apiKey)!;
    expect(refreshed).not.toBe(before.accessToken);
    expect(after.accessToken).toBe(refreshed);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    const refresh = stub.requests.find((request) => request.body.grant_type === 'refresh_token');
    expect(refresh?.body).toEqual({
      grant_type: 'refresh_token',
      client_id: stub.issuedClientId,
      refresh_token: before.refreshToken,
      resource: 'https://api.openai.com/v1',
    });

    row.apiKey = (await import('@/domains/platform/models/chatGptCredentials')).encryptCredentialRecord({ ...after, expiresAt: Date.now() - 1 });
    stub.failNextRefresh('invalid_grant');
    await expect(credentials.accessToken()).rejects.toMatchObject({ code: 'invalid_grant', terminal: true });
    expect(readCredentialRecord(row.apiKey)).toMatchObject({ accessToken: null, refreshToken: null, clientId: stub.issuedClientId });
    await expect(models.getConnection()).resolves.toBeNull();
  });

  it('disconnect revokes the refresh token at the discovered revocation endpoint and forgets the tokens', async () => {
    const { repo, signIn, models } = setup();
    const { url } = await signIn.start({ redirectUri: REDIRECT, returnTo: null });
    await signIn.complete(stub.approve(url));
    const refreshToken = readCredentialRecord(repo.rows[0].apiKey)!.refreshToken;

    await expect(models.disconnect()).resolves.toEqual({ disconnected: true, revocationConfirmed: true });
    const revoke = stub.requests.find((request) => request.path === '/api/accounts/oauth/revoke');
    expect(revoke?.body).toEqual({ token: refreshToken, token_type_hint: 'refresh_token', client_id: stub.issuedClientId });
    expect(readCredentialRecord(repo.rows[0].apiKey)).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    await expect(models.getConnection()).resolves.toBeNull();
  });
});
