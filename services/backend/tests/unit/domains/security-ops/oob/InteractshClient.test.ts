import { constants, createCipheriv, publicEncrypt, randomBytes } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InteractshClient } from '@/domains/security-ops/oob/InteractshClient';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const encryptServerInteraction = (publicKeyPem: string, interaction: unknown) => {
  const aesKey = randomBytes(32);
  const encryptedKey = publicEncrypt(
    {
      key: publicKeyPem,
      oaepHash: 'sha256',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    aesKey,
  ).toString('base64');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-ctr', aesKey, iv);
  const encryptedPayload = Buffer.concat([
    iv,
    cipher.update(Buffer.from(JSON.stringify(interaction), 'utf8')),
    cipher.final(),
  ]).toString('base64');
  return { encryptedKey, encryptedPayload };
};

describe('InteractshClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a correlation id and decrypts official poll responses', async () => {
    let registeredPublicKey = '';
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        registeredPublicKey = Buffer.from(body['public-key'], 'base64').toString('utf8');
        expect(body['correlation-id']).toHaveLength(20);
        expect(body['secret-key']).toMatch(/[0-9a-f-]{36}/u);
        expect(init?.headers).toMatchObject({ authorization: 'server-token' });
        return jsonResponse({ message: 'registration successful' });
      })
      .mockImplementationOnce(async (url: URL, init?: RequestInit) => {
        expect(url.pathname).toBe('/poll');
        expect(url.searchParams.get('id')).toHaveLength(20);
        expect(url.searchParams.get('secret')).toMatch(/[0-9a-f-]{36}/u);
        expect(init?.headers).toMatchObject({ authorization: 'server-token' });

        const { encryptedKey, encryptedPayload } = encryptServerInteraction(registeredPublicKey, {
          protocol: 'http',
          'full-id': 'token.oast.nullsquare.net',
          'remote-address': '198.51.100.1:443',
          'raw-request': 'GET /probe HTTP/1.1\r\nHost: token.oast.nullsquare.net\r\n\r\n',
          timestamp: '2026-05-01T00:00:00Z',
        });
        return jsonResponse({ data: [encryptedPayload], aes_key: encryptedKey });
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new InteractshClient({
      serverUrl: 'http://interactsh:8081',
      authToken: 'server-token',
      callbackDomain: 'oast.nullsquare.net',
      callbackScheme: 'http',
    });

    const token = await client.registerToken();
    const interactions = await client.pollToken(token);

    expect(token.token).toHaveLength(33);
    expect(token.url).toBe(`http://${token.hostname}/`);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      protocol: 'http',
      sourceIp: '198.51.100.1:443',
      hostname: 'token.oast.nullsquare.net',
      method: 'GET',
      path: '/probe',
    });
  });
});
