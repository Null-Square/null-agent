import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { ChatGptEndpoints } from '@/domains/platform/models/chatGptAuth';

/**
 * A stand-in for auth.openai.com and api.openai.com, served on 127.0.0.1 over real HTTP: the
 * authorization step (a browser at OpenAI) is played by `approve`, everything after it is the real
 * client talking to this server: code exchange with PKCE, JWKS, refresh, revocation, plan models,
 * and a streamed Responses answer.
 */
export type ChatGptStub = {
  endpoints: ChatGptEndpoints;
  apiBaseUrl: string;
  issuedClientId: string;
  /** Plays the person approving in the browser: returns the callback query ChatGPT would send. */
  approve(authorizeUrl: string, options?: { scope?: string; subject?: string; email?: string }): Record<string, string>;
  requests: Array<{ method: string; path: string; body: Record<string, string>; authorization?: string }>;
  /** Make the next refresh answer with this OAuth error code. */
  failNextRefresh(code: string | null): void;
  signIdToken(claims: Record<string, unknown>): string;
  close(): Promise<void>;
};

export const startChatGptStub = async (): Promise<ChatGptStub> => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stub-key';
  const issuedClientId = `oaiapp_${randomUUID().slice(0, 8)}`;
  const codes = new Map<string, { challenge: string; nonce: string; clientId: string; scope: string; subject: string; email: string }>();
  const refreshTokens = new Map<string, { clientId: string; scope: string; subject: string }>();
  const requests: ChatGptStub['requests'] = [];
  let refreshFailure: string | null = null;
  let issuer = '';

  const signIdToken = (claims: Record<string, unknown>, key: KeyObject = privateKey): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
    return `${header}.${payload}.${signature}`;
  };

  const tokens = (clientId: string, scope: string, subject: string, nonce: string | null) => {
    const refresh = `rt_${randomUUID()}`;
    refreshTokens.set(refresh, { clientId, scope, subject });
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: `at_${randomUUID()}`,
      refresh_token: refresh,
      id_token: signIdToken({
        iss: issuer, aud: clientId, sub: subject, email: `${subject}@example.com`, iat: now, exp: now + 3600,
        ...(nonce ? { nonce } : {}),
      }),
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
    };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const body = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body, authorization: req.headers.authorization });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (url.pathname === '/.well-known/jwks.json') {
        return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, { issuer, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` });
      }
      if (url.pathname === '/api/accounts/oauth/token' && body.grant_type === 'authorization_code') {
        const issuedCode = codes.get(body.code ?? '');
        codes.delete(body.code ?? '');
        const verifierHash = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
        if (!issuedCode || verifierHash !== issuedCode.challenge || body.client_id !== issuedCode.clientId
          || body.resource !== 'https://api.openai.com/v1' || !body.redirect_uri?.startsWith('http://127.0.0.1:')) {
          return json(400, { error: 'invalid_grant', error_description: 'bad code' });
        }
        return json(200, tokens(issuedCode.clientId, issuedCode.scope, issuedCode.subject, issuedCode.nonce));
      }
      if (url.pathname === '/api/accounts/oauth/token' && body.grant_type === 'refresh_token') {
        if (refreshFailure) {
          const code = refreshFailure;
          refreshFailure = null;
          return json(400, { error: code });
        }
        const grant = refreshTokens.get(body.refresh_token ?? '');
        refreshTokens.delete(body.refresh_token ?? '');
        if (!grant || grant.clientId !== body.client_id) return json(400, { error: 'refresh_token_reused' });
        return json(200, tokens(grant.clientId, grant.scope, grant.subject, null));
      }
      if (url.pathname === '/api/accounts/oauth/revoke') {
        refreshTokens.delete(body.token ?? '');
        res.writeHead(200);
        return res.end();
      }
      if (url.pathname === '/v1/models') {
        if (!req.headers.authorization?.startsWith('Bearer at_')) return json(401, { detail: 'no' });
        return json(200, {
          models: [
            { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
            { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list' },
          ],
        });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;

  return {
    endpoints: {
      issuer,
      authorizeUrl: `${issuer}/api/accounts/authorize`,
      tokenUrl: `${issuer}/api/accounts/oauth/token`,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
    },
    apiBaseUrl: `${issuer}/v1`,
    issuedClientId,
    requests,
    approve(authorizeUrl, options = {}) {
      const url = new URL(authorizeUrl);
      const requested = url.searchParams.get('client_id') as string;
      const clientId = requested === 'dynamic_agent_client' ? issuedClientId : requested;
      const code = `code_${randomUUID()}`;
      const scope = options.scope ?? (url.searchParams.get('scope') as string);
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') as string,
        nonce: url.searchParams.get('nonce') as string,
        clientId,
        scope,
        subject: options.subject ?? 'user-1',
        email: options.email ?? 'user-1@example.com',
      });
      return {
        code,
        state: url.searchParams.get('state') as string,
        scope: scope.split(' ').join('+'),
        ...(requested === 'dynamic_agent_client' ? { client_id: issuedClientId } : {}),
      };
    },
    failNextRefresh(code) {
      refreshFailure = code;
    },
    signIdToken: (claims) => signIdToken(claims),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
