import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  codeReviewFindings,
  findings,
  organizations,
  runs,
  scopes,
  users,
  type CodeReviewContext,
} from '@/db/schema';
import { CodeReviewRiskPublisher } from '@/domains/security-ops/code-review/CodeReviewRiskPublisher';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const reviewContext = (params: {
  repositoryId: string;
  commitSha: string;
  allowedPaths?: string[];
}): CodeReviewContext => ({
  operation: 'repository_review',
  repository: {
    provider: 'github',
    installationId: 'installation-1',
    repositoryId: params.repositoryId,
    fullName: 'null-ai/platform',
    visibility: 'private',
    immutableCommitSha: params.commitSha,
    requestedRef: 'main',
    defaultBranch: 'main',
  },
  reviewScope: {
    mode: params.allowedPaths?.length ? 'paths' : 'repository',
    allowedPaths: params.allowedPaths ?? [],
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
});

maybeDescribe('Code Review canonical Risk publication (integration)', () => {
  let harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

  beforeAll(async () => {
    const value = await setupTestDb();
    if (!value) throw new Error('TEST_DATABASE_URL is required');
    harness = value;
  });

  beforeEach(async () => {
    await harness.truncateAll();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('publishes one Risk and resolves it only after complete coverage of every known location', async () => {
    const database = harness.db as any;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const scopeId = randomUUID();
    const repositoryId = 'github-repository-1';

    await database.insert(users).values({
      id: userId,
      email: `code-risk-${userId}@example.invalid`,
      password_hash: 'test',
    });
    await database.insert(organizations).values({
      id: organizationId,
      name: 'Code Risk integration',
      slug: `code-risk-${organizationId}`,
    });
    await database.insert(scopes).values({
      id: scopeId,
      organizationId,
      name: 'Repository scope',
      executionNetwork: 'external',
      status: 'active',
    });

    const seedRun = async (commitSha: string): Promise<string> => {
      const [run] = await database
        .insert(runs)
        .values({
          organizationId,
          scopeId,
          userId,
          goal: `Review ${commitSha}`,
          trigger: 'manual',
          status: 'completed',
        })
        .returning({ id: runs.id });
      return run.id as string;
    };

    const firstCommit = 'a'.repeat(40);
    const firstRunId = await seedRun(firstCommit);
    const [occurrence] = await database
      .insert(codeReviewFindings)
      .values({
        organizationId,
        scopeId,
        runId: firstRunId,
        repositoryId,
        repositoryFullName: 'null-ai/platform',
        commitSha: firstCommit,
        firstSeenCommitSha: firstCommit,
        lastSeenCommitSha: firstCommit,
        fingerprint: 'risk-fingerprint-1',
        state: 'validated',
        severity: 'high',
        confidence: 0.95,
        category: 'authorization',
        title: 'Missing tenant authorization',
        summary: 'The order handler reads another tenant record.',
        impact: 'An authenticated user can read another tenant order.',
        remediation: 'Enforce tenant ownership before the read.',
        locations: [{
          repositoryId,
          repositoryFullName: 'null-ai/platform',
          commitSha: firstCommit,
          filePath: 'services/api/src/orders.ts',
          startLine: 40,
          endLine: 52,
          sourceExcerpt: 'return orders.get(orderId)',
          sourceExcerptSha256: 'c'.repeat(64),
        }],
      })
      .returning();

    const publisher = new CodeReviewRiskPublisher(database);
    await expect(publisher.publish({
      organizationId,
      scopeId,
      context: reviewContext({ repositoryId, commitSha: firstCommit }),
      reportCompleteness: 'complete',
      occurrences: [occurrence],
    })).resolves.toEqual({ published: 1, resolved: 0 });

    const [linkedOccurrence] = await database
      .select({ riskId: codeReviewFindings.riskId })
      .from(codeReviewFindings)
      .where(eq(codeReviewFindings.id, occurrence.id));
    expect(linkedOccurrence.riskId).toEqual(expect.any(String));

    const [risk] = await database
      .select()
      .from(findings)
      .where(eq(findings.id, linkedOccurrence.riskId));
    expect(risk).toMatchObject({
      sourceKind: 'code_review',
      state: 'confirmed',
      repositoryId,
      assetId: null,
    });

    const secondCommit = 'd'.repeat(40);
    const secondRunId = await seedRun(secondCommit);
    await database.insert(codeReviewFindings).values({
      organizationId,
      scopeId,
      runId: secondRunId,
      repositoryId,
      repositoryFullName: 'null-ai/platform',
      commitSha: secondCommit,
      firstSeenCommitSha: firstCommit,
      lastSeenCommitSha: secondCommit,
      riskId: risk.id,
      fingerprint: 'risk-fingerprint-1-moved',
      state: 'validated',
      severity: 'high',
      confidence: 0.95,
      category: 'authorization',
      title: 'Missing tenant authorization',
      summary: 'The same Risk also occurs in the web handler.',
      impact: 'An authenticated user can read another tenant order.',
      remediation: 'Enforce tenant ownership before the read.',
      locations: [{
        repositoryId,
        repositoryFullName: 'null-ai/platform',
        commitSha: secondCommit,
        filePath: 'apps/web/src/orders.ts',
        startLine: 20,
        endLine: 32,
        sourceExcerpt: 'loadOrder(orderId)',
        sourceExcerptSha256: 'e'.repeat(64),
      }],
    });

    await expect(publisher.publish({
      organizationId,
      scopeId,
      context: reviewContext({
        repositoryId,
        commitSha: 'f'.repeat(40),
        allowedPaths: ['services/api'],
      }),
      reportCompleteness: 'complete',
      occurrences: [],
    })).resolves.toEqual({ published: 0, resolved: 0 });

    const [afterPartialReview] = await database
      .select({ state: findings.state })
      .from(findings)
      .where(eq(findings.id, risk.id));
    expect(afterPartialReview.state).toBe('confirmed');

    await expect(publisher.publish({
      organizationId,
      scopeId,
      context: reviewContext({ repositoryId, commitSha: '1'.repeat(40) }),
      reportCompleteness: 'complete',
      occurrences: [],
    })).resolves.toEqual({ published: 0, resolved: 1 });

    const [afterFullReview] = await database
      .select({ state: findings.state })
      .from(findings)
      .where(eq(findings.id, risk.id));
    expect(afterFullReview.state).toBe('resolved');
  });
});
