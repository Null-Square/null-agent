import { describe, expect, it, vi } from 'vitest';
import {
  ScopeVerificationGate,
  evaluateScopeVerification,
  scopeVerificationMessage,
} from '@/domains/security-ops/scopes/scopeVerificationGate';
import { ERROR_CODES } from '@/shared/errors';

type Counts = { total: number; verified: number };

/**
 * Minimal stand-in for the drizzle chain used by `getCounts`:
 * `db.select(...).from(...).where(...)` resolving to one row.
 */
const createDb = (result: Counts | (() => Counts)) => {
  const calls = { select: 0 };
  const db = {
    select: () => {
      calls.select += 1;
      return {
        from: () => ({
          where: async () => [typeof result === 'function' ? result() : result],
        }),
      };
    },
  };
  return { db: db as never, calls };
};

const createFailingDb = () => ({
  select: () => ({
    from: () => ({
      where: async () => {
        throw new Error('connection reset');
      },
    }),
  }),
}) as never;

describe('evaluateScopeVerification', () => {
  it('blocks a scope with no targets', () => {
    expect(evaluateScopeVerification({ totalTargetsCount: 0, verifiedTargetsCount: 0 })).toEqual({
      verified: false,
      reason: 'no_target',
    });
  });

  it('blocks a scope whose targets are all unverified', () => {
    expect(evaluateScopeVerification({ totalTargetsCount: 3, verifiedTargetsCount: 0 })).toEqual({
      verified: false,
      reason: 'unverified',
    });
  });

  it('allows a scope with at least one verified target', () => {
    expect(evaluateScopeVerification({ totalTargetsCount: 3, verifiedTargetsCount: 1 })).toEqual({
      verified: true,
    });
  });
});

describe('scopeVerificationMessage', () => {
  it('words the same rule per surface', () => {
    expect(scopeVerificationMessage('unverified', 'run')).toMatch(/before starting a run/i);
    expect(scopeVerificationMessage('unverified', 'assistant')).toMatch(/before using the assistant/i);
    expect(scopeVerificationMessage('no_target', 'assistant')).toMatch(/add a target/i);
  });
});

describe('ScopeVerificationGate', () => {
  it('allows a scope with a verified target', async () => {
    const { db } = createDb({ total: 2, verified: 1 });
    const gate = new ScopeVerificationGate(db);

    await expect(gate.check('scope-1')).resolves.toEqual({ verified: true });
    await expect(gate.assert('scope-1', 'assistant')).resolves.toBeUndefined();
  });

  it('throws a typed 403 for an unverified scope', async () => {
    const { db } = createDb({ total: 1, verified: 0 });
    const gate = new ScopeVerificationGate(db);

    await expect(gate.assert('scope-1', 'assistant')).rejects.toMatchObject({
      code: ERROR_CODES.SCOPE_TARGET_UNVERIFIED,
      httpStatus: 403,
      message: scopeVerificationMessage('unverified', 'assistant'),
    });
  });

  it('fails closed when the lookup throws', async () => {
    const gate = new ScopeVerificationGate(createFailingDb());

    await expect(gate.check('scope-1')).resolves.toEqual({
      verified: false,
      reason: 'lookup_failed',
    });
    await expect(gate.assert('scope-1', 'run')).rejects.toMatchObject({
      code: ERROR_CODES.SCOPE_TARGET_UNVERIFIED,
    });
  });

  it('treats a blank scope id as blocked without querying', async () => {
    const { db, calls } = createDb({ total: 9, verified: 9 });
    const gate = new ScopeVerificationGate(db);

    await expect(gate.check('   ')).resolves.toEqual({ verified: false, reason: 'no_target' });
    expect(calls.select).toBe(0);
  });

  it('caches allowed results for the configured ttl', async () => {
    const { db, calls } = createDb({ total: 1, verified: 1 });
    const gate = new ScopeVerificationGate(db, 60_000);

    await gate.check('scope-1');
    await gate.check('scope-1');

    expect(calls.select).toBe(1);
  });

  it('never caches a block, so verifying unblocks on the next check', async () => {
    let verified = 0;
    const { db, calls } = createDb(() => ({ total: 1, verified }));
    const gate = new ScopeVerificationGate(db, 60_000);

    await expect(gate.check('scope-1')).resolves.toEqual({ verified: false, reason: 'unverified' });

    verified = 1;
    await expect(gate.check('scope-1')).resolves.toEqual({ verified: true });
    expect(calls.select).toBe(2);
  });

  it('re-reads the database after invalidation so target removal takes effect', async () => {
    let counts: Counts = { total: 1, verified: 1 };
    const { db } = createDb(() => counts);
    const gate = new ScopeVerificationGate(db, 60_000);

    await expect(gate.check('scope-1')).resolves.toEqual({ verified: true });

    counts = { total: 0, verified: 0 };
    // Still cached as allowed until the target mutation invalidates it.
    await expect(gate.check('scope-1')).resolves.toEqual({ verified: true });

    gate.invalidate('scope-1');
    await expect(gate.check('scope-1')).resolves.toEqual({ verified: false, reason: 'no_target' });
  });

  it('expires the allow cache once the ttl elapses', async () => {
    let counts: Counts = { total: 1, verified: 1 };
    const { db } = createDb(() => counts);
    const gate = new ScopeVerificationGate(db, 1_000);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');

    try {
      clock.mockReturnValue(now);
      await expect(gate.check('scope-1')).resolves.toEqual({ verified: true });

      counts = { total: 1, verified: 0 };
      clock.mockReturnValue(now + 1_001);
      await expect(gate.check('scope-1')).resolves.toEqual({ verified: false, reason: 'unverified' });
    } finally {
      clock.mockRestore();
    }
  });
});
