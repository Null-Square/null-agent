import { describe, expect, it } from 'vitest';

import { RecordControlCheckReviewSchema } from '@/domains/security-ops/compliance/ComplianceControlCheckReviewService';

describe('RecordControlCheckReviewSchema', () => {
  it('accepts explicit, reasoned review decisions', () => {
    expect(RecordControlCheckReviewSchema.parse({
      decision: 'confirmed',
      reasonCode: 'proof_valid',
      note: 'The replay and evidence satisfy the authored proof obligation.',
    })).toMatchObject({ decision: 'confirmed' });
    expect(RecordControlCheckReviewSchema.parse({
      decision: 'rejected',
      reasonCode: 'evidence_mismatch',
      note: 'The attached response does not match the endpoint named by the check.',
    })).toMatchObject({ decision: 'rejected' });
  });

  it('rejects vague notes and incompatible reason codes', () => {
    expect(RecordControlCheckReviewSchema.safeParse({
      decision: 'confirmed',
      reasonCode: 'evidence_mismatch',
      note: 'This is not a valid confirmation reason.',
    }).success).toBe(false);
    expect(RecordControlCheckReviewSchema.safeParse({
      decision: 'retest_required',
      reasonCode: 'proof_valid',
      note: 'Retest this control after the target changes.',
    }).success).toBe(false);
    expect(RecordControlCheckReviewSchema.safeParse({
      decision: 'rejected',
      reasonCode: 'other',
      note: 'short',
    }).success).toBe(false);
  });
});
