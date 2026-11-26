import { describe, expect, it, vi } from 'vitest';

import {
  resolveCodeReviewRepositorySource,
} from '@/domains/agent-brain/adapters/tools/builtins/securityops/codeReviewSource';
import {
  registerHostedRunPersistencePort,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { createResearchLabRuntimeHostCapabilities } from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { InMemoryUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';

const codeReviewContext = {
  operation: 'repository_review',
  repository: {
    provider: 'github',
    installationId: 'installation-1',
    repositoryId: 'repository-1',
    fullName: 'nullsquare/example',
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
} as any;

describe('Code Review repository source routing', () => {
  it('keeps organization and Behavior Lab product-path runs on connected GitHub', () => {
    const source = resolveCodeReviewRepositorySource({} as any, {
      runId: 'organization-run',
      codeReview: codeReviewContext,
    });

    expect(source.kind).toBe('connected_github');
  });

  it('uses the local clone only for an explicitly registered Research Lab run', () => {
    const port = {
      kind: 'research_lab',
      runId: 'research-run',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: {
        claim: vi.fn(),
        markStarted: vi.fn(),
        block: vi.fn(),
        markOutcomeUnknown: vi.fn(),
      },
      modelRequestLifecycle: {
        append: vi.fn(),
        findByRequestId: vi.fn(),
        findBySession: vi.fn(),
      },
      providerAttemptLifecycle: new InMemoryUsageStore(),
      historyTransformationLifecycle: {
        prepare: vi.fn(),
        persistReplacement: vi.fn(),
        activate: vi.fn(),
        findById: vi.fn(),
        findActiveBySession: vi.fn(),
        findBySession: vi.fn(),
      },
      queryRepository: vi.fn(),
    } as any;
    const unregister = registerHostedRunPersistencePort(port);
    try {
      const source = resolveCodeReviewRepositorySource({} as any, {
        runId: 'research-run',
        runHost: 'research_lab',
        codeReview: codeReviewContext,
      });

      expect(source.kind).toBe('hosted_local_clone');
    } finally {
      unregister();
    }
  });

  it('fails closed when a Research Lab run loses its persistence owner', () => {
    expect(() => resolveCodeReviewRepositorySource({} as any, {
      runId: 'missing-research-run',
      runHost: 'research_lab',
      codeReview: codeReviewContext,
    })).toThrow('Hosted Code Review run has no registered persistence port');
  });
});
