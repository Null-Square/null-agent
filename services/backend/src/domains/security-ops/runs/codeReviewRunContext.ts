import { createHash } from 'node:crypto';
import type {
  CodeReviewContext,
  CodeReviewOperation,
  RunWorkflowDiscipline,
} from '@/db/schema';

export type CodeReviewContextValidationResult = {
  ok: boolean;
  issues: string[];
};

export type RunWorkflowIdentityValidationResult = CodeReviewContextValidationResult;
export type CodeReviewRepositoryReadValidationResult = CodeReviewContextValidationResult;
export type CodeReviewManifestFile = {
  path: string;
  blobSha: string;
  size?: number | null;
};

const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/iu;
const SAFE_REPOSITORY_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/u;
const CODE_REVIEW_OPERATIONS = new Set<CodeReviewOperation>([
  'repository_review',
  'pull_request_review',
  'finding_fix',
]);
const WORKFLOW_DISCIPLINES = new Set<RunWorkflowDiscipline>([
  'pentest',
  'compliance',
  'code_review',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const validateRequiredString = (
  value: unknown,
  path: string,
  issues: string[],
): value is string => {
  if (!nonEmptyString(value)) {
    issues.push(`${path} is required`);
    return false;
  }
  return true;
};

const validateStringArray = (
  value: unknown,
  path: string,
  issues: string[],
): value is string[] => {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return false;
  }

  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const normalized = nonEmptyString(entry);
    if (!normalized) {
      issues.push(`${path}[${index}] must be a non-empty repository-relative path`);
      return;
    }
    if (!SAFE_REPOSITORY_PATH_PATTERN.test(normalized)) {
      issues.push(`${path}[${index}] must be repository-relative and cannot contain traversal`);
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      issues.push(`${path}[${index}] duplicates another path`);
    }
    seen.add(key);
  });

  return true;
};

const validateCommitSha = (value: unknown, path: string, issues: string[]): value is string => {
  if (!validateRequiredString(value, path, issues)) return false;
  if (!COMMIT_SHA_PATTERN.test(value)) {
    issues.push(`${path} must be a full immutable Git commit SHA`);
    return false;
  }
  return true;
};

const validateContentHash = (value: unknown, path: string, issues: string[]): value is string => {
  if (!validateRequiredString(value, path, issues)) return false;
  if (!CONTENT_HASH_PATTERN.test(value)) {
    issues.push(`${path} must be a SHA-256 hash`);
    return false;
  }
  return true;
};

export const isRunWorkflowDiscipline = (value: unknown): value is RunWorkflowDiscipline =>
  typeof value === 'string' && WORKFLOW_DISCIPLINES.has(value as RunWorkflowDiscipline);

export const isCodeReviewOperation = (value: unknown): value is CodeReviewOperation =>
  typeof value === 'string' && CODE_REVIEW_OPERATIONS.has(value as CodeReviewOperation);

export const validateCodeReviewContext = (
  value: unknown,
  expectedOperation?: CodeReviewOperation,
): CodeReviewContextValidationResult => {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: ['codeReviewContext must be an object'] };
  }

  const operation = value.operation;
  if (!isCodeReviewOperation(operation)) {
    issues.push('codeReviewContext.operation is invalid');
  } else if (expectedOperation && operation !== expectedOperation) {
    issues.push('codeReviewContext.operation must match codeReviewOperation');
  }

  const repository = value.repository;
  if (!isRecord(repository)) {
    issues.push('codeReviewContext.repository must be an object');
  } else {
    if (repository.provider !== 'github' && repository.provider !== 'local') {
      issues.push('codeReviewContext.repository.provider must be github or local');
    }
    validateRequiredString(repository.installationId, 'codeReviewContext.repository.installationId', issues);
    validateRequiredString(repository.repositoryId, 'codeReviewContext.repository.repositoryId', issues);
    validateRequiredString(repository.fullName, 'codeReviewContext.repository.fullName', issues);
    if (!['private', 'public', 'internal', 'unknown'].includes(String(repository.visibility))) {
      issues.push('codeReviewContext.repository.visibility is invalid');
    }
    validateCommitSha(
      repository.immutableCommitSha,
      'codeReviewContext.repository.immutableCommitSha',
      issues,
    );
    validateRequiredString(repository.defaultBranch, 'codeReviewContext.repository.defaultBranch', issues);
    if (repository.requestedRef !== undefined) {
      validateRequiredString(repository.requestedRef, 'codeReviewContext.repository.requestedRef', issues);
    }
  }

  const reviewScope = value.reviewScope;
  if (!isRecord(reviewScope)) {
    issues.push('codeReviewContext.reviewScope must be an object');
  } else {
    if (!['repository', 'paths', 'pull_request'].includes(String(reviewScope.mode))) {
      issues.push('codeReviewContext.reviewScope.mode is invalid');
    }
    validateStringArray(reviewScope.allowedPaths, 'codeReviewContext.reviewScope.allowedPaths', issues);
    validateStringArray(reviewScope.excludedPaths, 'codeReviewContext.reviewScope.excludedPaths', issues);
    validateRequiredString(
      reviewScope.contextReadPolicy,
      'codeReviewContext.reviewScope.contextReadPolicy',
      issues,
    );
    validateContentHash(reviewScope.manifestHash, 'codeReviewContext.reviewScope.manifestHash', issues);
    if (!['complete', 'partial', 'blocked'].includes(String(reviewScope.completeness))) {
      issues.push('codeReviewContext.reviewScope.completeness is invalid');
    }
    if (reviewScope.mode === 'paths' && Array.isArray(reviewScope.allowedPaths) && reviewScope.allowedPaths.length === 0) {
      issues.push('path-scoped Code Review requires at least one allowed path');
    }
  }

  const pullRequest = value.pullRequest;
  if (operation === 'pull_request_review') {
    if (!isRecord(pullRequest)) {
      issues.push('pull_request_review requires codeReviewContext.pullRequest');
    } else {
      if (!Number.isSafeInteger(pullRequest.number) || Number(pullRequest.number) <= 0) {
        issues.push('codeReviewContext.pullRequest.number must be a positive integer');
      }
      validateRequiredString(pullRequest.url, 'codeReviewContext.pullRequest.url', issues);
      validateRequiredString(pullRequest.baseRef, 'codeReviewContext.pullRequest.baseRef', issues);
      validateCommitSha(pullRequest.baseSha, 'codeReviewContext.pullRequest.baseSha', issues);
      validateRequiredString(pullRequest.headRef, 'codeReviewContext.pullRequest.headRef', issues);
      validateCommitSha(pullRequest.headSha, 'codeReviewContext.pullRequest.headSha', issues);
      validateContentHash(
        pullRequest.diffManifestHash,
        'codeReviewContext.pullRequest.diffManifestHash',
        issues,
      );
      if (pullRequest.deliveryId !== undefined) {
        validateRequiredString(pullRequest.deliveryId, 'codeReviewContext.pullRequest.deliveryId', issues);
      }
      if (
        isRecord(repository)
        && typeof repository.immutableCommitSha === 'string'
        && typeof pullRequest.headSha === 'string'
        && repository.immutableCommitSha.toLowerCase() !== pullRequest.headSha.toLowerCase()
      ) {
        issues.push('pull request head SHA must match the immutable repository commit SHA');
      }
    }
    if (isRecord(reviewScope) && reviewScope.mode !== 'pull_request') {
      issues.push('pull_request_review requires reviewScope.mode pull_request');
    }
  } else if (pullRequest !== undefined) {
    issues.push('codeReviewContext.pullRequest is only valid for pull_request_review');
  }

  const findingFix = value.findingFix;
  if (operation === 'finding_fix') {
    if (!isRecord(findingFix)) {
      issues.push('finding_fix requires codeReviewContext.findingFix');
    } else {
      validateRequiredString(findingFix.findingId, 'codeReviewContext.findingFix.findingId', issues);
      if (!Number.isSafeInteger(findingFix.findingVersion) || Number(findingFix.findingVersion) <= 0) {
        issues.push('codeReviewContext.findingFix.findingVersion must be a positive integer');
      }
      validateCommitSha(
        findingFix.vulnerableCommitSha,
        'codeReviewContext.findingFix.vulnerableCommitSha',
        issues,
      );
      validateRequiredString(
        findingFix.parentReviewRunId,
        'codeReviewContext.findingFix.parentReviewRunId',
        issues,
      );
      if (findingFix.approvedPatchHash !== undefined) {
        validateContentHash(
          findingFix.approvedPatchHash,
          'codeReviewContext.findingFix.approvedPatchHash',
          issues,
        );
      }
      if (
        isRecord(repository)
        && typeof repository.immutableCommitSha === 'string'
        && typeof findingFix.vulnerableCommitSha === 'string'
        && repository.immutableCommitSha.toLowerCase() !== findingFix.vulnerableCommitSha.toLowerCase()
      ) {
        issues.push('finding vulnerable commit SHA must match the immutable repository commit SHA');
      }
    }
    if (isRecord(reviewScope) && reviewScope.mode === 'pull_request') {
      issues.push('finding_fix cannot use pull_request review scope');
    }
  } else if (findingFix !== undefined) {
    issues.push('codeReviewContext.findingFix is only valid for finding_fix');
  }

  if (
    operation === 'repository_review'
    && isRecord(reviewScope)
    && !['repository', 'paths'].includes(String(reviewScope.mode))
  ) {
    issues.push('repository_review requires repository or paths review scope');
  }

  const policySnapshot = value.policySnapshot;
  if (!isRecord(policySnapshot)) {
    issues.push('codeReviewContext.policySnapshot must be an object');
  } else {
    validateRequiredString(policySnapshot.version, 'codeReviewContext.policySnapshot.version', issues);
    validateRequiredString(policySnapshot.toolProfile, 'codeReviewContext.policySnapshot.toolProfile', issues);
    validateRequiredString(policySnapshot.pathPolicy, 'codeReviewContext.policySnapshot.pathPolicy', issues);
    validateRequiredString(policySnapshot.networkPolicy, 'codeReviewContext.policySnapshot.networkPolicy', issues);
    validateRequiredString(
      policySnapshot.publicationPolicy,
      'codeReviewContext.policySnapshot.publicationPolicy',
      issues,
    );
  }

  return { ok: issues.length === 0, issues };
};

export const validateRunWorkflowIdentity = (params: {
  workflowDiscipline: unknown;
  complianceFrameworkKey?: unknown;
  codeReviewOperation?: unknown;
  codeReviewContext?: unknown;
}): RunWorkflowIdentityValidationResult => {
  const issues: string[] = [];
  if (!isRunWorkflowDiscipline(params.workflowDiscipline)) {
    return { ok: false, issues: ['workflowDiscipline is invalid'] };
  }

  if (params.workflowDiscipline === 'code_review') {
    if (!isCodeReviewOperation(params.codeReviewOperation)) {
      issues.push('code_review requires a valid codeReviewOperation');
    }
    if (params.complianceFrameworkKey != null) {
      issues.push('code_review cannot carry a compliance framework');
    }
    const contextResult = validateCodeReviewContext(
      params.codeReviewContext,
      isCodeReviewOperation(params.codeReviewOperation) ? params.codeReviewOperation : undefined,
    );
    issues.push(...contextResult.issues);
  } else {
    if (params.codeReviewOperation != null || params.codeReviewContext != null) {
      issues.push(`${params.workflowDiscipline} cannot carry Code Review identity`);
    }
    if (params.workflowDiscipline === 'pentest' && params.complianceFrameworkKey != null) {
      issues.push('pentest cannot carry a compliance framework');
    }
  }

  return { ok: issues.length === 0, issues };
};

export const buildCodeReviewIdempotencyIdentity = (context: CodeReviewContext): string => {
  const parts = [
    context.operation,
    context.repository.repositoryId.trim().toLowerCase(),
    context.repository.immutableCommitSha.trim().toLowerCase(),
    context.reviewScope.manifestHash.trim().toLowerCase(),
  ];

  if (context.pullRequest) {
    parts.push(
      `pr:${context.pullRequest.number}`,
      context.pullRequest.headSha.trim().toLowerCase(),
      context.pullRequest.diffManifestHash.trim().toLowerCase(),
    );
  }
  if (context.findingFix) {
    parts.push(
      `finding:${context.findingFix.findingId.trim().toLowerCase()}`,
      `version:${context.findingFix.findingVersion}`,
      context.findingFix.parentReviewRunId.trim().toLowerCase(),
    );
  }

  return parts.join(':');
};

const repositoryPathMatches = (candidate: string, policyPath: string): boolean =>
  candidate === policyPath || candidate.startsWith(`${policyPath}/`);

const normalizeRepositoryPath = (value: string): string =>
  value.trim().replace(/^\.\/+/u, '').replace(/\/+$/u, '');

export const filterCodeReviewManifestFiles = (params: {
  files: readonly CodeReviewManifestFile[];
  allowedPaths: readonly string[];
  excludedPaths: readonly string[];
}): CodeReviewManifestFile[] => {
  const allowedPaths = params.allowedPaths
    .map(normalizeRepositoryPath)
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  const excludedPaths = params.excludedPaths
    .map(normalizeRepositoryPath)
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());

  return params.files
    .map((file) => ({
      path: normalizeRepositoryPath(file.path),
      blobSha: file.blobSha.trim().toLowerCase(),
      size: file.size ?? null,
    }))
    .filter((file) => {
      if (!file.path || !SAFE_REPOSITORY_PATH_PATTERN.test(file.path) || !file.blobSha) {
        return false;
      }
      const normalizedPath = file.path.toLowerCase();
      if (excludedPaths.some((entry) => repositoryPathMatches(normalizedPath, entry))) {
        return false;
      }
      return allowedPaths.length === 0
        || allowedPaths.some((entry) => repositoryPathMatches(normalizedPath, entry));
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

export const buildCodeReviewManifestHash = (params: {
  immutableCommitSha: string;
  files: readonly CodeReviewManifestFile[];
  allowedPaths: readonly string[];
  excludedPaths: readonly string[];
}): string => {
  const files = filterCodeReviewManifestFiles(params);
  const canonical = [
    params.immutableCommitSha.trim().toLowerCase(),
    ...params.allowedPaths.map(normalizeRepositoryPath).filter(Boolean).sort(),
    '--excluded--',
    ...params.excludedPaths.map(normalizeRepositoryPath).filter(Boolean).sort(),
    '--files--',
    ...files.map((file) => `${file.path}:${file.blobSha}:${file.size ?? ''}`),
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
};

export const validateCodeReviewRepositoryRead = (params: {
  context: CodeReviewContext;
  repository: unknown;
  ref: unknown;
  path: unknown;
}): CodeReviewRepositoryReadValidationResult => {
  const issues: string[] = [];
  const repository = nonEmptyString(params.repository);
  const ref = nonEmptyString(params.ref);
  const path = nonEmptyString(params.path)?.replace(/^\.\/+/u, '') ?? null;
  const expectedRepositoryId = params.context.repository.repositoryId.trim().toLowerCase();
  const expectedFullName = params.context.repository.fullName.trim().toLowerCase();

  if (
    !repository
    || ![expectedRepositoryId, expectedFullName].includes(repository.toLowerCase())
  ) {
    issues.push('repository read is outside the immutable Code Review repository');
  }
  const allowedRefs = [
    params.context.repository.immutableCommitSha,
    ...(params.context.operation === 'pull_request_review' && params.context.pullRequest
      ? [params.context.pullRequest.baseSha]
      : []),
  ].map((entry) => entry.trim().toLowerCase());
  if (!ref || !allowedRefs.includes(ref.toLowerCase())) {
    issues.push(
      params.context.operation === 'pull_request_review'
        ? 'repository read ref must equal the immutable pull request head or base SHA'
        : 'repository read ref must equal the immutable Code Review commit SHA',
    );
  }
  if (!path || !SAFE_REPOSITORY_PATH_PATTERN.test(path)) {
    issues.push('repository read path must be a safe repository-relative path');
  } else {
    const normalizedPath = path.toLowerCase();
    const excluded = params.context.reviewScope.excludedPaths
      .map((entry) => entry.trim().replace(/^\.\/+/u, '').toLowerCase())
      .some((entry) => repositoryPathMatches(normalizedPath, entry));
    if (excluded) {
      issues.push('repository read path is excluded by the Code Review path policy');
    }

    const allowedPaths = params.context.reviewScope.allowedPaths
      .map((entry) => entry.trim().replace(/^\.\/+/u, '').toLowerCase())
      .filter(Boolean);
    if (
      allowedPaths.length > 0
      && !allowedPaths.some((entry) => repositoryPathMatches(normalizedPath, entry))
    ) {
      issues.push('repository read path is outside the Code Review allowed paths');
    }
  }

  return { ok: issues.length === 0, issues };
};
