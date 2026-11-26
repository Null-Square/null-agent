import { describe, expect, it, vi } from 'vitest';

import { ExposureVerificationCompletion } from '@/domains/security-ops/exposure/ExposureVerificationCompletion';

/**
 * The evidence gate on a confirmed verdict.
 *
 * A `validated` finding is the strongest claim the product makes, and the whole
 * differentiator over a CVE list is that we only make it after testing. So the
 * gate that stands between a model's assertion and that claim deserves direct
 * tests rather than only being exercised incidentally.
 *
 * Note what this file deliberately does *not* test: whether the evidence is any
 * good. Paths are resolved against the run workspace before they reach here (see
 * `SecurityOpsToolService.submitExposureVerification`), so by this point every
 * entry either exists on disk or carries an excerpt. Judging whether a real
 * artifact demonstrates real exploitation is not something code can do, and
 * pretending otherwise would trade a checkable rule for a false one.
 */
const dbThatMustNotBeTouched = {
  transaction: vi.fn(() => {
    throw new Error('the transaction must not open when the verdict is refused');
  }),
} as never;

describe('ExposureVerificationCompletion', () => {
  it('refuses a confirmed verdict carrying no evidence', async () => {
    const completion = new ExposureVerificationCompletion(dbThatMustNotBeTouched);

    await expect(
      completion.complete({
        organizationId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
        outcome: 'confirmed',
        method: 'Claimed without proof',
        evidence: [],
      }),
    ).rejects.toThrow(/evidence/iu);
  });

  it('refuses a confirmed verdict when evidence is omitted entirely', async () => {
    // Distinct from the empty array: a model that never supplies the field must
    // not fall through to a default that authorises the claim.
    const completion = new ExposureVerificationCompletion(dbThatMustNotBeTouched);

    await expect(
      completion.complete({
        organizationId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
        outcome: 'confirmed',
        method: 'No evidence field at all',
      }),
    ).rejects.toThrow(/evidence/iu);
  });

  it('refuses before opening a transaction', async () => {
    // The gate runs ahead of any database work, so a refused confirmation cannot
    // partially apply — no state transition, no finding, no event.
    const transaction = vi.fn();
    const completion = new ExposureVerificationCompletion({ transaction } as never);

    await expect(
      completion.complete({
        organizationId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
        outcome: 'confirmed',
        method: 'Claimed without proof',
        evidence: [],
      }),
    ).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['not_reproduced', 'inconclusive'] as const)(
    'allows a %s verdict without evidence',
    async (outcome) => {
      // Only the affirmative claim needs proof. Requiring an artifact to say
      // "we could not reproduce this" would push runs toward inventing one, or
      // toward never closing at all.
      const transaction = vi.fn().mockResolvedValue({
        exposureMatchId: 'match-1',
        state: outcome,
        findingId: null,
      });
      const completion = new ExposureVerificationCompletion({ transaction } as never);

      await completion.complete({
        organizationId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
        outcome,
        method: 'Attempted the documented vector',
      });

      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );
});
