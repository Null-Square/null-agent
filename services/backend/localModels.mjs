import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import * as models from "./model.mjs";
import { jsonBody } from "./localOwner.mjs";

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const planScope = 'chatgpt.tokens.use.direct';
export const callbackPath = '/models/chatgpt/callback';
const apiProviders = new Set(['openai', 'anthropic', 'ollama']);
const randomToken = () => randomBytes(32).toString('base64url');
const error = (message, status = 400) => Object.assign(new Error(message), { status });

export function createLocalModels({ account, transport = fetch, adapter = models }) {
  const connections = new Map();
  const attempts = new Map();
  const pending = new Set();

  function prune() {
    for (const session of connections.keys()) {
      if (!account.sessionActive(session)) connections.delete(session);
    }
    for (const [state, attempt] of attempts) {
      if (attempt.expires < Date.now() || !account.sessionActive(attempt.session)) attempts.delete(state);
    }
  }

  function state(session) {
    const connection = connections.get(session);
    if (!connection) return { connection: null };
    const { provider, models, model, email } = connection;
    return { connection: { provider, models, model, email } };
  }

  async function providerFetch(url, init = {}, timeout = 12000, signal) {
    let response;
    try {
      const deadline = AbortSignal.timeout(timeout);
      response = await transport(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    } catch {
      throw error('OpenAI could not be reached. Try again.', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw error('The OpenAI usage limit was reached.', 429);
      if (response.status === 401 || response.status === 403) throw error('OpenAI did not authorize this request. Reconnect and try again.', 400);
      throw error('OpenAI could not complete this request. Try again.', 502);
    }
    return response;
  }

  async function tokenRequest(params) {
    const response = await providerFetch(issuer + '/api/accounts/oauth/token', {
      method: 'POST', body: new URLSearchParams({ ...params, resource }),
    });
    return response.json().catch(() => { throw error('OpenAI returned an invalid token response.', 502); });
  }

  async function validateIdentity(idToken, { clientId, nonce, subject }) {
    if (typeof idToken !== 'string' || idToken.length > 32000) throw error('ChatGPT did not return a valid identity.');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw error('ChatGPT did not return a valid identity.');
    const [encodedHeader, encodedClaims, signature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw error('The ChatGPT identity signature could not be verified.');
    const { keys } = await (await providerFetch(issuer + '/.well-known/jwks.json')).json();
    const jwk = keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256'));
    if (!jwk || !verify('RSA-SHA256', Buffer.from(encodedHeader + '.' + encodedClaims), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
      throw error('The ChatGPT identity signature could not be verified.');
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audience.includes(clientId) ||
        (audience.length > 1 && claims.azp !== clientId) || claims.nonce !== nonce ||
        !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 ||
        typeof claims.sub !== 'string' || !claims.sub || (subject && claims.sub !== subject)) {
      throw error('ChatGPT returned an identity that does not match this sign-in.');
    }
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  }

  function tokens(result, earlier) {
    const scope = result.scope ?? earlier?.scope;
    if (typeof scope !== 'string' || !scope.split(/\s+/).includes(planScope)) {
      throw error('This ChatGPT account did not grant plan usage. Check the selected account or use an API key.');
    }
    if (typeof result.access_token !== 'string' || result.token_type?.toLowerCase() !== 'bearer' ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw error('ChatGPT did not return a usable access token.');
    }
    return { access: result.access_token, refresh: result.refresh_token ?? earlier?.refresh, scope, expires: Date.now() + result.expires_in * 1000 };
  }

  function startChatGPT(session, origin) {
    for (const [key, attempt] of attempts) {
      if (attempt.session === session) attempts.delete(key);
    }
    const saved = account.modelRegistration();
    const state = randomToken();
    const callback = origin + callbackPath;
    const attempt = { session, nonce: randomToken(), verifier: randomToken(), saved, callback, expires: Date.now() + 300000 };
    attempts.set(state, attempt);
    const params = new URLSearchParams({
      client_id: saved.client_id ?? 'dynamic_agent_client', ext_agent_host_id: saved.host_id,
      response_type: 'code', redirect_uri: callback, scope: 'openid profile email offline_access resource.invoke ' + planScope,
      resource, state, nonce: attempt.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    });
    if (!saved.client_id) params.set('agent_name_hint', 'NullSquare Local');
    return { url: issuer + '/api/accounts/authorize?' + params };
  }

  async function finishChatGPT(params) {
    prune();
    const state = params.get('state');
    const attempt = attempts.get(state);
    if (!attempt) return 'This sign-in has expired or was already used. Start again from Models.';
    attempts.delete(state);
    if (params.has('error')) return 'ChatGPT sign-in was declined or interrupted. Start again from Models.';
    const { session, saved, nonce, verifier, callback } = attempt;
    const code = params.get('code');
    const clientId = params.get('client_id') ?? saved.client_id;
    if (!code || code.length > 4096 || !/^oaiapp_[a-zA-Z0-9_-]{1,192}$/.test(clientId ?? '') ||
      (saved.client_id && saved.client_id !== clientId)) return 'OpenAI did not complete the app registration.';
    if (pending.has(session)) return 'Finish your current connection action, then start again from Models.';
    pending.add(session);
    try {
      const result = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback });
      const credential = tokens(result);
      const { subject, email } = await validateIdentity(result.id_token, { clientId, nonce, subject: saved.subject });
      const raw = await (await providerFetch(resource + '/models', { headers: { Authorization: 'Bearer ' + credential.access } })).json();
      if (!Array.isArray(raw.models)) throw error('ChatGPT did not return an account model list.');
      const models = raw.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string')
        .map(model => ({ id: model.slug, label: typeof model.display_name === 'string' ? model.display_name : model.slug }));
      if (!account.sessionActive(session)) return 'The local session ended. Sign in to NullSquare and try again.';
      account.saveModelRegistration(clientId, subject);
      connections.set(session, { provider: 'chatgpt', credential, clientId, email, models, model: models[0]?.id ?? null });
      return 'ChatGPT is connected. Return to Models to choose and test a model.';
    } catch (e) {
      return e.status ? e.message : 'ChatGPT sign-in could not be verified. Start again from Models.';
    } finally {
      pending.delete(session);
    }
  }

  async function completeChatGPT(connection, { model, messages, signal, timeout = 300000 }) {
    if (connection.credential.expires - Date.now() < 60000) {
      if (!connection.credential.refresh) throw error('Your ChatGPT session expired. Reconnect to continue.');
      const renewed = await tokenRequest({ grant_type: 'refresh_token', client_id: connection.clientId, refresh_token: connection.credential.refresh });
      connection.credential = tokens(renewed, connection.credential);
    }
    const response = await providerFetch(resource + '/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.credential.access },
      body: JSON.stringify({
        model,
        instructions: messages.find(message => message.role === 'system')?.content,
        input: messages.filter(message => message.role === 'user'),
        stream: true, store: false,
      }),
    }, timeout, signal);
    const decoder = new TextDecoder();
    let buffer = '', bytes = 0, text = '';
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          throw error('ChatGPT returned an unreadable model response.', 502);
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
        if (text.length > 24000) throw error('The model response exceeded the review limit.', 502);
        if (event.type === 'response.completed' && text.trim()) return text;
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
          const code = event.response?.error?.code ?? event.code;
          if (code === 'subscription_sharing_usage_limit_exceeded') throw error('The ChatGPT plan usage limit was reached.', 429);
          if (code === 'subscription_sharing_usage_unavailable') throw error('This ChatGPT account cannot use plan requests right now.');
          throw error('ChatGPT did not complete the test response.', 502);
        }
      }
    }
    throw error('ChatGPT did not return a completed text response.', 502);
  }

  async function disconnect(session) {
    for (const [key, attempt] of attempts) {
      if (attempt.session === session) attempts.delete(key);
    }
    const connection = connections.get(session);
    connections.delete(session);
    if (!connection?.credential?.refresh) return { ...state(session), disconnected: true };
    let revoked = false;
    try {
      await providerFetch(issuer + '/api/accounts/oauth/revoke', {
        method: 'POST', body: new URLSearchParams({ token: connection.credential.refresh, token_type_hint: 'refresh_token', client_id: connection.clientId }),
      }, 4000);
      revoked = true;
    } catch {
      // The local connection is already cleared, even when the provider cannot confirm revocation.
    }
    return { ...state(session), disconnected: true, revoked };
  }

  async function handle(action, request, response, origin, json) {
    prune();
    const session = account.readySession(request);
    if (!session) return json(response, 401, { error: 'Sign in to manage model connections.' });
    if (action === 'state' && request.method === 'GET') return json(response, 200, state(session));
    if (request.method !== 'POST' || request.headers.origin !== origin) return json(response, 403, { error: 'Manage models from the local workspace.' });
    if (pending.has(session)) return json(response, 409, { error: 'A model connection action is already running.' });
    pending.add(session);
    try {
      if (action === 'chatgpt/start') {
        if (request.headers.host?.startsWith('localhost')) {
          throw error('Open Models at http://127.0.0.1:' + request.socket.localPort + '/models for ChatGPT sign-in.');
        }
        return json(response, 200, startChatGPT(session, origin));
      }
      if (action === 'disconnect') return json(response, 200, await disconnect(session));
      if (action === 'connect') {
        const { provider, apiKey } = await jsonBody(request);
        if (!apiProviders.has(provider)) throw error('Choose a supported provider.');
        if (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[!-~]{1,768}$/.test(apiKey))) throw error('Enter a valid API key.');
        const { models } = await adapter.listModels({ provider, apiKey, transport });
        if (connections.get(session)?.provider === 'chatgpt') await disconnect(session);
        if (!account.sessionActive(session)) throw error('Your local session ended. Sign in and try again.', 401);
        connections.set(session, { provider, apiKey, models: models.map(id => ({ id, label: id })), model: models[0] ?? null });
        return json(response, 200, state(session));
      }
      const connection = connections.get(session);
      if (!connection) throw error('Connect a model provider first.');
      if (action === 'select') {
        const { model } = await jsonBody(request);
        if (!connection.models.some(option => option.id === model)) throw error('Choose a model listed by the provider.');
        connection.model = model;
        return json(response, 200, state(session));
      }
      if (action === 'test') {
        if (!connection.model) throw error('Choose a model to test.');
        if (connection.provider === 'chatgpt') await completeChatGPT(connection, {
          model: connection.model, messages: [{ role: 'user', content: 'Reply with the word Ready.' }], timeout: 45000,
        });
        else await adapter.reviewFindings({
          provider: connection.provider, model: connection.model, apiKey: connection.apiKey, transport,
          evidence: [{ id: 'test-note', title: 'Synthetic test note', excerpt: 'An example purchase was approved by its reviewer.' }],
          signal: AbortSignal.timeout(45000),
        });
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'Model action was not found.' });
    } catch (e) {
      return json(response, e.status ?? 502, { error: typeof e.message === 'string' ? e.message : 'The model request failed.' });
    } finally {
      pending.delete(session);
    }
  }

  function selection(request) {
    const connection = connections.get(account.readySession(request));
    return connection ? { provider: connection.provider, model: connection.model } : null;
  }

  async function review(request, options) {
    const session = account.readySession(request);
    const connection = connections.get(session);
    if (!connection) return adapter.reviewFindings(options);
    if (connection.model !== options.model || connection.provider !== options.provider) {
      throw error('The connected model changed. Select it again before running a review.', 409);
    }
    if (pending.has(session)) throw error('A model connection action is already running.', 409);
    pending.add(session);
    try {
      return await adapter.reviewFindings({
        ...options,
        apiKey: connection.apiKey,
        transport,
        complete: connection.provider === 'chatgpt' ? input => completeChatGPT(connection, input) : undefined,
      });
    } finally {
      pending.delete(session);
    }
  }

  return { handle, finishChatGPT, disconnect, selection, review };
}
