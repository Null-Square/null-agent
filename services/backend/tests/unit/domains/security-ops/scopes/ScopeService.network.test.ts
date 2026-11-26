import { describe, expect, it } from 'vitest';
import {
  findCloudBlockedNetworkTargetsInCommand,
  findCloudBlockedNetworkTargetInUrl,
  isCloudBlockedIpv4CidrTarget,
  isCloudBlockedHost,
  isIpv4InCidr,
  isPrivateIpv4CidrTarget,
  isValidIpv4Cidr,
  parseIpv4AddressLike,
} from '@/domains/security-ops/scopes/networkTargetPolicy';
import {
  isValidDomainTarget,
  normalizeScopeTargetValue,
} from '@/domains/security-ops/scopes/ScopeService';
import {
  findScopeDomainBoundaryConflict,
  resolveDomainScopeBoundary,
} from '@/domains/security-ops/scopes/scopeTargetBoundary';

describe('isIpv4InCidr', () => {
  it('matches addresses inside a /24', () => {
    expect(isIpv4InCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
    expect(isIpv4InCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
  });

  it('handles non-octet boundaries correctly', () => {
    expect(isIpv4InCidr('10.0.0.130', '10.0.0.128/25')).toBe(true);
    expect(isIpv4InCidr('10.0.0.127', '10.0.0.128/25')).toBe(false);
  });

  it('supports /0 and /32', () => {
    expect(isIpv4InCidr('203.0.113.42', '0.0.0.0/0')).toBe(true);
    expect(isIpv4InCidr('203.0.113.42', '203.0.113.42/32')).toBe(true);
    expect(isIpv4InCidr('203.0.113.43', '203.0.113.42/32')).toBe(false);
  });

  it('returns false for invalid inputs', () => {
    expect(isIpv4InCidr('not-an-ip', '10.0.0.0/24')).toBe(false);
    expect(isIpv4InCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
    expect(isIpv4InCidr('10.0.0.1', 'bad-cidr')).toBe(false);
  });
});

describe('target validation helpers', () => {
  it('validates IPv4 CIDR ranges and single IP normalization', () => {
    expect(isValidIpv4Cidr('10.10.20.0/24')).toBe(true);
    expect(isValidIpv4Cidr('203.0.113.10/32')).toBe(true);
    expect(isValidIpv4Cidr('203.0.113.10')).toBe(false);
    expect(isValidIpv4Cidr('10.10.20.0/99')).toBe(false);
    expect(normalizeScopeTargetValue('cidr', '203.0.113.10')).toBe('203.0.113.10/32');
  });

  it('accepts valid hostnames and rejects malformed domains', () => {
    expect(isValidDomainTarget('example.com')).toBe(true);
    expect(isValidDomainTarget('api.example.com')).toBe(true);
    expect(isValidDomainTarget('localhost')).toBe(false);
    expect(isValidDomainTarget('-bad.example.com')).toBe(false);
    expect(isValidDomainTarget('bad_domain.example.com')).toBe(false);
    expect(normalizeScopeTargetValue('domain', 'https://www.Example.com/path?q=1')).toBe('example.com');
  });
});

describe('scope domain boundary helpers', () => {
  it('groups apex and subdomain targets under the same registrable boundary', () => {
    expect(resolveDomainScopeBoundary('api.example.co.uk')).toBe('example.co.uk');
    expect(findScopeDomainBoundaryConflict([
      { type: 'domain', value: 'example.co.uk' },
      { type: 'domain', value: 'api.example.co.uk' },
      { type: 'domain', value: 'admin.api.example.co.uk' },
    ])).toBeNull();
  });

  it('rejects unrelated domain roots in the same scope', () => {
    const conflict = findScopeDomainBoundaryConflict([
      { type: 'domain', value: 'example.com' },
      { type: 'domain', value: 'other-company.com' },
    ]);

    expect(conflict?.expected.boundary).toBe('example.com');
    expect(conflict?.received.boundary).toBe('other-company.com');
  });

  it('keeps hosted-site tenant domains separate when the platform parent is shared', () => {
    expect(resolveDomainScopeBoundary('admin.shop.myshopify.com')).toBe('shop.myshopify.com');
    expect(resolveDomainScopeBoundary('chihuahua-lizard-b7a6.squarespace.com'))
      .toBe('chihuahua-lizard-b7a6.squarespace.com');

    const conflict = findScopeDomainBoundaryConflict([
      { type: 'domain', value: 'shop.myshopify.com' },
      { type: 'domain', value: 'other-shop.myshopify.com' },
    ]);

    expect(conflict?.expected.boundary).toBe('shop.myshopify.com');
    expect(conflict?.received.boundary).toBe('other-shop.myshopify.com');
  });
});

describe('private and cloud-blocked network policy', () => {
  it('classifies private CIDRs as auto-verifiable private targets', () => {
    expect(isPrivateIpv4CidrTarget('10.10.20.0/24')).toBe(true);
    expect(isPrivateIpv4CidrTarget('172.16.5.0/24')).toBe(true);
    expect(isPrivateIpv4CidrTarget('192.168.1.0/24')).toBe(true);
    expect(isPrivateIpv4CidrTarget('203.0.113.0/24')).toBe(false);
  });

  it('blocks cloud execution for private or reserved ranges', () => {
    expect(isCloudBlockedIpv4CidrTarget('192.168.1.0/24')).toBe(true);
    expect(isCloudBlockedIpv4CidrTarget('127.0.0.1/32')).toBe(true);
    expect(isCloudBlockedIpv4CidrTarget('169.254.169.254/32')).toBe(true);
    expect(isCloudBlockedIpv4CidrTarget('203.0.113.0/24')).toBe(false);
  });

  it('extracts blocked network targets from shell commands', () => {
    expect(findCloudBlockedNetworkTargetsInCommand('nmap -sV 192.168.1.0/24')).toContain('192.168.1.0/24');
    expect(findCloudBlockedNetworkTargetsInCommand('curl http://169.254.169.254/latest/meta-data')).toContain('169.254.169.254');
    expect(findCloudBlockedNetworkTargetsInCommand('curl https://example.com')).toEqual([]);
  });

  it('recognizes alternate IPv4 address forms used by URL parsers and network tools', () => {
    expect(parseIpv4AddressLike('127.1')).toBe(0x7f000001);
    expect(parseIpv4AddressLike('0177.0.0.1')).toBe(0x7f000001);
    expect(parseIpv4AddressLike('0x7f000001', { allowSingleNumber: true })).toBe(0x7f000001);
    expect(parseIpv4AddressLike('2130706433', { allowSingleNumber: true })).toBe(0x7f000001);

    expect(findCloudBlockedNetworkTargetsInCommand('curl http://2130706433/')).toContain('127.0.0.1');
    expect(findCloudBlockedNetworkTargetsInCommand('curl http://0x7f000001/')).toContain('127.0.0.1');
    expect(findCloudBlockedNetworkTargetsInCommand('nmap 0300.0250.0001.0001')).toContain('0300.0250.0001.0001');
  });

  it('recognizes blocked localhost and IPv6 private/reserved hosts', () => {
    expect(isCloudBlockedHost('localhost')).toBe(true);
    expect(isCloudBlockedHost('app.localhost')).toBe(true);
    expect(isCloudBlockedHost('::1')).toBe(true);
    expect(isCloudBlockedHost('::ffff:192.168.1.10')).toBe(true);
    expect(isCloudBlockedHost('fe80::1')).toBe(true);
    expect(isCloudBlockedHost('fc00::1')).toBe(true);
    expect(isCloudBlockedHost('example.com')).toBe(false);
  });

  it('checks only the outbound URL host for direct HTTP/browser tool targets', () => {
    expect(findCloudBlockedNetworkTargetInUrl('http://127.1/admin')).toBe('127.0.0.1');
    expect(findCloudBlockedNetworkTargetInUrl('http://[::ffff:192.168.1.10]/')).toContain('::ffff');
    expect(findCloudBlockedNetworkTargetInUrl('https://example.com/callback?next=http://169.254.169.254')).toBeNull();
  });
});

