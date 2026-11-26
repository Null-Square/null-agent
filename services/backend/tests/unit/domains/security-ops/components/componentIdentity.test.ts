import { describe, expect, it } from 'vitest';

import {
  detectVersionScheme,
  hasBackportRisk,
  normalizeAliasText,
  normalizeObservation,
  normalizeVersion,
  resolveComponentIdentity,
  resolveComponentVersion,
  type ComponentAliasLookup,
} from '@/domains/security-ops/components/componentIdentity';

const lookup: ComponentAliasLookup = (aliasText) => {
  const table: Record<string, { ecosystem: 'cpe' | 'wordpress_core' | 'wordpress_plugin'; componentKey: string }> = {
    nginx: { ecosystem: 'cpe', componentKey: 'cpe:f5:nginx' },
    php: { ecosystem: 'cpe', componentKey: 'cpe:php:php' },
    wordpress: { ecosystem: 'wordpress_core', componentKey: 'wordpress-core' },
    elementor: { ecosystem: 'wordpress_plugin', componentKey: 'pkg:wordpress-plugin/elementor' },
  };
  const hit = table[aliasText];
  return hit ? { ...hit, confidence: 1 } : undefined;
};

describe('normalizeAliasText', () => {
  it('collapses case, spacing and decoration', () => {
    expect(normalizeAliasText('  NGINX  ')).toBe('nginx');
    expect(normalizeAliasText('Apache HTTP Server')).toBe('apache http server');
    expect(normalizeAliasText('nginx (Ubuntu)')).toBe('nginx ubuntu');
  });
});

describe('normalizeVersion', () => {
  it('strips a v prefix', () => {
    expect(normalizeVersion('v2.7.6')).toBe('2.7.6');
  });

  it('keeps the upstream version and drops packager suffixes', () => {
    // Debian and Ubuntu append their own revision; the advisory speaks about
    // the upstream release, not the packaging.
    expect(normalizeVersion('1.18.0-0ubuntu1.4')).toBe('1.18.0');
    expect(normalizeVersion('2.4.52-1~deb11u2')).toBe('2.4.52');
    // A packaging revision and a semver prerelease both follow a hyphen, so the
    // distinction is by token, not by shape.
    expect(normalizeVersion('1.2.3-0ubuntu2')).toBe('1.2.3');
  });

  it('preserves CPE letter releases', () => {
    // OpenSSL 1.0.2k is a different release from 1.0.2, and compareVersions has
    // a CPE path built to order exactly this. Stripping the letter here made
    // that path unreachable and matched the wrong range.
    expect(normalizeVersion('1.0.2k')).toBe('1.0.2k');
  });

  it('preserves semver prereleases', () => {
    // 2.0.0-rc.1 sorts below 2.0.0; dropping the tag turned a prerelease into
    // the release it precedes.
    expect(normalizeVersion('2.0.0-rc.1')).toBe('2.0.0-rc.1');
  });

  it('returns null when nothing comparable survives', () => {
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion('   ')).toBeNull();
    expect(normalizeVersion('unknown')).toBeNull();
  });
});

describe('detectVersionScheme', () => {
  it('recognises semver and dotted versions', () => {
    expect(detectVersionScheme('1.2.3')).toBe('semver');
    expect(detectVersionScheme('1.2.3-beta.1')).toBe('semver');
    expect(detectVersionScheme('6.4')).toBe('dotted');
    // WordPress ships four-part versions that are not semver.
    expect(detectVersionScheme('6.4.2.1')).toBe('dotted');
  });

  it('refuses anything it cannot order', () => {
    expect(detectVersionScheme('latest')).toBe('unknown');
    expect(detectVersionScheme('')).toBe('unknown');
  });
});

describe('resolveComponentIdentity', () => {
  it('resolves a known product', () => {
    expect(resolveComponentIdentity({ product: 'Nginx', lookup })).toMatchObject({
      ecosystem: 'cpe',
      componentKey: 'cpe:f5:nginx',
      displayName: 'Nginx',
    });
  });

  it('returns null for an unknown product rather than guessing', () => {
    // Guessing a vendor is how you report another project's CVEs against
    // someone's server. Silence is the correct output (PRD R1).
    expect(resolveComponentIdentity({ product: 'SomeVendorAppServer', lookup })).toBeNull();
    expect(resolveComponentIdentity({ product: '   ', lookup })).toBeNull();
  });

  it('flags distro-packaged products as backport risks', () => {
    expect(resolveComponentIdentity({ product: 'nginx', lookup })?.backportRisk).toBe(true);
    expect(resolveComponentIdentity({ product: 'php', lookup })?.backportRisk).toBe(true);
    expect(resolveComponentIdentity({ product: 'elementor', lookup })?.backportRisk).toBe(false);
  });
});

describe('hasBackportRisk', () => {
  it('covers the products distributions routinely backport', () => {
    expect(hasBackportRisk('cpe:apache:http_server')).toBe(true);
    expect(hasBackportRisk('cpe:openssl:openssl')).toBe(true);
    expect(hasBackportRisk('pkg:wordpress-plugin/elementor')).toBe(false);
  });
});

describe('normalizeObservation', () => {
  it('normalizes identity and version together', () => {
    expect(normalizeObservation({ product: 'WordPress', version: '6.4.2', lookup })).toMatchObject({
      identity: { componentKey: 'wordpress-core' },
      versionRaw: '6.4.2',
      versionNormalized: '6.4.2',
      versionScheme: 'semver',
    });
  });

  it('keeps a recognised product whose version is unreadable', () => {
    // Still worth recording as inventory, but it cannot become an exposure
    // match until a concrete version is observed (PRD R2).
    const result = normalizeObservation({ product: 'nginx', version: 'unknown', lookup });
    expect(result?.identity.componentKey).toBe('cpe:f5:nginx');
    expect(result?.versionNormalized).toBeNull();
    expect(result?.versionScheme).toBe('unknown');
  });

  it('returns null when the product cannot be identified', () => {
    expect(normalizeObservation({ product: 'MysteryServer', version: '1.0.0', lookup })).toBeNull();
  });
});

describe('resolveComponentVersion', () => {
  const at = (iso: string) => new Date(iso);

  it('reports no version when nothing was observed with one', () => {
    expect(
      resolveComponentVersion([
        { versionNormalized: null, versionScheme: 'unknown', confidence: 0.9, observedAt: at('2026-01-01') },
      ]),
    ).toMatchObject({
      resolvedVersion: null,
      resolvedVersionObservedAt: null,
      versionConflict: false,
    });
  });

  it('prefers the highest-confidence observation', () => {
    expect(
      resolveComponentVersion([
        { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.4, observedAt: at('2026-01-02') },
        { versionNormalized: '1.2.0', versionScheme: 'semver', confidence: 0.9, observedAt: at('2026-01-01') },
      ]),
    ).toMatchObject({ resolvedVersion: '1.2.0', resolvedConfidence: 0.9 });
  });

  it('breaks confidence ties on recency', () => {
    expect(
      resolveComponentVersion([
        { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.8, observedAt: at('2026-01-01') },
        { versionNormalized: '1.1.0', versionScheme: 'semver', confidence: 0.8, observedAt: at('2026-02-01') },
      ]),
    ).toMatchObject({ resolvedVersion: '1.1.0' });
  });

  it('uses one newest cohort instead of a non-transitive pairwise ordering', () => {
    const result = resolveComponentVersion([
      {
        versionNormalized: '1.0.0',
        versionScheme: 'semver',
        confidence: 1,
        observedAt: at('2026-01-01T00:00:00Z'),
      },
      {
        versionNormalized: '1.1.0',
        versionScheme: 'semver',
        confidence: 0.4,
        observedAt: at('2026-01-02T00:00:00Z'),
      },
      {
        versionNormalized: '1.2.0',
        versionScheme: 'semver',
        confidence: 0.8,
        observedAt: at('2026-01-03T00:00:00Z'),
      },
    ]);

    expect(result.resolvedVersion).toBe('1.2.0');
    expect(result.resolvedVersionObservedAt).toEqual(at('2026-01-03T00:00:00Z'));
  });

  it('flags concurrent disagreement so the component cannot interrupt anyone', () => {
    const result = resolveComponentVersion([
      { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.9, observedAt: at('2026-01-01T00:00:00Z') },
      { versionNormalized: '2.0.0', versionScheme: 'semver', confidence: 0.5, observedAt: at('2026-01-01T01:00:00Z') },
    ]);
    expect(result.resolvedVersion).toBe('1.0.0');
    expect(result.versionConflict).toBe(true);
  });

  it('does not treat a routine upgrade as a conflict', () => {
    // Comparing against all history marked every upgrade as a permanent
    // conflict — and a conflicted component is barred from interrupt alerts,
    // so this silently disabled alerting for customers who patch.
    const result = resolveComponentVersion([
      { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.9, observedAt: at('2026-01-01') },
      { versionNormalized: '1.1.0', versionScheme: 'semver', confidence: 0.9, observedAt: at('2026-05-01') },
    ]);
    expect(result.resolvedVersion).toBe('1.1.0');
    expect(result.resolvedVersionObservedAt).toEqual(at('2026-05-01'));
    expect(result.versionConflict).toBe(false);
  });

  it('does not refresh exact-version evidence from a newer versionless sighting', () => {
    const exactVersionAt = at('2026-01-01T00:00:00Z');
    const result = resolveComponentVersion([
      {
        versionNormalized: '1.0.0',
        versionScheme: 'semver',
        confidence: 0.9,
        observedAt: exactVersionAt,
        source: 'connected_site',
      },
      {
        versionNormalized: null,
        versionScheme: 'unknown',
        confidence: 1,
        observedAt: at('2026-05-01T00:00:00Z'),
        source: 'httpx',
      },
    ]);

    expect(result).toMatchObject({
      resolvedVersion: '1.0.0',
      resolvedObservationSource: 'connected_site',
      resolvedVersionObservedAt: exactVersionAt,
    });
  });

  it('does not flag agreement reported by several sources', () => {
    expect(
      resolveComponentVersion([
        { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.9, observedAt: at('2026-01-01') },
        { versionNormalized: '1.0.0', versionScheme: 'semver', confidence: 0.6, observedAt: at('2026-01-02') },
      ]).versionConflict,
    ).toBe(false);
  });
});
