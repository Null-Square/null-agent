/**
 * Run authorization models.
 *
 * Before any metered turn, a session must satisfy the authorization model its
 * host declared. Two models exist, and they ask different questions:
 *
 *   target_ownership      "have you proven you own this target?"
 *                         Resolved against scope_targets via ScopeVerificationPort.
 *                         Correct whenever an agent acts on a live third-party
 *                         host. Unchanged by this module.
 *
 *   pinned_source_review  "is this a read-only review of public source at a
 *                         fixed commit?" Evaluated here, from evidence the host
 *                         already puts on the session. No database access.
 *
 * The second model exists because target ownership is unanswerable for source
 * review: nobody owns a third-party public repository, so the only way to
 * satisfy an ownership check is to write a verification that is not true.
 * Asking a different, appropriate question is not a bypass — a host that
 * declares `pinned_source_review` and cannot evidence it is still blocked.
 *
 * Both models fail closed. Absence of evidence is never permission.
 */

export type RunAuthorizationModel = 'target_ownership' | 'pinned_source_review';

export type PinnedSourceReviewBlockReason =
  /** The host declared the model but supplied no repository at all. */
  | 'no_repository'
  /** Visibility is absent or unknown — we cannot show the source is public. */
  | 'visibility_unproven'
  /** Visibility is known and is not public. */
  | 'not_public'
  /** No commit, or not a full object id — the review target could move. */
  | 'commit_not_pinned';

export interface RunAuthorizationStatus {
  authorized: boolean;
  reason?: PinnedSourceReviewBlockReason;
  message?: string;
}

export const PINNED_SOURCE_REVIEW_MESSAGES: Record<PinnedSourceReviewBlockReason, string> = {
  no_repository:
    'This run declares source-review authorization but carries no repository.',
  visibility_unproven:
    'Repository visibility is unknown, so public source review cannot be authorized.',
  not_public:
    'Source-review authorization covers public repositories only.',
  commit_not_pinned:
    'Source review requires a repository pinned to a full commit id.',
};

/** Evidence a host must already hold to claim `pinned_source_review`. */
export interface PinnedSourceReviewEvidence {
  visibility?: 'private' | 'public' | 'internal' | 'unknown';
  commit?: string;
}

/** A full object id — the abbreviated form would let the target move. */
const FULL_COMMIT_ID = /^[a-f0-9]{40,64}$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Pure rule for `pinned_source_review`.
 *
 * Two conditions are checked here because they are the two a session can prove
 * from what it carries: the source is public, and the working copy cannot move
 * under the agent. The remaining conditions of this model — repository code is
 * never executed, and no external writes are permitted — are enforced earlier
 * and elsewhere: by the host's tool policy, and at build time by the research
 * boundary check that fails the build on `git push`, `pulls.create`,
 * `createFork`, and `createSecurityAdvisory`.
 */
export const evaluatePinnedSourceReview = (
  evidence: PinnedSourceReviewEvidence | undefined,
): RunAuthorizationStatus => {
  if (!evidence) {
    return block('no_repository');
  }

  // Unknown is not a pass. A host that cannot say whether its source is public
  // has not shown that it is.
  if (!evidence.visibility || evidence.visibility === 'unknown') {
    return block('visibility_unproven');
  }
  if (evidence.visibility !== 'public') {
    return block('not_public');
  }

  const commit = typeof evidence.commit === 'string' ? evidence.commit.trim() : '';
  if (!FULL_COMMIT_ID.test(commit)) {
    return block('commit_not_pinned');
  }

  return { authorized: true };
};

const block = (reason: PinnedSourceReviewBlockReason): RunAuthorizationStatus => ({
  authorized: false,
  reason,
  message: PINNED_SOURCE_REVIEW_MESSAGES[reason],
});

/**
 * Read the declared model off a session's securityops flags.
 *
 * Anything absent or unrecognised resolves to `target_ownership`, so a typo or
 * an older session cannot silently land on the weaker-looking path.
 */
export const readAuthorizationModel = (
  securityops: unknown,
): RunAuthorizationModel =>
  isRecord(securityops) && securityops.authorizationModel === 'pinned_source_review'
    ? 'pinned_source_review'
    : 'target_ownership';

/** Read the repository evidence a `pinned_source_review` session carries. */
export const readPinnedSourceReviewEvidence = (
  securityops: unknown,
): PinnedSourceReviewEvidence | undefined => {
  if (!isRecord(securityops) || !isRecord(securityops.repository)) return undefined;
  const repository = securityops.repository;
  return {
    visibility: typeof repository.visibility === 'string'
      ? repository.visibility as PinnedSourceReviewEvidence['visibility']
      : undefined,
    commit: typeof repository.commit === 'string' ? repository.commit : undefined,
  };
};
