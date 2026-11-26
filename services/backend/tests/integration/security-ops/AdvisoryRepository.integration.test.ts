import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { advisories } from '@/db/schema';
import { AdvisoryRepository } from '@/domains/security-ops/advisories/AdvisoryRepository';

import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('AdvisoryRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;

  beforeAll(async () => {
    harness = await setupTestDb();
    if (!harness) throw new Error('TEST_DATABASE_URL is set but the test database was not created');
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('replaces a KEV snapshot as one safe set, including removals and null CVE rows', async () => {
    if (!harness) throw new Error('test database is unavailable');

    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const incomingId = `CVE-2099-${suffix}1`;
    const retainedId = `CVE-2099-${suffix}2`;
    const removedId = `CVE-2099-${suffix}3`;
    const canonicalIds = [incomingId, retainedId, removedId, `SOURCE-${suffix}`];
    const lastModifiedAt = new Date('2026-08-21T00:00:00.000Z');
    const db = harness.db;

    await db.insert(advisories).values([
      { canonicalId: incomingId, canonicalSource: 'nvd', cveId: incomingId, lastModifiedAt },
      {
        canonicalId: retainedId,
        canonicalSource: 'nvd',
        cveId: retainedId,
        lastModifiedAt,
        kevListed: true,
      },
      {
        canonicalId: removedId,
        canonicalSource: 'nvd',
        cveId: removedId,
        lastModifiedAt,
        kevListed: true,
      },
      {
        canonicalId: `SOURCE-${suffix}`,
        canonicalSource: 'nvd',
        cveId: null,
        lastModifiedAt,
        kevListed: true,
      },
    ]);

    const repository = new AdvisoryRepository(db as never, () => lastModifiedAt);
    const result = await repository.replaceKevCatalog([
      { cveId: incomingId.toLowerCase(), addedAt: new Date('2026-08-20T00:00:00.000Z'), knownRansomware: false },
      { cveId: retainedId, addedAt: new Date('2026-08-19T00:00:00.000Z'), knownRansomware: true },
      // Duplicate source rows cannot inflate the update count or SQL set.
      { cveId: retainedId, addedAt: new Date('2026-08-19T00:00:00.000Z'), knownRansomware: true },
    ]);

    const rows = await db
      .select({ id: advisories.id, canonicalId: advisories.canonicalId, kevListed: advisories.kevListed })
      .from(advisories)
      .where(inArray(advisories.canonicalId, canonicalIds));
    const byCanonical = new Map(rows.map((row) => [row.canonicalId, row]));

    expect(byCanonical.get(incomingId)?.kevListed).toBe(true);
    expect(byCanonical.get(retainedId)?.kevListed).toBe(true);
    expect(byCanonical.get(removedId)?.kevListed).toBe(false);
    expect(byCanonical.get(`SOURCE-${suffix}`)?.kevListed).toBe(false);
    expect(result.listed).toBe(1);
    expect(result.cleared).toBe(2);
    expect(result.changedAdvisoryIds).toEqual(expect.arrayContaining([
      byCanonical.get(incomingId)?.id,
      byCanonical.get(removedId)?.id,
      byCanonical.get(`SOURCE-${suffix}`)?.id,
    ]));

    await db.delete(advisories).where(inArray(advisories.canonicalId, canonicalIds));
  });

  it('never clears existing KEV flags from an empty snapshot', async () => {
    if (!harness) throw new Error('test database is unavailable');

    const canonicalId = `CVE-2099-${randomUUID().slice(0, 8).toUpperCase()}`;
    const db = harness.db;
    await db.insert(advisories).values({
      canonicalId,
      canonicalSource: 'nvd',
      cveId: canonicalId,
      lastModifiedAt: new Date('2026-08-21T00:00:00.000Z'),
      kevListed: true,
    });

    const result = await new AdvisoryRepository(db as never).replaceKevCatalog([]);
    const [row] = await db
      .select({ kevListed: advisories.kevListed })
      .from(advisories)
      .where(eq(advisories.canonicalId, canonicalId));

    expect(result).toEqual({ listed: 0, cleared: 0, changedAdvisoryIds: [] });
    expect(row?.kevListed).toBe(true);
    await db.delete(advisories).where(eq(advisories.canonicalId, canonicalId));
  });
});
