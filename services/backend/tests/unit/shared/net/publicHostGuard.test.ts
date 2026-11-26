/**
 * publicHostGuard Unit Tests
 *
 * This module is a security boundary, not a utility: it is the only thing
 * standing between an unauthenticated visitor and our outbound network. The
 * tests are written adversarially — each block is a bypass someone would
 * actually try, not a happy path.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPublicHost,
  isPublicAddress,
  normalizeHostname,
} from '@/shared/net/publicHostGuard';

const reasonOf = async (raw: string, resolve?: (h: string) => Promise<string[]>) => {
  const result = await assertPublicHost(raw, { resolve: resolve ?? (async () => ['93.184.216.34']) });
  return result.status === 'rejected' ? result.reason : null;
};

describe('isPublicAddress', () => {
  it('accepts globally routable IPv4', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '203.0.114.1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('rejects every reserved IPv4 range', () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254', // cloud instance metadata — the one that matters most
      '169.254.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ];
    for (const ip of blocked) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('does not over-block addresses adjacent to reserved ranges', () => {
    // 172.15/172.32 sit either side of 172.16.0.0/12; 100.128 is past CGNAT.
    for (const ip of ['172.15.255.255', '172.32.0.1', '100.128.0.1', '11.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('rejects reserved IPv6 ranges', () => {
    const blocked = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '100::1'];
    for (const ip of blocked) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('accepts globally routable IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4009:80f::200e']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('unwraps IPv4-mapped IPv6 rather than letting it bypass the v4 table', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true);
  });

  it('unwraps 6to4 addresses that embed a private v4', () => {
    // 2002:7f00:0001:: embeds 127.0.0.1
    expect(isPublicAddress('2002:7f00:1::')).toBe(false);
    // 2002:a00:1:: embeds 10.0.0.1
    expect(isPublicAddress('2002:a00:1::')).toBe(false);
  });

  it('rejects anything that is not an IP at all', () => {
    for (const value of ['', 'not-an-ip', '999.999.999.999', '1.2.3', '1.2.3.4.5']) {
      expect(isPublicAddress(value), value).toBe(false);
    }
  });
});

describe('normalizeHostname', () => {
  it('recovers the host from URLs, credentials and ports', () => {
    for (const raw of [
      'https://www.acme.com/pricing?a=1',
      'acme.com:8443',
      'user:pass@acme.com',
      'security@acme.com',
      '  ACME.com.  ',
    ]) {
      expect(normalizeHostname(raw), raw).toEqual({ hostname: 'acme.com' });
    }
  });

  it('refuses bare IP literals in either family', () => {
    for (const raw of ['127.0.0.1', '169.254.169.254', 'http://10.0.0.1/', '::1', '[::1]']) {
      const result = normalizeHostname(raw);
      expect('reason' in result && result.reason, raw).toBe('ip_literal');
    }
  });

  it('refuses hosts that only resolve on a private network', () => {
    for (const raw of ['localhost', 'jenkins.internal', 'nas.local', 'box.lan', 'app.corp']) {
      const result = normalizeHostname(raw);
      expect('reason' in result && result.reason, raw).toBe('non_public_suffix');
    }
  });

  it('refuses government and military estates outright', () => {
    for (const raw of ['whitehouse.gov', 'army.mil', 'nato.int']) {
      const result = normalizeHostname(raw);
      expect('reason' in result && result.reason, raw).toBe('denylisted');
    }
  });

  it('refuses malformed input', () => {
    for (const raw of ['', '   ', 'acme', 'acme..com', '-acme.com', 'acme.c', 'what is a pentest']) {
      const result = normalizeHostname(raw);
      expect('reason' in result && result.reason, raw).toBe('invalid');
    }
  });
});

describe('assertPublicHost', () => {
  it('returns the resolved addresses so the caller can pin the connection', async () => {
    const result = await assertPublicHost('acme.com', { resolve: async () => ['93.184.216.34'] });

    expect(result).toEqual({
      status: 'allowed',
      hostname: 'acme.com',
      addresses: ['93.184.216.34'],
    });
  });

  it('rejects a host that resolves to a private address', async () => {
    expect(await reasonOf('acme.com', async () => ['127.0.0.1'])).toBe('private_address');
    expect(await reasonOf('acme.com', async () => ['169.254.169.254'])).toBe('private_address');
  });

  it('rejects when ANY resolved address is private, not just the first', async () => {
    // A split answer is a rebinding attempt, not a misconfiguration: connecting
    // to the public address now says nothing about which one a retry would use.
    expect(await reasonOf('acme.com', async () => ['93.184.216.34', '10.0.0.1'])).toBe(
      'private_address',
    );
  });

  it('rejects a host that does not resolve', async () => {
    expect(
      await reasonOf('acme.com', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBe('unresolvable');
    expect(await reasonOf('acme.com', async () => [])).toBe('unresolvable');
  });

  it('never resolves a host it has already rejected on shape', async () => {
    let resolverCalls = 0;
    const resolve = async () => {
      resolverCalls += 1;
      return ['93.184.216.34'];
    };

    await assertPublicHost('169.254.169.254', { resolve });
    await assertPublicHost('localhost', { resolve });
    await assertPublicHost('army.mil', { resolve });

    expect(resolverCalls).toBe(0);
  });

  it('applies a caller-supplied denylist to the host and its parents', async () => {
    const options = { resolve: async () => ['93.184.216.34'], denylist: ['blocked.com'] };

    const exact = await assertPublicHost('blocked.com', options);
    expect(exact.status === 'rejected' && exact.reason).toBe('denylisted');

    const child = await assertPublicHost('api.blocked.com', options);
    expect(child.status === 'rejected' && child.reason).toBe('denylisted');

    const unrelated = await assertPublicHost('notblocked.com', options);
    expect(unrelated.status).toBe('allowed');

    // A suffix match must be on a label boundary, not a substring.
    const lookalike = await assertPublicHost('notblocked.com', {
      resolve: options.resolve,
      denylist: ['locked.com'],
    });
    expect(lookalike.status).toBe('allowed');
  });
});
