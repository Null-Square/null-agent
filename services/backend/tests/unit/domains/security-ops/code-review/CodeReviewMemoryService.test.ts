import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '@/db/client';
import type { CodeReviewContext } from '@/db/schema';
import {
  CodeReviewMemoryService,
  RecordCodeReviewMemoryInputSchema,
  evaluateCodeReviewMemoryCompatibility,
  selectCodeReviewMemoryIdsForPruning,
} from '@/domains/security-ops/code-review/CodeReviewMemoryService';
import {
  buildCodeReviewManifestHash,
  type CodeReviewManifestFile,
} from '@/domains/security-ops/runs/codeReviewRunContext';

const COMMIT = 'a'.repeat(40);
const OLD_BLOB = 'b'.repeat(40);
const NEW_BLOB = 'c'.repeat(40);
const NOW = new Date('2026-07-29T00:00:00.000Z');

const files: CodeReviewManifestFile[] = [
  { path: 'src/auth.ts', blobSha: NEW_BLOB, size: 100 },
  { path: 'src/billing.ts', blobSha: 'd'.repeat(40), size: 120 },
];

const manifestMap = new Map(files.map((file) => [file.path.toLowerCase(), file]));
const fullScope = new Set(files.map((file) => file.path.toLowerCase()));

const context = (overrides: Partial<CodeReviewContext> = {}): CodeReviewContext => {
  const base: CodeReviewContext = {
    operation: 'repository_review',
    repository: {
      provider: 'github',
      installationId: '123',
      repositoryId: '11111111-1111-4111-8111-111111111111',
      fullName: 'nullsquare/backend',
      visibility: 'private',
      immutableCommitSha: COMMIT,
      requestedRef: 'main',
      defaultBranch: 'main',
    },
    reviewScope: {
      mode: 'repository',
      allowedPaths: [],
      excludedPaths: [],
      contextReadPolicy: 'immutable_manifest_only',
      manifestHash: buildCodeReviewManifestHash({
        immutableCommitSha: COMMIT,
        files,
        allowedPaths: [],
        excludedPaths: [],
      }),
      completeness: 'complete',
    },
    policySnapshot: {
      version: 'code-review/v1',
      toolProfile: 'code-review-read-only-v1',
      pathPolicy: 'immutable-manifest-bound',
      networkPolicy: 'github-read-only',
      publicationPolicy: 'none',
    },
  };
  return {
    ...base,
    ...overrides,
    repository: { ...base.repository, ...(overrides.repository ?? {}) },
    reviewScope: { ...base.reviewScope, ...(overrides.reviewScope ?? {}) },
    policySnapshot: { ...base.policySnapshot, ...(overrides.policySnapshot ?? {}) },
  };
};

describe('CodeReviewMemoryService contracts', () => {
  it('labels unchanged, changed, missing, and path-excluded anchors without guessing', () => {
    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/auth.ts', blobSha: NEW_BLOB }],
      fullByPath: manifestMap,
      scopedPaths: fullScope,
      manifestCompleteness: 'complete',
      lastSeenAt: NOW,
      now: NOW,
    }).state).toBe('current');

    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/auth.ts', blobSha: OLD_BLOB }],
      fullByPath: manifestMap,
      scopedPaths: fullScope,
      manifestCompleteness: 'complete',
      lastSeenAt: NOW,
      now: NOW,
    })).toEqual(expect.objectContaining({
      state: 'needs_recheck',
      reason: expect.stringContaining('anchor_changed'),
    }));

    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/removed.ts', blobSha: OLD_BLOB }],
      fullByPath: manifestMap,
      scopedPaths: fullScope,
      manifestCompleteness: 'complete',
      lastSeenAt: NOW,
      now: NOW,
    }).state).toBe('superseded');

    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/billing.ts', blobSha: 'd'.repeat(40) }],
      fullByPath: manifestMap,
      scopedPaths: new Set(['src/auth.ts']),
      manifestCompleteness: 'complete',
      lastSeenAt: NOW,
      now: NOW,
    }).state).toBe('out_of_scope');
  });

  it('does not call an anchor superseded when the upstream manifest is partial', () => {
    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/not-returned.ts', blobSha: OLD_BLOB }],
      fullByPath: manifestMap,
      scopedPaths: fullScope,
      manifestCompleteness: 'partial',
      lastSeenAt: NOW,
      now: NOW,
    })).toEqual({
      state: 'needs_recheck',
      reason: 'partial_manifest_missing_anchor',
    });
  });

  it('marks memory outside retention as historical before injecting it', () => {
    expect(evaluateCodeReviewMemoryCompatibility({
      anchors: [{ path: 'src/auth.ts', blobSha: NEW_BLOB }],
      fullByPath: manifestMap,
      scopedPaths: fullScope,
      manifestCompleteness: 'complete',
      lastSeenAt: new Date('2024-01-01T00:00:00.000Z'),
      now: NOW,
    }).state).toBe('historical');
  });

  it('prunes expired records and enforces each memory type cap independently', () => {
    const recent = new Date('2026-07-28T00:00:00.000Z');
    const rows = [
      ...Array.from({ length: 151 }, (_, index) => ({
        id: `map-${index}`,
        ntype: 'review.map' as const,
        lastSeenAt: new Date(recent.getTime() - index),
      })),
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `digest-${index}`,
        ntype: 'run.digest' as const,
        lastSeenAt: new Date(recent.getTime() - index),
      })),
      {
        id: 'expired-disposition',
        ntype: 'review.disposition' as const,
        lastSeenAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ];

    expect(new Set(selectCodeReviewMemoryIdsForPruning({ rows, now: NOW }))).toEqual(new Set([
      'map-150',
      'digest-10',
      'expired-disposition',
    ]));
  });

  it('rejects unanchored dispositions and coverage with no structured coverage', () => {
    expect(RecordCodeReviewMemoryInputSchema.safeParse({
      type: 'review.disposition',
      statement: 'This candidate was rejected after tracing the current caller.',
      observationType: 'authorization',
      confidence: 0.9,
      anchorPaths: [],
    }).success).toBe(false);

    expect(RecordCodeReviewMemoryInputSchema.safeParse({
      type: 'review.coverage',
      statement: 'Authentication and authorization middleware were reviewed.',
      observationType: 'review_limitation',
      confidence: 0.8,
      anchorPaths: ['src/auth.ts'],
    }).success).toBe(false);
  });

  it('rejects manifest drift before any memory read or write', () => {
    const service = new CodeReviewMemoryService({} as DatabaseClient);
    expect(() => service.prepareManifest(
      context({
        reviewScope: {
          ...context().reviewScope,
          manifestHash: '0'.repeat(64),
        },
      }),
      files,
    )).toThrow(/manifest does not match/iu);
  });

  it('denies durable writes from pull requests and non-default branches before persistence', async () => {
    const service = new CodeReviewMemoryService({} as DatabaseClient);
    const input = {
      type: 'review.map',
      statement: 'All admin routes pass through the centralized authorization middleware.',
      observationType: 'authorization',
      confidence: 0.9,
      anchorPaths: ['src/auth.ts'],
    };
    const baseParams = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      scopeId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
      userId: '55555555-5555-4555-8555-555555555555',
      phaseKey: 'review_mapping',
      manifestFiles: files,
      input,
    };

    await expect(service.recordMemory({
      ...baseParams,
      context: context({ operation: 'pull_request_review' }),
    })).rejects.toThrow(/cannot write durable repository memory/iu);

    await expect(service.recordMemory({
      ...baseParams,
      context: context({
        repository: {
          ...context().repository,
          requestedRef: 'feature/untrusted',
        },
      }),
    })).rejects.toThrow(/default-branch review/iu);
  });

  it('retires only matching repository projections without deleting their memory subject', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    const where = vi.fn().mockResolvedValue([
      {
        id: 'asset-1',
        tags: ['code_review', 'github_repository:repo-1'],
      },
      {
        id: 'asset-2',
        tags: ['code_review', 'github_repository:repo-2'],
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = {
      select,
      update,
      delete: vi.fn(),
    };
    const service = new CodeReviewMemoryService(db as never, () => NOW);

    await expect(service.retireRepositoryAssetProjections({
      organizationId: '11111111-1111-4111-8111-111111111111',
      repositoryIds: ['repo-2'],
      reason: 'archived',
    })).resolves.toBe(1);

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['code_review', 'github_repository:repo-2', 'repository_archived'],
    }));
    expect(db.delete).not.toHaveBeenCalled();
  });
});
