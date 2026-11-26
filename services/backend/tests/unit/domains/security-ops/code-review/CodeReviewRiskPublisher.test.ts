import { describe, expect, it } from 'vitest';

import type { CodeReviewContext } from '@/db/schema';
import {
  codeLocationCovered,
  codeReviewCanPublishRisks,
} from '@/domains/security-ops/code-review/CodeReviewRiskPublisher';

const context = (overrides: Partial<CodeReviewContext> = {}): CodeReviewContext => ({
  operation: 'repository_review',
  repository: {
    provider: 'github',
    installationId: 'install-1',
    repositoryId: 'repo-1',
    fullName: 'null-ai/platform',
    visibility: 'private',
    immutableCommitSha: 'a'.repeat(40),
    requestedRef: 'main',
    defaultBranch: 'main',
  },
  reviewScope: {
    mode: 'repository',
    allowedPaths: [],
    excludedPaths: [],
    contextReadPolicy: 'immutable_manifest_only',
    manifestHash: 'b'.repeat(64),
    completeness: 'complete',
  },
  policySnapshot: {
    version: 'code-review/v1',
    toolProfile: 'code-review-read-only-v1',
    pathPolicy: 'immutable-manifest-bound',
    networkPolicy: 'github-read-only',
    publicationPolicy: 'none',
  },
  ...overrides,
});

describe('Code Review canonical Risk publication', () => {
  it('publishes only complete finalized default-branch repository reviews', () => {
    expect(codeReviewCanPublishRisks({ context: context(), reportCompleteness: 'complete' })).toBe(true);
    expect(codeReviewCanPublishRisks({ context: context(), reportCompleteness: 'partial' })).toBe(false);
    expect(codeReviewCanPublishRisks({
      context: context({
        repository: { ...context().repository, requestedRef: 'feature/refactor' },
      }),
      reportCompleteness: 'complete',
    })).toBe(false);
    expect(codeReviewCanPublishRisks({
      context: context({ operation: 'pull_request_review' }),
      reportCompleteness: 'complete',
    })).toBe(false);
  });

  it('resolves absence only inside the complete review path boundary', () => {
    const reviewScope: CodeReviewContext['reviewScope'] = {
      ...context().reviewScope,
      mode: 'paths',
      allowedPaths: ['services/api'],
      excludedPaths: ['services/api/generated'],
    };

    expect(codeLocationCovered('services/api/src/auth.ts', reviewScope)).toBe(true);
    expect(codeLocationCovered('services/api/generated/client.ts', reviewScope)).toBe(false);
    expect(codeLocationCovered('services/frontend/src/App.tsx', reviewScope)).toBe(false);
    expect(codeLocationCovered('Services/API/src/auth.ts', reviewScope)).toBe(false);
  });
});
