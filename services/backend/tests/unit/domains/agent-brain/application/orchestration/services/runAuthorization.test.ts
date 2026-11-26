import { describe, expect, it } from 'vitest';

import {
  evaluatePinnedSourceReview,
  readAuthorizationModel,
  readPinnedSourceReviewEvidence,
} from '@/domains/agent-brain/application/orchestration/services/runAuthorization';

const PINNED = '0a772789f158f6bf8dfaf51d47ba35ac48314490';

describe('readAuthorizationModel', () => {
  it('defaults to target ownership when nothing is declared', () => {
    // A host cannot opt out of authorization by omission — this is the property
    // that keeps every existing consumer on the original gate.
    for (const flags of [undefined, null, {}, { scopeId: 'abc' }, 'nonsense', 42]) {
      expect(readAuthorizationModel(flags)).toBe('target_ownership');
    }
  });

  it('defaults to target ownership for an unrecognised model', () => {
    expect(readAuthorizationModel({ authorizationModel: 'pinned-source-review' }))
      .toBe('target_ownership');
    expect(readAuthorizationModel({ authorizationModel: 'none' }))
      .toBe('target_ownership');
    expect(readAuthorizationModel({ authorizationModel: true }))
      .toBe('target_ownership');
  });

  it('honours an explicit pinned source review declaration', () => {
    expect(readAuthorizationModel({ authorizationModel: 'pinned_source_review' }))
      .toBe('pinned_source_review');
  });
});

describe('evaluatePinnedSourceReview', () => {
  it('authorizes a public repository pinned to a full commit id', () => {
    expect(evaluatePinnedSourceReview({ visibility: 'public', commit: PINNED }))
      .toEqual({ authorized: true });
  });

  it('blocks when the host declared the model but carries no repository', () => {
    expect(evaluatePinnedSourceReview(undefined)).toMatchObject({
      authorized: false,
      reason: 'no_repository',
    });
  });

  it('treats unknown or absent visibility as unproven, not permitted', () => {
    for (const visibility of [undefined, 'unknown' as const]) {
      expect(evaluatePinnedSourceReview({ visibility, commit: PINNED })).toMatchObject({
        authorized: false,
        reason: 'visibility_unproven',
      });
    }
  });

  it('blocks non-public repositories', () => {
    for (const visibility of ['private', 'internal'] as const) {
      expect(evaluatePinnedSourceReview({ visibility, commit: PINNED })).toMatchObject({
        authorized: false,
        reason: 'not_public',
      });
    }
  });

  it('requires a full commit id so the review target cannot move', () => {
    // An abbreviated sha, a branch name, or an empty value all leave the working
    // copy free to change under the agent.
    for (const commit of [undefined, '', '   ', 'main', 'HEAD', '0a77278', 'zz772789f158f6bf8dfaf51d47ba35ac48314490']) {
      expect(evaluatePinnedSourceReview({ visibility: 'public', commit })).toMatchObject({
        authorized: false,
        reason: 'commit_not_pinned',
      });
    }
  });

  it('always explains the block to an operator', () => {
    const blocked = [
      undefined,
      { visibility: 'private' as const, commit: PINNED },
      { visibility: 'public' as const, commit: 'main' },
    ];
    for (const evidence of blocked) {
      const status = evaluatePinnedSourceReview(evidence);
      expect(status.authorized).toBe(false);
      expect(status.message?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('readPinnedSourceReviewEvidence', () => {
  it('reads visibility and commit off the securityops flags', () => {
    expect(readPinnedSourceReviewEvidence({
      repository: { visibility: 'public', commit: PINNED, url: 'https://example/x' },
    })).toEqual({ visibility: 'public', commit: PINNED });
  });

  it('returns undefined when there is no repository to evidence', () => {
    for (const flags of [undefined, {}, { repository: null }, { repository: 'x' }]) {
      expect(readPinnedSourceReviewEvidence(flags)).toBeUndefined();
    }
  });

  it('drops non-string fields rather than passing them through', () => {
    expect(readPinnedSourceReviewEvidence({
      repository: { visibility: 7, commit: { sha: PINNED } },
    })).toEqual({ visibility: undefined, commit: undefined });
  });

  it('composes with the evaluator to block a repository of unknown provenance', () => {
    const evidence = readPinnedSourceReviewEvidence({ repository: { url: 'https://example/x' } });
    expect(evaluatePinnedSourceReview(evidence)).toMatchObject({
      authorized: false,
      reason: 'visibility_unproven',
    });
  });
});
