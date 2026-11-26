import { describe, expect, it } from 'vitest';
import {
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_AUTHORIZATION_STATEMENT_VERSION,
  buildAuthorizationEvidence,
  contractDigest,
  findWideningReasons,
  parseAuthorizationEvidence,
  requiresNewStatement,
  type ScopeContract,
} from '@/domains/security-ops/scopes/scopeAuthorization';

const base: ScopeContract = {
  roots: [{ type: 'domain', value: 'example.com' }],
  exclusions: [{ type: 'domain', value: 'billing.example.com' }],
  impactTolerance: 'poc',
  executionNetwork: 'external',
};

describe('scope authorization contract', () => {
  it('digests the target set, not the order a query returned it in', () => {
    const a = contractDigest({
      ...base,
      roots: [
        { type: 'domain', value: 'example.com' },
        { type: 'domain', value: 'api.example.com' },
      ],
    });
    const b = contractDigest({
      ...base,
      roots: [
        { type: 'domain', value: ' API.Example.com ' },
        { type: 'domain', value: 'Example.COM' },
      ],
    });

    expect(b).toBe(a);
  });

  it('excludes descriptive fields, so a rename is not a new authorization', () => {
    // Name and mission are not part of ScopeContract by construction; the
    // digest of the same boundary is stable no matter what the scope is called.
    expect(contractDigest(base)).toBe(contractDigest({ ...base }));
  });
});

describe('what needs a fresh statement', () => {
  it('asks when a scope has never carried one', () => {
    expect(requiresNewStatement(null, base)).toBe(true);
  });

  it.each([
    ['a new root', { roots: [...base.roots, { type: 'domain' as const, value: 'other.com' }] }],
    ['a widened root', { roots: [{ type: 'domain' as const, value: 'com' }] }],
    ['a removed exclusion', { exclusions: [] }],
    ['raised impact', { impactTolerance: 'full' as const }],
    ['a changed execution network', { executionNetwork: 'internal' }],
  ])('asks for %s', (_label, patch) => {
    expect(requiresNewStatement(base, { ...base, ...patch })).toBe(true);
  });

  /**
   * The rule that keeps the statement meaningful. If every save demands a fresh
   * warranty then people tick it without reading, and the one that matters —
   * raising impact to `full` — gets the same reflex as renaming a scope.
   */
  it.each([
    ['a removed root', { roots: [] }],
    ['an added exclusion', { exclusions: [...base.exclusions, { type: 'domain' as const, value: 'admin.example.com' }] }],
    ['lowered impact', { impactTolerance: 'non_destructive' as const }],
  ])('stays quiet for %s', (_label, patch) => {
    expect(requiresNewStatement(base, { ...base, ...patch })).toBe(false);
  });

  /* A statement over `example.com` already covers everything beneath it, so
     adding the subdomain later is not a widening. */
  it('treats a descendant of an authorized domain as already covered', () => {
    const next = { ...base, roots: [...base.roots, { type: 'domain' as const, value: 'api.example.com' }] };
    expect(requiresNewStatement(base, next)).toBe(false);
  });

  it('does not treat a lookalike suffix as covered', () => {
    const next = { ...base, roots: [{ type: 'domain' as const, value: 'notexample.com' }] };
    expect(findWideningReasons(base, next)).toContain('root_added');
  });

  it('names every reason, not just the first', () => {
    const reasons = findWideningReasons(base, {
      ...base,
      roots: [...base.roots, { type: 'domain', value: 'other.com' }],
      exclusions: [],
      impactTolerance: 'full',
    });
    expect(reasons).toEqual(
      expect.arrayContaining(['root_added', 'exclusion_removed', 'impact_raised']),
    );
  });
});

describe('evidence payload', () => {
  it('stores the words, not just the version', () => {
    const evidence = buildAuthorizationEvidence('scope_created', base);
    expect(evidence.statementText).toBe(SCOPE_AUTHORIZATION_STATEMENT);
    expect(evidence.statementVersion).toBe(SCOPE_AUTHORIZATION_STATEMENT_VERSION);
    expect(evidence.contractDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('round-trips through audit metadata', () => {
    const evidence = buildAuthorizationEvidence('target_added', base);
    const parsed = parseAuthorizationEvidence({ ...evidence });
    expect(parsed?.contractDigest).toBe(evidence.contractDigest);
    expect(parsed?.trigger).toBe('target_added');
  });

  it('returns null for metadata that carries no evidence', () => {
    expect(parseAuthorizationEvidence(null)).toBeNull();
    expect(parseAuthorizationEvidence({ ip: '127.0.0.1' })).toBeNull();
  });

  /**
   * The anti-regression assertion for this whole feature.
   *
   * A previous build made authorization a runtime gate and failed verified
   * Website Watch sites with `authorization_missing`. Nothing in this module may
   * express a status, an expiry or a revocation, because those are the fields a
   * run gate would read.
   */
  it('models no status, expiry or revocation', () => {
    const evidence = buildAuthorizationEvidence('scope_created', base) as Record<string, unknown>;
    for (const forbidden of ['status', 'state', 'current', 'expiresAt', 'revokedAt', 'stale']) {
      expect(evidence).not.toHaveProperty(forbidden);
    }
  });
});
