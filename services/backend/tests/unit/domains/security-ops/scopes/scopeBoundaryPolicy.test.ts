import { describe, expect, it } from 'vitest';

import {
  decideScopeNamespace,
  decideScopeTargetRef,
  scopeRuleContains,
} from '@/domains/security-ops/scopes/scopeBoundaryPolicy';

describe('scopeBoundaryPolicy', () => {
  const roots = [
    { type: 'domain' as const, value: 'example.com' },
    { type: 'cidr' as const, value: '192.0.2.0/24' },
  ];

  it('authorizes an exact domain and arbitrary descendants downward only', () => {
    expect(decideScopeTargetRef({ targetRef: 'https://example.com/login', roots }).allowed).toBe(true);
    expect(decideScopeTargetRef({ targetRef: 'https://a.b.example.com/v1', roots }).allowed).toBe(true);
    expect(decideScopeTargetRef({ targetRef: 'https://notexample.com', roots }).allowed).toBe(false);
    expect(scopeRuleContains(
      { type: 'domain', value: 'app.example.com' },
      { type: 'domain', value: 'admin.example.com' },
    )).toBe(false);
  });

  it('makes explicit exclusions override an authorized root for the host and descendants', () => {
    const exclusions = [{ type: 'domain' as const, value: 'payments.example.com' }];
    expect(decideScopeTargetRef({ targetRef: 'https://payments.example.com', roots, exclusions })).toMatchObject({
      allowed: false,
      reason: 'excluded',
    });
    expect(decideScopeTargetRef({ targetRef: 'https://api.payments.example.com', roots, exclusions }).allowed).toBe(false);
    expect(decideScopeTargetRef({ targetRef: 'https://shop.example.com', roots, exclusions }).allowed).toBe(true);
  });

  it('requires direct IP activity to be covered by a CIDR instead of a domain fallback', () => {
    expect(decideScopeNamespace({ kind: 'ip', value: '192.0.2.40', roots }).allowed).toBe(true);
    expect(decideScopeNamespace({ kind: 'ip', value: '198.51.100.40', roots }).allowed).toBe(false);
    expect(decideScopeNamespace({
      kind: 'ip',
      value: '192.0.2.40',
      roots,
      exclusions: [{ type: 'cidr', value: '192.0.2.32/27' }],
    })).toMatchObject({ allowed: false, reason: 'excluded' });
  });

  it('recognizes widening and narrowing containment for domain and CIDR rules', () => {
    expect(scopeRuleContains(
      { type: 'domain', value: 'example.com' },
      { type: 'domain', value: 'api.example.com' },
    )).toBe(true);
    expect(scopeRuleContains(
      { type: 'cidr', value: '192.0.2.0/24' },
      { type: 'cidr', value: '192.0.2.64/26' },
    )).toBe(true);
    expect(scopeRuleContains(
      { type: 'cidr', value: '192.0.2.64/26' },
      { type: 'cidr', value: '192.0.2.0/24' },
    )).toBe(false);
  });
});
