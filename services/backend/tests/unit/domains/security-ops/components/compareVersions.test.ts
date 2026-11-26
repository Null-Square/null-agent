import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isVersionInRange,
} from '@/domains/security-ops/components/compareVersions';

const sign = (value: number | null) => (value === null ? null : Math.sign(value));

describe('compareVersions — semver', () => {
  it('orders release versions numerically, not lexically', () => {
    // The classic trap: string comparison puts "1.10.0" below "1.9.0".
    expect(sign(compareVersions('semver', '1.10.0', '1.9.0'))).toBe(1);
    expect(sign(compareVersions('semver', '1.2.3', '1.2.4'))).toBe(-1);
    expect(sign(compareVersions('semver', '2.0.0', '1.99.99'))).toBe(1);
  });

  it('treats missing components as zero', () => {
    expect(sign(compareVersions('semver', '1.2', '1.2.0'))).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(sign(compareVersions('semver', '1.0.0-rc.1', '1.0.0'))).toBe(-1);
    expect(sign(compareVersions('semver', '1.0.0', '1.0.0-rc.1'))).toBe(1);
  });

  it('follows semver prerelease precedence', () => {
    // semver.org §11: alpha < alpha.1 < beta < rc.1
    expect(sign(compareVersions('semver', '1.0.0-alpha', '1.0.0-alpha.1'))).toBe(-1);
    expect(sign(compareVersions('semver', '1.0.0-alpha.1', '1.0.0-beta'))).toBe(-1);
    expect(sign(compareVersions('semver', '1.0.0-beta', '1.0.0-rc.1'))).toBe(-1);
  });

  it('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    expect(sign(compareVersions('semver', '1.0.0-1', '1.0.0-alpha'))).toBe(-1);
  });

  it('compares numeric prerelease identifiers numerically', () => {
    expect(sign(compareVersions('semver', '1.0.0-rc.2', '1.0.0-rc.10'))).toBe(-1);
  });

  it('ignores build metadata', () => {
    expect(sign(compareVersions('semver', '1.0.0+build.1', '1.0.0+build.2'))).toBe(0);
  });
});

describe('compareVersions — dotted', () => {
  it('handles WordPress-style four-part versions', () => {
    expect(sign(compareVersions('dotted', '6.4.2.1', '6.4.2'))).toBe(1);
    expect(sign(compareVersions('dotted', '6.4.2', '6.4.10'))).toBe(-1);
  });

  it('treats missing components as zero', () => {
    expect(sign(compareVersions('dotted', '6.4', '6.4.0.0'))).toBe(0);
  });
});

describe('compareVersions — cpe', () => {
  it('orders alphanumeric segments such as OpenSSL letter releases', () => {
    expect(sign(compareVersions('cpe', '1.0.2k', '1.0.2j'))).toBe(1);
    expect(sign(compareVersions('cpe', '1.0.2', '1.0.2a'))).toBe(-1);
  });

  it('still orders plain numeric versions', () => {
    expect(sign(compareVersions('cpe', '1.2.3', '1.10.0'))).toBe(-1);
  });
});

describe('compareVersions — refusals', () => {
  it('refuses an unknown scheme', () => {
    // Refusing is the point: a guessed ordering becomes a vulnerability claim
    // about a real customer.
    expect(compareVersions('unknown', '1.0.0', '2.0.0')).toBeNull();
  });

  it('refuses non-numeric components under numeric schemes', () => {
    expect(compareVersions('semver', 'latest', '1.0.0')).toBeNull();
    expect(compareVersions('dotted', '6.x', '6.4')).toBeNull();
  });

  it('refuses empty input', () => {
    expect(compareVersions('semver', '', '1.0.0')).toBeNull();
    expect(compareVersions('semver', '1.0.0', '   ')).toBeNull();
  });
});

describe('isVersionInRange', () => {
  const range = (over: Partial<Parameters<typeof isVersionInRange>[0]['range']> = {}) => ({
    introducedVersion: null,
    introducedInclusive: true,
    fixedVersion: null,
    fixedInclusive: false,
    ...over,
  });

  it('matches a version below an exclusive fixed bound', () => {
    expect(
      isVersionInRange({
        scheme: 'semver',
        version: '3.21.4',
        range: range({ fixedVersion: '3.21.5' }),
      }),
    ).toBe(true);
  });

  it('excludes the fixed version itself when the bound is exclusive', () => {
    // "fixed in 3.21.5" means 3.21.5 is safe. Getting this backwards would
    // alert every customer who had already patched.
    expect(
      isVersionInRange({
        scheme: 'semver',
        version: '3.21.5',
        range: range({ fixedVersion: '3.21.5' }),
      }),
    ).toBe(false);
  });

  it('includes the last affected version when the bound is inclusive', () => {
    expect(
      isVersionInRange({
        scheme: 'semver',
        version: '3.21.5',
        range: range({ fixedVersion: '3.21.5', fixedInclusive: true }),
      }),
    ).toBe(true);
  });

  it('respects an inclusive introduced bound', () => {
    const bounds = range({ introducedVersion: '2.0.0', fixedVersion: '2.5.0' });
    expect(isVersionInRange({ scheme: 'semver', version: '2.0.0', range: bounds })).toBe(true);
    expect(isVersionInRange({ scheme: 'semver', version: '1.9.9', range: bounds })).toBe(false);
  });

  it('respects an exclusive introduced bound', () => {
    const bounds = range({
      introducedVersion: '2.0.0',
      introducedInclusive: false,
      fixedVersion: '2.5.0',
    });
    expect(isVersionInRange({ scheme: 'semver', version: '2.0.0', range: bounds })).toBe(false);
    expect(isVersionInRange({ scheme: 'semver', version: '2.0.1', range: bounds })).toBe(true);
  });

  it('refuses a range with no bounds at all', () => {
    // An unbounded range would match every version of the component; that is
    // never a claim worth inferring.
    expect(isVersionInRange({ scheme: 'semver', version: '1.0.0', range: range() })).toBeNull();
  });

  it('refuses when the scheme is unknown', () => {
    expect(
      isVersionInRange({
        scheme: 'unknown',
        version: '1.0.0',
        range: range({ fixedVersion: '2.0.0' }),
      }),
    ).toBeNull();
  });

  it('refuses when a bound cannot be compared', () => {
    expect(
      isVersionInRange({
        scheme: 'semver',
        version: '1.0.0',
        range: range({ fixedVersion: 'unreleased' }),
      }),
    ).toBeNull();
  });

  it('treats a prerelease as inside a range fixed at the release', () => {
    expect(
      isVersionInRange({
        scheme: 'semver',
        version: '2.0.0-rc.1',
        range: range({ fixedVersion: '2.0.0' }),
      }),
    ).toBe(true);
  });
});
