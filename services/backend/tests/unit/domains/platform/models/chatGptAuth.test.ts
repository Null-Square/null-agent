import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkce,
  loopbackRedirectUri,
  refreshTokens,
  verifyIdToken,
} from '@/domains/platform/models/chatGptAuth';
import { startChatGptStub, type ChatGptStub } from '../../../../helpers/chatGptStub';

describe('chatGptAuth', () => {
  let stub: ChatGptStub;
  beforeAll(async () => {
    stub = await startChatGptStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  it('makes a PKCE pair whose challenge is the unpadded base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toContain('=');
  });

  it('redirects to /auth/callback on the literal 127.0.0.1 at the app port, never localhost', () => {
    expect(loopbackRedirectUri('http://localhost:8081')).toBe('http://127.0.0.1:8081/auth/callback');
    expect(loopbackRedirectUri('http://localhost:8080/')).toBe('http://127.0.0.1:8080/auth/callback');
    expect(loopbackRedirectUri('http://localhost')).toBe('http://127.0.0.1:80/auth/callback');
  });

  it('sends id_token_hint only on a returning sign-in, and agent_name_hint only on the first', () => {
    const common = {
      endpoints: stub.endpoints, hostId: 'urn:uuid:h', redirectUri: 'http://127.0.0.1:1/auth/callback',
      state: 's', nonce: 'n', codeChallenge: 'c', idTokenHint: 'id', loginHint: 'a@b.c',
    };
    const first = new URL(buildAuthorizeUrl({ ...common, clientId: 'dynamic_agent_client' })).searchParams;
    expect(first.get('agent_name_hint')).toBe('Null AI');
    expect(first.has('id_token_hint')).toBe(false);
    const again = new URL(buildAuthorizeUrl({ ...common, clientId: 'oaiapp_x' })).searchParams;
    expect(again.get('id_token_hint')).toBe('id');
    expect(again.has('agent_name_hint')).toBe(false);
    expect(again.has('prompt')).toBe(false);
  });

  describe('verifyIdToken checks signature, issuer, audience, expiry and nonce', () => {
    const now = () => Math.floor(Date.now() / 1000);
    const claims = () => ({ iss: stub.endpoints.issuer, aud: 'oaiapp_x', sub: 'u1', email: 'u1@example.com', exp: now() + 600, nonce: 'n1' });

    it('accepts a valid token and returns who signed in', async () => {
      await expect(verifyIdToken({ endpoints: stub.endpoints, idToken: stub.signIdToken(claims()), clientId: 'oaiapp_x', nonce: 'n1' }))
        .resolves.toEqual({ subject: 'u1', email: 'u1@example.com' });
    });

    it.each([
      ['another nonce', { nonce: 'other' }, 'another sign-in'],
      ['another audience', { aud: 'oaiapp_y' }, 'another client'],
      ['another issuer', { iss: 'https://evil.example' }, 'wrong issuer'],
      ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'expired'],
    ])('refuses %s', async (_name, change, message) => {
      const idToken = stub.signIdToken({ ...claims(), ...change });
      await expect(verifyIdToken({ endpoints: stub.endpoints, idToken, clientId: 'oaiapp_x', nonce: 'n1' })).rejects.toThrow(message);
    });

    it('refuses a token whose payload was changed after signing', async () => {
      const [header, , signature] = stub.signIdToken(claims()).split('.');
      const forged = Buffer.from(JSON.stringify({ ...claims(), sub: 'someone-else' })).toString('base64url');
      await expect(verifyIdToken({ endpoints: stub.endpoints, idToken: `${header}.${forged}.${signature}`, clientId: 'oaiapp_x', nonce: 'n1' }))
        .rejects.toThrow('signature');
    });
  });

  it('marks the documented unusable-refresh-token codes as terminal, and others not', async () => {
    stub.failNextRefresh('refresh_token_reused');
    await expect(refreshTokens({ endpoints: stub.endpoints, clientId: 'c', refreshToken: 'r' })).rejects.toMatchObject({ terminal: true });
    stub.failNextRefresh('invalid_client');
    await expect(refreshTokens({ endpoints: stub.endpoints, clientId: 'c', refreshToken: 'r' })).rejects.toMatchObject({ terminal: false, code: 'invalid_client' });
  });
});
