import { describe, expect, it, vi } from 'vitest';
import {
  checkDnsTxt,
  checkHttpWellKnown,
  type ResolveTxtFn,
} from '@/domains/security-ops/scopes/verificationChecks';
import { expectedVerificationValue } from '@null-ai/contracts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const VALUE = expectedVerificationValue(TOKEN);

const dnsError = (code: string): ResolveTxtFn => () => {
  const err = new Error(`dns ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return Promise.reject(err);
};

const fetchReturning = (
  responder: (url: string) => Response,
): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0]) => responder(String(input))) as unknown as typeof fetch;

describe('checkDnsTxt', () => {
  it('verifies an exact record', async () => {
    const r = await checkDnsTxt('example.com', TOKEN, { resolveTxt: async () => [[VALUE]] });
    expect(r).toMatchObject({ verified: true, reason: 'verified' });
  });

  it('verifies a multi-string (chunked) record', async () => {
    const r = await checkDnsTxt('example.com', TOKEN, { resolveTxt: async () => [['ns-verify=', TOKEN]] });
    expect(r.verified).toBe(true);
  });

  it('verifies alongside unrelated SPF/DKIM records', async () => {
    const r = await checkDnsTxt('example.com', TOKEN, {
      resolveTxt: async () => [['v=spf1 -all'], [VALUE]],
    });
    expect(r.verified).toBe(true);
  });

  it('reports mismatch when a record exists but is wrong', async () => {
    const r = await checkDnsTxt('example.com', TOKEN, { resolveTxt: async () => [['ns-verify=nope']] });
    expect(r).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('reports not_found on ENODATA / ENOTFOUND', async () => {
    for (const code of ['ENODATA', 'ENOTFOUND']) {
      const r = await checkDnsTxt('example.com', TOKEN, { resolveTxt: dnsError(code) });
      expect(r.reason).toBe('not_found');
    }
  });

  it('reports transient on resolver errors (ESERVFAIL/ETIMEOUT)', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT']) {
      const r = await checkDnsTxt('example.com', TOKEN, { resolveTxt: dnsError(code) });
      expect(r.reason).toBe('transient');
    }
  });

  it('rejects a missing token', async () => {
    const r = await checkDnsTxt('example.com', null, { resolveTxt: async () => [[VALUE]] });
    expect(r.reason).toBe('invalid');
  });
});

describe('checkHttpWellKnown', () => {
  const publicGuard = async (hostname: string) => ({
    status: 'allowed' as const,
    hostname,
    addresses: ['93.184.216.34'],
  });

  it('verifies an exact body', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x'],
      guard: publicGuard,
      fetchImpl: fetchReturning(() => new Response(VALUE, { status: 200 })),
    });
    expect(r).toMatchObject({ verified: true, reason: 'verified' });
  });

  it('falls back from apex (404) to www (200)', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x', 'https://www.example.com/x'],
      guard: publicGuard,
      fetchImpl: fetchReturning((url) =>
        url.includes('www.') ? new Response(VALUE, { status: 200 }) : new Response('no', { status: 404 }),
      ),
    });
    expect(r.verified).toBe(true);
  });

  it('revalidates every redirect hop and stops before a rejected address is fetched', async () => {
    const guardedHosts: string[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://www.example.com/private' },
    })) as unknown as typeof fetch;
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x'],
      guard: async (hostname) => {
        guardedHosts.push(hostname);
        return hostname.startsWith('www.')
          ? { status: 'rejected' as const, reason: 'private_address' as const, detail: 'private address' }
          : { status: 'allowed' as const, hostname, addresses: ['93.184.216.34'] };
      },
      fetchImpl,
    });

    expect(r.reason).toBe('unreachable');
    expect(guardedHosts).toEqual(['example.com', 'www.example.com']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports not_found on 404 from all candidates', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x'],
      guard: publicGuard,
      fetchImpl: fetchReturning(() => new Response('no', { status: 404 })),
    });
    expect(r.reason).toBe('not_found');
  });

  it('reports mismatch on a wrong body', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x'],
      guard: publicGuard,
      fetchImpl: fetchReturning(() => new Response('ns-verify=wrong', { status: 200 })),
    });
    expect(r.reason).toBe('mismatch');
  });

  it('reports unreachable when every candidate throws', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: ['https://example.com/x'],
      guard: publicGuard,
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });
    expect(r.reason).toBe('unreachable');
  });

  it('rejects a missing token', async () => {
    const r = await checkHttpWellKnown('example.com', null, {
      urls: ['https://example.com/x'],
      guard: publicGuard,
      fetchImpl: fetchReturning(() => new Response(VALUE, { status: 200 })),
    });
    expect(r.reason).toBe('invalid');
  });
});
