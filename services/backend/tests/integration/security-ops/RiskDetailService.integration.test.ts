import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { codeReviewFindings, findings, organizations, runs, scopes, users } from '@/db/schema';
import { RiskDetailService } from '@/domains/security-ops/risks/RiskDetailService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('RiskDetailService code occurrence view (integration)', () => {
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

  it('projects an unpublished occurrence into the shared detail shape without creating a Risk', async () => {
    const database = harness.db as any;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const scopeId = randomUUID();
    const commitSha = 'a'.repeat(40);

    await database.insert(users).values({
      id: userId,
      email: `occurrence-detail-${userId}@example.invalid`,
      password_hash: 'test',
    });
    await database.insert(organizations).values({
      id: organizationId,
      name: 'Occurrence detail integration',
      slug: `occurrence-detail-${organizationId}`,
    });
    await database.insert(scopes).values({
      id: scopeId,
      organizationId,
      name: 'Pull request scope',
      executionNetwork: 'external',
      status: 'active',
    });
    const [run] = await database
      .insert(runs)
      .values({
        organizationId,
        scopeId,
        userId,
        goal: 'Review pull request',
        trigger: 'manual',
        status: 'completed',
      })
      .returning({ id: runs.id });
    const [occurrence] = await database
      .insert(codeReviewFindings)
      .values({
        organizationId,
        scopeId,
        runId: run.id,
        repositoryId: 'github-repository-1',
        repositoryFullName: 'null-ai/platform',
        commitSha,
        firstSeenCommitSha: commitSha,
        lastSeenCommitSha: commitSha,
        fingerprint: 'candidate-fingerprint',
        state: 'candidate',
        severity: 'high',
        confidence: 0.8,
        category: 'authorization',
        title: 'Candidate authorization issue',
        summary: 'The handler may omit a tenant check.',
        impact: 'Another tenant record may be visible.',
        remediation: 'Enforce tenant ownership before the read.',
        locations: [{
          repositoryId: 'github-repository-1',
          repositoryFullName: 'null-ai/platform',
          commitSha,
          filePath: 'services/api/src/orders.ts',
          startLine: 40,
          endLine: 52,
          sourceExcerpt: 'return orders.get(orderId)',
          sourceExcerptSha256: 'b'.repeat(64),
        }],
        changeAttribution: 'introduced',
        attributionRationale: 'The pull request adds the unguarded read.',
        fixability: 'fixable',
        fixabilityRationale: 'The ownership predicate is local to this handler.',
      })
      .returning({ id: codeReviewFindings.id });

    const service = new RiskDetailService(database);
    const detail = await service.readCodeOccurrence({
      organizationId,
      occurrenceId: occurrence.id,
    });

    expect(detail).toMatchObject({
      detailKind: 'code_occurrence',
      id: occurrence.id,
      canonicalRiskId: null,
      sourceKind: 'code_review',
      state: 'potential',
      title: 'Candidate authorization issue',
      businessImpact: 'Another tenant record may be visible.',
      technicalAnalysis: 'authorization',
      scope: { id: scopeId, name: 'Pull request scope' },
      asset: null,
      repositoryId: 'github-repository-1',
      sourceDetailsRestricted: false,
      codeOccurrence: {
        id: occurrence.id,
        runId: run.id,
        commitSha,
        changeAttribution: 'introduced',
        fixability: 'fixable',
      },
    });
    expect(detail?.codeOccurrence?.locations).toHaveLength(1);

    await expect(service.readCodeOccurrence({
      organizationId: randomUUID(),
      occurrenceId: occurrence.id,
    })).resolves.toBeNull();

    const [risk] = await database
      .insert(findings)
      .values({
        organizationId,
        scopeId,
        repositoryId: 'github-repository-1',
        sourceKind: 'code_review',
        dedupeKey: 'code-review:v1:published',
        state: 'confirmed',
        title: 'Published authorization issue',
        severity: 'high',
        summary: 'The validated occurrence is now a canonical Risk.',
      })
      .returning({ id: findings.id });
    await database
      .update(codeReviewFindings)
      .set({
        riskId: risk.id,
        state: 'validated',
        validation: {
          outcome: 'validated',
          rationale: 'The tenant boundary can be bypassed.',
          validatedBySessionId: randomUUID(),
          validatedAt: new Date().toISOString(),
        },
      })
      .where(eq(codeReviewFindings.id, occurrence.id));

    await expect(service.readCodeOccurrence({
      organizationId,
      occurrenceId: occurrence.id,
    })).resolves.toMatchObject({
      detailKind: 'code_occurrence',
      id: occurrence.id,
      canonicalRiskId: risk.id,
      state: 'confirmed',
      codeOccurrence: {
        validation: { outcome: 'validated' },
      },
    });
  });
});
