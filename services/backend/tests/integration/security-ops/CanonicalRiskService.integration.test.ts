import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findings, organizations, scopes } from '@/db/schema';
import { CanonicalRiskService } from '@/domains/security-ops/risks/CanonicalRiskService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('CanonicalRiskService (integration)', () => {
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

  it('accepts an explicit source link only inside the same organization, scope, and source family', async () => {
    const database = harness.db as any;
    const organizationId = randomUUID();
    const originalScopeId = randomUUID();
    const otherScopeId = randomUUID();
    const repositoryId = 'github-repository-1';

    await database.insert(organizations).values({
      id: organizationId,
      name: 'Canonical Risk integration',
      slug: `canonical-risk-${organizationId}`,
    });
    await database.insert(scopes).values([
      {
        id: originalScopeId,
        organizationId,
        name: 'Original scope',
        executionNetwork: 'external',
        status: 'active',
      },
      {
        id: otherScopeId,
        organizationId,
        name: 'Other scope',
        executionNetwork: 'external',
        status: 'active',
      },
    ]);
    const [risk] = await database
      .insert(findings)
      .values({
        organizationId,
        scopeId: originalScopeId,
        repositoryId,
        sourceKind: 'code_review',
        dedupeKey: 'code-review:v1:original',
        state: 'potential',
        title: 'Original title',
        severity: 'high',
        summary: 'Original summary',
      })
      .returning({ id: findings.id });

    const writer = new CanonicalRiskService(database);
    const update = (scopeId: string) => writer.upsert({
      existingRiskId: risk.id,
      organizationId,
      scopeId,
      repositoryId,
      sourceKind: 'code_review',
      sourceKey: 'code-review:v1:updated',
      state: 'confirmed',
      title: 'Updated title',
      severity: 'high',
      summary: 'Updated summary',
    });

    await expect(update(otherScopeId)).rejects.toThrow(
      'Explicit existing Risk does not belong to this organization, scope, and source',
    );
    const [unchanged] = await database
      .select({ scopeId: findings.scopeId, state: findings.state, title: findings.title })
      .from(findings)
      .where(eq(findings.id, risk.id));
    expect(unchanged).toEqual({
      scopeId: originalScopeId,
      state: 'potential',
      title: 'Original title',
    });

    await expect(update(originalScopeId)).resolves.toBe(risk.id);
    const [updated] = await database
      .select({ scopeId: findings.scopeId, state: findings.state, title: findings.title })
      .from(findings)
      .where(eq(findings.id, risk.id));
    expect(updated).toEqual({
      scopeId: originalScopeId,
      state: 'confirmed',
      title: 'Updated title',
    });
  });
});
