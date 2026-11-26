import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  advisories,
  assetScopeMemberships,
  assets,
  exposureMatches,
  findings,
  inventoryComponents,
  organizations,
  users,
} from '@/db/schema';
import {
  DrizzleRiskSourceReader,
  RiskReadModelService,
} from '@/domains/security-ops/risks/RiskReadModelService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('Risk read model (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) skip = true;
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('keeps exact de-duplication correct across a shared asset and two scopes', async () => {
    if (skip || !harness) return;
    const database = harness.db as any;
    const userId = randomUUID();
    const slug = `risk-read-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await database.insert(users).values({
      id: userId,
      email: `${slug}@example.com`,
      password_hash: 'x',
    });
    const [organization] = await database
      .insert(organizations)
      .values({ name: 'Risk Read Model Org', slug })
      .returning({ id: organizations.id });

    const scopeColumns = new Set(
      (
        await harness.pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='scopes'`,
        )
      ).rows.map((row) => row.column_name),
    );
    const createScope = async (name: string): Promise<string> => {
      const columns = ['organization_id', 'name'];
      const values: Array<string | boolean> = [organization.id, name];
      if (scopeColumns.has('user_id')) { columns.push('user_id'); values.push(userId); }
      if (scopeColumns.has('kind')) { columns.push('kind'); values.push('domain'); }
      if (scopeColumns.has('safe_mode')) { columns.push('safe_mode'); values.push(true); }
      if (scopeColumns.has('status')) { columns.push('status'); values.push('active'); }
      return (
        await harness!.pool.query<{ id: string }>(
          `INSERT INTO scopes (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
          values,
        )
      ).rows[0]!.id;
    };

    const scopeOne = await createScope('Scope One');
    const scopeTwo = await createScope('Scope Two');
    const [asset] = await database
      .insert(assets)
      .values({
        organizationId: organization.id,
        scopeId: scopeOne,
        userId,
        kind: 'domain',
        value: `${slug}.example.com`,
      })
      .returning({ id: assets.id });
    await database.insert(assetScopeMemberships).values({
      organizationId: organization.id,
      scopeId: scopeTwo,
      assetId: asset.id,
    });

    const [findingOne] = await database
      .insert(findings)
      .values({
        organizationId: organization.id,
        scopeId: scopeOne,
        userId,
        assetId: asset.id,
        title: 'Scope one finding',
        severity: 'high',
        summary: 'Scope one summary',
        dedupeKey: `scope-one-${randomUUID()}`,
      })
      .returning({ id: findings.id });
    const [findingTwo] = await database
      .insert(findings)
      .values({
        organizationId: organization.id,
        scopeId: scopeTwo,
        userId,
        assetId: asset.id,
        title: 'Scope two finding',
        severity: 'medium',
        summary: 'Scope two summary',
        dedupeKey: `scope-two-${randomUUID()}`,
      })
      .returning({ id: findings.id });

    const createExposure = async (params: {
      canonicalId: string;
      riskId: string;
      componentName: string;
    }): Promise<string> => {
      const componentKey = `cpe:test:${params.componentName}-${randomUUID().slice(0, 8)}`;
      const [component] = await database
        .insert(inventoryComponents)
        .values({
          organizationId: organization.id,
          assetId: asset.id,
          ecosystem: 'cpe',
          componentKey,
          displayName: params.componentName,
          resolvedVersion: '1.0.0',
          resolvedVersionScheme: 'cpe',
        })
        .returning({ id: inventoryComponents.id });
      const [advisory] = await database
        .insert(advisories)
        .values({
          canonicalId: params.canonicalId,
          canonicalSource: 'nvd',
          cveId: params.canonicalId,
          title: `${params.componentName} advisory`,
          lastModifiedAt: new Date(),
          state: 'active',
          severity: 'high',
          cvssV31Score: 8.1,
          applicability: 'simple',
        })
        .returning({ id: advisories.id });
      const [match] = await database
        .insert(exposureMatches)
        .values({
          organizationId: organization.id,
          assetId: asset.id,
          componentId: component.id,
          advisoryId: advisory.id,
          riskId: params.riskId,
          matchConfidence: 'exact_version',
          priorityScore: 80,
          state: 'confirmed',
          inventoryObservedAt: new Date(),
          dedupeKey: `${organization.id}|${asset.id}|${componentKey}|${params.canonicalId}`,
        })
        .returning({ id: exposureMatches.id });
      return match.id as string;
    };

    const sameScopeExposureId = await createExposure({
      canonicalId: `CVE-TEST-${randomUUID().slice(0, 8)}`,
      riskId: findingOne.id,
      componentName: 'same-scope',
    });
    const otherScopeExposureId = await createExposure({
      canonicalId: `CVE-TEST-${randomUUID().slice(0, 8)}`,
      riskId: findingTwo.id,
      componentName: 'other-scope',
    });

    const service = new RiskReadModelService(new DrizzleRiskSourceReader(database));
    const result = await service.read({
      organizationId: organization.id,
      scopeId: scopeOne,
      includeExposures: true,
    });
    const { risks, summary } = result;

    expect(risks.some((risk) => risk.id === findingOne.id && risk.recordKind === 'finding')).toBe(true);
    expect(risks.some((risk) => risk.id === sameScopeExposureId)).toBe(false);
    expect(risks.some((risk) => risk.id === otherScopeExposureId && risk.recordKind === 'exposure')).toBe(true);
    expect(risks.some((risk) => risk.id === findingTwo.id)).toBe(false);
    expect(summary).toMatchObject({
      total: 2,
      open: 2,
      openKev: 0,
      byState: { potential: 1, confirmed: 1 },
      openBySeverity: { high: 2 },
    });
  });
});
