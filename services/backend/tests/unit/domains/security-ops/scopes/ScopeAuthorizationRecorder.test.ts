import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@/db/client';
import { ScopeAuthorizationRecorder } from '@/domains/security-ops/scopes/ScopeAuthorizationRecorder';
import type { ScopeContract } from '@/domains/security-ops/scopes/scopeAuthorization';

const existing: ScopeContract = {
  roots: [{ type: 'domain', value: 'example.com' }],
  exclusions: [{ type: 'domain', value: 'billing.example.com' }],
  impactTolerance: 'poc',
  executionNetwork: 'external',
};

/**
 * A recorder whose only real behaviour is the widening check.
 * `lastAuthorizedContract` is stubbed because the question under test is what
 * happens when it answers `null`.
 */
const recorderWith = (lastAuthorized: ScopeContract | null) => {
  const recorder = new ScopeAuthorizationRecorder({} as DatabaseClient);
  vi.spyOn(recorder, 'lastAuthorizedContract').mockResolvedValue(lastAuthorized);
  return recorder;
};

const assert = (
  recorder: ScopeAuthorizationRecorder,
  nextContract: ScopeContract,
  statementAccepted = false,
) =>
  recorder.assertStatementCoversChange({
    organizationId: 'org-1',
    scopeId: 'scope-1',
    nextContract,
    statementAccepted,
  });

describe('assertStatementCoversChange with no statement on file', () => {
  /**
   * The check protects a warranty the customer already gave. Where none exists
   * there is none to contradict, and refusing writes would break two real
   * flows: scopes that predate this feature, which would refuse even a rename;
   * and onboarding, where the website step creates the scope so it can issue a
   * verification record and the statement comes on the step after.
   */
  it('accepts any change, including one that widens the boundary', async () => {
    const wider: ScopeContract = {
      ...existing,
      roots: [...existing.roots, { type: 'domain', value: 'other.com' }],
      impactTolerance: 'full',
    };

    await expect(assert(recorderWith(null), existing)).resolves.toBeUndefined();
    await expect(assert(recorderWith(null), wider)).resolves.toBeUndefined();
  });
});

describe('assertStatementCoversChange with a statement on file', () => {
  it('refuses a widening that the statement does not cover', async () => {
    const wider: ScopeContract = {
      ...existing,
      roots: [...existing.roots, { type: 'domain', value: 'other.com' }],
    };

    await expect(assert(recorderWith(existing), wider)).rejects.toThrow(
      /widens what may be tested/i,
    );
  });

  it('refuses a raised impact limit', async () => {
    await expect(
      assert(recorderWith(existing), { ...existing, impactTolerance: 'full' }),
    ).rejects.toThrow(/widens what may be tested/i);
  });

  it('refuses a removed exclusion', async () => {
    await expect(assert(recorderWith(existing), { ...existing, exclusions: [] })).rejects.toThrow(
      /widens what may be tested/i,
    );
  });

  /* A statement over example.com already covers everything under it. */
  it('passes a subdomain of an authorized root', async () => {
    const withSubdomain: ScopeContract = {
      ...existing,
      roots: [...existing.roots, { type: 'domain', value: 'api.example.com' }],
    };

    await expect(assert(recorderWith(existing), withSubdomain)).resolves.toBeUndefined();
  });

  it('passes a narrowing edit', async () => {
    await expect(
      assert(recorderWith(existing), { ...existing, impactTolerance: 'non_destructive' }),
    ).resolves.toBeUndefined();
  });

  it('never asks when the customer accepted the statement', async () => {
    await expect(
      assert(recorderWith(existing), { ...existing, impactTolerance: 'full' }, true),
    ).resolves.toBeUndefined();
  });
});
