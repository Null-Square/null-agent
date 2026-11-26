import type { CodeReviewContext } from '@/db/schema';
import type { AgentRunHostContext } from '@/app/public/agentRunHost';
import {
  buildCodeReviewManifestHash,
  validateCodeReviewContext,
} from './codeReviewRunContext';
import type {
  HostedRepositoryManifest,
  HostedRunPersistencePort,
} from './HostedRunPersistencePort';

/**
 * Hosted Code Review identity.
 *
 * The organization product derives its immutable context from a GitHub
 * installation and the tree API. A hosted Research Lab run derives the same
 * shape from a pinned local clone. Both produce Git blob object ids, so a
 * memory anchor written by one is byte-comparable by the other.
 *
 * The sentinel installation id records that no GitHub credential participates
 * in a hosted run. Publication policy is `none` for the same reason.
 */
export const HOSTED_CODE_REVIEW_INSTALLATION_ID = 'research-lab-local-clone';
export const HOSTED_CODE_REVIEW_POLICY_VERSION = 'code-review-hosted/v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Derive `owner/name` from a repository URL when the host did not supply it.
 * Hosted projects are created from a validated repository URL, so the pathname
 * is the provider-canonical full name.
 */
export const deriveRepositoryFullName = (repositoryUrl: string): string => {
  try {
    const { pathname } = new URL(repositoryUrl);
    return pathname
      .replace(/^\/+/u, '')
      .replace(/\.git$/iu, '')
      .replace(/\/+$/u, '');
  } catch {
    return repositoryUrl.replace(/^https?:\/\/[^/]+\//iu, '').replace(/\.git$/iu, '');
  }
};

export const parseHostedRepositoryManifest = (
  value: unknown,
): HostedRepositoryManifest => {
  if (!isRecord(value)) {
    throw new Error('Hosted repository manifest response is not an object');
  }
  const repositoryId = asString(value.repositoryId);
  const repository = asString(value.repository);
  const ref = asString(value.ref);
  if (!repositoryId || !repository || !ref) {
    throw new Error('Hosted repository manifest is missing repository identity');
  }
  const rawFiles = Array.isArray(value.files) ? value.files : [];
  const files = rawFiles.flatMap((entry): HostedRepositoryManifest['files'] => {
    if (!isRecord(entry)) return [];
    const path = asString(entry.path);
    const blobSha = asString(entry.blobSha);
    if (!path || !blobSha) return [];
    return [{
      path,
      blobSha: blobSha.toLowerCase(),
      size: typeof entry.size === 'number' ? entry.size : null,
    }];
  });
  return {
    repositoryId,
    repository,
    ref,
    files,
    completeness: value.completeness === 'partial' ? 'partial' : 'complete',
  };
};

export const fetchHostedRepositoryManifest = async (
  persistence: HostedRunPersistencePort,
): Promise<HostedRepositoryManifest> =>
  parseHostedRepositoryManifest(
    await persistence.queryRepository({ operation: 'manifest', input: {} }),
  );

/**
 * Build the typed immutable Code Review context for a hosted run.
 *
 * Every field the organization product enforces is enforced here too: the
 * commit is immutable, the manifest hash is derived from the exact file set
 * the tools will serve, and the run carries no publication authority.
 */
export const buildHostedCodeReviewContext = (params: {
  repository: NonNullable<AgentRunHostContext['repository']>;
  manifest: HostedRepositoryManifest;
}): CodeReviewContext => {
  const fullName = params.repository.fullName?.trim()
    || deriveRepositoryFullName(params.repository.url);
  if (!fullName) {
    throw new Error('Hosted Code Review requires a resolvable repository full name');
  }
  const defaultBranch = params.repository.defaultBranch?.trim() || params.repository.ref.trim();
  if (!defaultBranch) {
    throw new Error('Hosted Code Review requires a resolvable default branch');
  }
  if (params.manifest.ref.toLowerCase() !== params.repository.commit.trim().toLowerCase()) {
    throw new Error(
      'Hosted repository manifest does not match the pinned immutable commit',
    );
  }
  if (params.manifest.files.length === 0) {
    throw new Error('Hosted repository manifest contains no reviewable files');
  }

  const manifestHash = buildCodeReviewManifestHash({
    immutableCommitSha: params.repository.commit,
    files: params.manifest.files,
    allowedPaths: [],
    excludedPaths: [],
  });

  const context: CodeReviewContext = {
    operation: 'repository_review',
    repository: {
      provider: 'github',
      installationId: HOSTED_CODE_REVIEW_INSTALLATION_ID,
      repositoryId: params.manifest.repositoryId,
      fullName,
      visibility: params.repository.visibility ?? 'public',
      immutableCommitSha: params.repository.commit.trim().toLowerCase(),
      requestedRef: params.repository.ref,
      defaultBranch,
    },
    reviewScope: {
      mode: 'repository',
      allowedPaths: [],
      excludedPaths: [],
      contextReadPolicy: 'immutable_manifest_only',
      manifestHash,
      completeness: params.manifest.completeness,
    },
    policySnapshot: {
      version: HOSTED_CODE_REVIEW_POLICY_VERSION,
      toolProfile: 'code-review-read-only-v1',
      pathPolicy: 'immutable-manifest-bound',
      networkPolicy: 'local-clone-no-network',
      publicationPolicy: 'none',
    },
  };

  const validation = validateCodeReviewContext(context, 'repository_review');
  if (!validation.ok) {
    throw new Error(
      `Hosted Code Review context is invalid: ${validation.issues.join('; ')}`,
    );
  }
  return context;
};

/**
 * A hosted review writes durable memory only when the pinned ref is the
 * project default branch, matching the organization rule that pull-request and
 * non-default-branch reviews are read-only for memory.
 */
export const hostedReviewWritesDurableMemory = (context: CodeReviewContext): boolean =>
  context.operation === 'repository_review'
  && context.repository.requestedRef?.trim().toLowerCase()
    === context.repository.defaultBranch.trim().toLowerCase();
