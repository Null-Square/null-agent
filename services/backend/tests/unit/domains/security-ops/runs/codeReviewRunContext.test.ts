import { describe, expect, it } from 'vitest';

import type { CodeReviewContext } from '@/db/schema';
import {
  buildCodeReviewIdempotencyIdentity,
  validateCodeReviewContext,
  validateCodeReviewRepositoryRead,
  validateRunWorkflowIdentity,
} from '@/domains/security-ops/runs/codeReviewRunContext';
import { buildRunIdempotencyKey } from '@/domains/security-ops/runs/RunService';

const COMMIT_SHA = 'a'.repeat(40);
const OTHER_COMMIT_SHA = 'b'.repeat(40);
const MANIFEST_HASH = 'c'.repeat(64);

const repositoryReviewContext = (): CodeReviewContext => ({
  operation: 'repository_review',
  repository: {
    provider: 'github',
    installationId: 'installation-1',
    repositoryId: 'repository-1',
    fullName: 'acme/payments',
    visibility: 'private',
    immutableCommitSha: COMMIT_SHA,
    requestedRef: 'main',
    defaultBranch: 'main',
  },
  reviewScope: {
    mode: 'paths',
    allowedPaths: ['src', 'package.json'],
    excludedPaths: ['src/generated'],
    contextReadPolicy: 'exact-manifest-only',
    manifestHash: MANIFEST_HASH,
    completeness: 'complete',
  },
  policySnapshot: {
    version: 'code-review-v1',
    toolProfile: 'code-review-read-only-v1',
    pathPolicy: 'manifest-v1',
    networkPolicy: 'deny',
    publicationPolicy: 'none',
  },
});

describe('Code Review run context', () => {
  it('accepts a complete immutable repository review identity', () => {
    const context = repositoryReviewContext();

    expect(validateCodeReviewContext(context)).toEqual({ ok: true, issues: [] });
    expect(
      validateRunWorkflowIdentity({
        workflowDiscipline: 'code_review',
        codeReviewOperation: 'repository_review',
        codeReviewContext: context,
      }),
    ).toEqual({ ok: true, issues: [] });
  });

  it('rejects operation mismatch and cross-discipline identity leakage', () => {
    const context = repositoryReviewContext();

    expect(
      validateRunWorkflowIdentity({
        workflowDiscipline: 'code_review',
        codeReviewOperation: 'pull_request_review',
        codeReviewContext: context,
      }).issues,
    ).toEqual(expect.arrayContaining([
      expect.stringContaining('must match codeReviewOperation'),
    ]));

    expect(
      validateRunWorkflowIdentity({
        workflowDiscipline: 'pentest',
        codeReviewOperation: 'repository_review',
        codeReviewContext: context,
      }).issues,
    ).toContain('pentest cannot carry Code Review identity');
  });

  it('binds pull-request review to the exact immutable head SHA', () => {
    const context: CodeReviewContext = {
      ...repositoryReviewContext(),
      operation: 'pull_request_review',
      reviewScope: {
        ...repositoryReviewContext().reviewScope,
        mode: 'pull_request',
      },
      pullRequest: {
        number: 42,
        url: 'https://github.com/acme/payments/pull/42',
        baseRef: 'main',
        baseSha: OTHER_COMMIT_SHA,
        headRef: 'feature/authz',
        headSha: OTHER_COMMIT_SHA,
        diffManifestHash: 'd'.repeat(64),
      },
    };

    expect(validateCodeReviewContext(context).issues).toContain(
      'pull request head SHA must match the immutable repository commit SHA',
    );
  });

  it('allows only exact-revision reads inside allowed, non-excluded paths', () => {
    const context = repositoryReviewContext();

    expect(
      validateCodeReviewRepositoryRead({
        context,
        repository: 'acme/payments',
        ref: COMMIT_SHA,
        path: 'src/auth/authorize.ts',
      }),
    ).toEqual({ ok: true, issues: [] });

    expect(
      validateCodeReviewRepositoryRead({
        context,
        repository: 'acme/payments',
        ref: 'main',
        path: 'src/generated/client.ts',
      }).issues,
    ).toEqual(expect.arrayContaining([
      expect.stringContaining('immutable Code Review commit SHA'),
      expect.stringContaining('excluded'),
    ]));

    expect(
      validateCodeReviewRepositoryRead({
        context,
        repository: 'acme/other',
        ref: COMMIT_SHA,
        path: 'docs/architecture.md',
      }).issues,
    ).toEqual(expect.arrayContaining([
      expect.stringContaining('immutable Code Review repository'),
      expect.stringContaining('outside the Code Review allowed paths'),
    ]));
  });

  it('separates idempotency across workflow and immutable review identity', () => {
    const context = repositoryReviewContext();
    const common = {
      scopeId: 'scope-1',
      goal: 'Review payment authorization',
      now: new Date('2026-07-28T12:00:00.000Z'),
    };
    const pentestKey = buildRunIdempotencyKey({
      ...common,
      workflowDiscipline: 'pentest',
    });
    const codeReviewKey = buildRunIdempotencyKey({
      ...common,
      workflowDiscipline: 'code_review',
      workflowIdentity: buildCodeReviewIdempotencyIdentity(context),
    });
    const otherRevisionKey = buildRunIdempotencyKey({
      ...common,
      workflowDiscipline: 'code_review',
      workflowIdentity: buildCodeReviewIdempotencyIdentity({
        ...context,
        repository: {
          ...context.repository,
          immutableCommitSha: OTHER_COMMIT_SHA,
        },
      }),
    });

    expect(codeReviewKey).not.toBe(pentestKey);
    expect(otherRevisionKey).not.toBe(codeReviewKey);
  });
});
