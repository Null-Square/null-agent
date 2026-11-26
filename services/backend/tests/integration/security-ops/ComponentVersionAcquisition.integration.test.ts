import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assets, inventoryComponents, organizations, scopes, users } from '@/db/schema';
import { ComponentInventoryService } from '@/domains/security-ops/components/ComponentInventoryService';
import {
  ACTIVE_VERSION_READ_METHODS,
  createVersionAcquisitionLoader,
} from '@/domains/security-ops/components/componentVersionAcquisition';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('component version acquisition (integration)', () => {
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

  it('persists one attempt per method, advances to exhaustion, and closes the objective on a version', async () => {
    if (skip || !harness) return;

    const db = harness.db;
    const userId = randomUUID();
    const slug = `version-acquisition-${randomUUID()}`;
    await db.insert(users).values({
      id: userId,
      email: `${slug}@example.com`,
      password_hash: 'test',
    });
    const [{ id: organizationId }] = await db
      .insert(organizations)
      .values({ name: 'Version Acquisition Org', slug })
      .returning({ id: organizations.id });

    const [{ id: scopeId }] = await db
      .insert(scopes)
      .values({ organizationId, name: 'Production' })
      .returning({ id: scopes.id });
    const [{ id: assetId }] = await db
      .insert(assets)
      .values({
        organizationId,
        scopeId,
        userId,
        kind: 'domain',
        value: `${slug}.example.com`,
      })
      .returning({ id: assets.id });

    let minute = 0;
    const inventory = new ComponentInventoryService(
      db,
      () => new Date(Date.UTC(2026, 7, 30, 0, minute++)),
    );
    const loadObjectives = createVersionAcquisitionLoader(db);

    for (const method of ACTIVE_VERSION_READ_METHODS) {
      await inventory.recordObservation({
        organizationId,
        assetId,
        scopeId,
        observedByUserId: userId,
        source: 'agent',
        versionReadMethod: method,
        product: 'example-plugin',
        category: 'wordpress-plugin',
        version: null,
      });
    }

    const exhausted = await loadObjectives({ organizationId, assetIds: [assetId] });
    expect(exhausted.get(assetId)).toEqual([
      expect.objectContaining({
        status: 'exhausted',
        recommendedMethod: null,
        attemptedMethods: ACTIVE_VERSION_READ_METHODS,
        remainingMethods: [],
      }),
    ]);

    await inventory.recordObservation({
      organizationId,
      assetId,
      scopeId,
      observedByUserId: userId,
      source: 'agent',
      versionReadMethod: 'application_fingerprint',
      product: 'example-plugin',
      category: 'wordpress-plugin',
      version: '1.2.3',
    });

    const resolved = await loadObjectives({ organizationId, assetIds: [assetId] });
    expect(resolved.get(assetId)).toBeUndefined();

    const [exactVersion] = await db
      .select({
        resolvedVersion: inventoryComponents.resolvedVersion,
        resolvedVersionObservedAt: inventoryComponents.resolvedVersionObservedAt,
      })
      .from(inventoryComponents)
      .where(eq(inventoryComponents.assetId, assetId));
    expect(exactVersion?.resolvedVersion).toBe('1.2.3');
    expect(exactVersion?.resolvedVersionObservedAt).toBeInstanceOf(Date);

    await inventory.recordObservation({
      organizationId,
      assetId,
      scopeId,
      observedByUserId: userId,
      source: 'agent',
      versionReadMethod: 'application_fingerprint',
      product: 'example-plugin',
      category: 'wordpress-plugin',
      version: null,
    });

    const [afterVersionlessConfirmation] = await db
      .select({
        resolvedVersion: inventoryComponents.resolvedVersion,
        resolvedVersionObservedAt: inventoryComponents.resolvedVersionObservedAt,
      })
      .from(inventoryComponents)
      .where(eq(inventoryComponents.assetId, assetId));
    expect(afterVersionlessConfirmation).toEqual(exactVersion);

    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(users).where(eq(users.id, userId));
  });
});
