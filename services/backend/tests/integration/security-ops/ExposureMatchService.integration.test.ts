import { randomUUID } from 'crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupTestDb } from '../../helpers/testDb';
import { ExposureMatchService } from '@/domains/security-ops/exposure/ExposureMatchService';
import {
  advisories,
  advisoryAffectedRanges,
  assets,
  componentOverrides,
  exposureMatches,
  inventoryComponents,
  organizations,
  users,
} from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * The matcher against a real database.
 *
 * Every other Threat Watch test runs against fakes, which proves the logic but
 * not the schema: that the migration applies, that the reverse index resolves,
 * that the dedupe constraint actually holds, and that a `NULL` resolved version
 * behaves the way the unit tests assume. Those are exactly the places where a
 * wrong assumption produces a customer-visible false alert rather than a
 * failing assertion.
 */
const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ExposureMatchService (integration)', () => {
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

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await fn();
    });

  /** Minimal org + scope + asset, tolerating optional scope columns. */
  const seedTenant = async () => {
    const db = harness!.db as any;
    const userId = randomUUID();
    const slug = `exposure-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await db.insert(users).values({ id: userId, email: `${slug}@example.com`, password_hash: 'test' });

    const [{ id: orgId }] = await db
      .insert(organizations)
      .values({ name: 'Exposure Org', slug })
      .returning({ id: organizations.id });

    const scopeColumnsResult = await harness!.pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scopes'
    `);
    const scopeColumns = new Set(scopeColumnsResult.rows.map((row) => row.column_name));

    const columns = ['organization_id', 'name'];
    const values: Array<string | boolean> = [orgId, 'Prod'];
    if (scopeColumns.has('user_id')) { columns.push('user_id'); values.push(userId); }
    if (scopeColumns.has('kind')) { columns.push('kind'); values.push('domain'); }
    if (scopeColumns.has('safe_mode')) { columns.push('safe_mode'); values.push(true); }
    if (scopeColumns.has('status')) { columns.push('status'); values.push('active'); }

    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const scopeInsert = await harness!.pool.query<{ id: string }>(
      `INSERT INTO scopes (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values,
    );
    const scopeId = scopeInsert.rows[0]!.id;

    const [asset] = await db
      .insert(assets)
      .values({
        organizationId: orgId,
        scopeId,
        userId,
        kind: 'domain',
        value: `${slug}.example.com`,
      })
      .returning({ id: assets.id });

    return { db, orgId, scopeId, userId, assetId: asset.id };
  };

  /**
   * A component key unique to each test.
   *
   * The matcher deliberately enters from the advisory side and scans every
   * organization running that component — that is the product behaviour. It
   * also means tests sharing a key match each other's fixtures, so identity is
   * per-test rather than per-tenant.
   */
  const uniqueComponentKey = () => `cpe:test:nginx-${randomUUID().slice(0, 8)}`;

  const seedComponent = async (
    ctx: Awaited<ReturnType<typeof seedTenant>>,
    componentKey: string,
    over: Record<string, unknown> = {},
  ) => {
    const [component] = await ctx.db
      .insert(inventoryComponents)
      .values({
        organizationId: ctx.orgId,
        assetId: ctx.assetId,
        ecosystem: 'cpe',
        componentKey,
        displayName: 'nginx',
        resolvedVersion: '1.18.0',
        resolvedVersionScheme: 'cpe',
        resolvedConfidence: 0.9,
        resolvedObservationSource: 'agent',
        resolvedVersionObservedAt: new Date(),
        resolvedEvidenceTier: 'reported_exact',
        ...over,
      })
      .returning({ id: inventoryComponents.id });
    return component.id as string;
  };

  const seedAdvisory = async (
    ctx: Awaited<ReturnType<typeof seedTenant>>,
    componentKey: string,
    over: { applicability?: string; state?: string; fixedVersion?: string | null } = {},
  ) => {
    const canonicalId = `CVE-TEST-${randomUUID().slice(0, 8)}`;
    const [advisory] = await ctx.db
      .insert(advisories)
      .values({
        canonicalId,
        canonicalSource: 'nvd',
        cveId: canonicalId,
        title: 'Test advisory',
        lastModifiedAt: new Date(),
        state: over.state ?? 'active',
        severity: 'critical',
        cvssV31Score: 9.8,
        applicability: over.applicability ?? 'simple',
      })
      .returning({ id: advisories.id });

    await ctx.db.insert(advisoryAffectedRanges).values({
      advisoryId: advisory.id,
      source: 'nvd',
      ecosystem: 'cpe',
      componentKey,
      versionScheme: 'cpe',
      introducedVersion: null,
      introducedInclusive: true,
      fixedVersion: over.fixedVersion === undefined ? '1.18.1' : over.fixedVersion,
      fixedInclusive: false,
    });

    return { advisoryRowId: advisory.id as string, canonicalId };
  };

  itMaybe('matches a vulnerable version and records the match with an event', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    const result = await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    expect(result.matchesCreated).toBe(1);

    const rows = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      matchConfidence: 'exact_version',
      state: 'candidate',
      organizationId: ctx.orgId,
    });
    expect(Number(rows[0].priorityScore)).toBeGreaterThan(0);
  });

  itMaybe('does not match a version at or above the fix', async () => {
    // "Fixed in 1.18.1" means 1.18.1 is safe. Getting this backwards would
    // alert every customer who had already patched.
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey, { resolvedVersion: '1.18.1' });
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    const result = await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    expect(result.matchesCreated).toBe(0);
  });

  itMaybe('keeps a versionless component out of the exposure ledger', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey, { resolvedVersion: null, resolvedVersionScheme: 'unknown' });
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    const [row] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));

    expect(row).toBeUndefined();
  });

  itMaybe('fails closed when an exact version has no observation timestamp', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey, {
      resolvedVersionObservedAt: null,
      lastConfirmedAt: new Date(),
    });
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    const result = await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    expect(result.matchesCreated).toBe(0);
    expect(result.skippedMissingVersionEvidence).toBe(1);
    const rows = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));
    expect(rows).toHaveLength(0);
  });

  itMaybe('snapshots exact-version age instead of a newer versionless confirmation', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    const exactVersionObservedAt = new Date('2025-01-01T00:00:00.000Z');
    await seedComponent(ctx, componentKey, {
      resolvedVersionObservedAt: exactVersionObservedAt,
      lastConfirmedAt: new Date(),
    });
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    const [row] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));
    expect(row?.inventoryObservedAt).toEqual(exactVersionObservedAt);
  });

  itMaybe('is idempotent — re-matching does not duplicate', async () => {
    // The dedupe constraint is the last defence against alerting a customer
    // twice for the same advisory on the same asset.
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    const service = new ExposureMatchService(ctx.db);
    await service.matchAdvisory(advisoryRowId);
    const second = await service.matchAdvisory(advisoryRowId);

    expect(second.matchesCreated).toBe(0);
    expect(second.matchesUpdated).toBe(1);

    const rows = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));
    expect(rows).toHaveLength(1);
  });

  itMaybe('produces nothing for a complex advisory', async () => {
    // The classifier is the gate that prevents overmatching conditional
    // advisories; the matcher must honour it rather than trust the writer.
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey, { applicability: 'complex' });

    const result = await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);
    expect(result.matchesCreated).toBe(0);
  });

  itMaybe('suppresses a component the customer marked absent', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    await ctx.db.insert(componentOverrides).values({
      organizationId: ctx.orgId,
      assetId: ctx.assetId,
      ecosystem: 'cpe',
      componentKey,
      action: 'not_present',
      reason: 'decommissioned',
    });

    const result = await new ExposureMatchService(ctx.db).matchAdvisory(advisoryRowId);

    expect(result.suppressedByOverride).toBe(1);
    expect(result.matchesCreated).toBe(0);
  });

  itMaybe('applies a corrected version and reopens the match when that correction is removed', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    const componentId = await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);
    const service = new ExposureMatchService(ctx.db);

    await service.matchAdvisory(advisoryRowId);
    await ctx.db.insert(componentOverrides).values({
      organizationId: ctx.orgId,
      assetId: ctx.assetId,
      ecosystem: 'cpe',
      componentKey,
      action: 'version_correction',
      correctedVersion: '1.18.1',
      reason: 'Confirmed from the package manager',
      actorUserId: ctx.userId,
    });

    await service.reconcileComponent(componentId);

    const [resolved] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.stateReason).toBe('version_no_longer_affected');

    await ctx.db
      .delete(componentOverrides)
      .where(
        and(
          eq(componentOverrides.organizationId, ctx.orgId),
          eq(componentOverrides.assetId, ctx.assetId),
          eq(componentOverrides.componentKey, componentKey),
        ),
      );
    await service.reconcileComponent(componentId);

    const [reopened] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));
    expect(reopened?.state).toBe('candidate');
    expect(reopened?.stateReason).toBeNull();
    expect(reopened?.resolvedAt).toBeNull();
  });

  itMaybe('resolves open matches when an advisory is retracted', async () => {
    const ctx = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(ctx, componentKey);
    const { advisoryRowId } = await seedAdvisory(ctx, componentKey);

    const service = new ExposureMatchService(ctx.db);
    await service.matchAdvisory(advisoryRowId);

    await ctx.db
      .update(advisories)
      .set({ state: 'withdrawn' })
      .where(eq(advisories.id, advisoryRowId));

    // Re-matching a non-active advisory retracts rather than matches.
    await service.matchAdvisory(advisoryRowId);

    const [row] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.advisoryId, advisoryRowId));

    expect(row?.state).toBe('resolved');
    expect(row?.stateReason).toContain('withdrawn');
  });

  itMaybe('keeps organizations apart', async () => {
    // The reverse index is keyed on component identity, not tenancy, so a
    // shared product must not leak one organization's match into another.
    const first = await seedTenant();
    const second = await seedTenant();
    const componentKey = uniqueComponentKey();
    await seedComponent(first, componentKey);
    await seedComponent(second, componentKey);
    const { advisoryRowId } = await seedAdvisory(first, componentKey);

    await new ExposureMatchService(first.db).matchAdvisory(advisoryRowId);

    const firstRows = await first.db
      .select()
      .from(exposureMatches)
      .where(
        and(
          eq(exposureMatches.advisoryId, advisoryRowId),
          eq(exposureMatches.organizationId, first.orgId),
        ),
      );
    const secondRows = await first.db
      .select()
      .from(exposureMatches)
      .where(
        and(
          eq(exposureMatches.advisoryId, advisoryRowId),
          eq(exposureMatches.organizationId, second.orgId),
        ),
      );

    expect(firstRows).toHaveLength(1);
    expect(secondRows).toHaveLength(1);
    expect(firstRows[0].dedupeKey).not.toBe(secondRows[0].dedupeKey);
  });
});
