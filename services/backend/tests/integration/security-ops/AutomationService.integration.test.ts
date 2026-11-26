import { randomUUID } from 'crypto';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { setupTestDb } from '../../helpers/testDb';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import {
  automations,
  assets,
  findings,
  organizations,
  users,
} from '@/db/schema';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('AutomationService confidence filter (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
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

  const createFixture = async () => {
    const db = harness!.db as any;
    const service = new AutomationService({ db });

    const userId = randomUUID();
    const orgSlug = `automation-confidence-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await db.insert(users).values({
      id: userId,
      email: `${orgSlug}@example.com`,
      password_hash: 'test',
    });

    const [{ id: orgId }] = await db
      .insert(organizations)
      .values({
        name: 'Automation Confidence Org',
        slug: orgSlug,
      })
      .returning({ id: organizations.id });

    const scopeColumnsResult = await harness!.pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scopes'
    `);
    const scopeColumns = new Set(scopeColumnsResult.rows.map((row) => row.column_name));

    const insertScope = async (name: string): Promise<string> => {
      const insertColumns = ['organization_id', 'name'];
      const insertValues: Array<string | boolean> = [orgId, name];

      if (scopeColumns.has('user_id')) {
        insertColumns.push('user_id');
        insertValues.push(userId);
      }
      if (scopeColumns.has('kind')) {
        insertColumns.push('kind');
        insertValues.push('domain');
      }
      if (scopeColumns.has('safe_mode')) {
        insertColumns.push('safe_mode');
        insertValues.push(true);
      }
      if (scopeColumns.has('status')) {
        insertColumns.push('status');
        insertValues.push('active');
      }

      const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
      const scopeInsert = await harness!.pool.query<{ id: string }>(
        `INSERT INTO scopes (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        insertValues,
      );
      const scopeId = scopeInsert.rows[0]?.id;
      if (!scopeId) {
        throw new Error('Failed to create scope fixture');
      }
      return scopeId;
    };

    const scopeId = await insertScope('Primary');
    const secondaryScopeId = await insertScope('Secondary');

    const goal = `Automation goal ${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const [{ id: assetId }] = await db
      .insert(assets)
      .values({
        organizationId: orgId,
        scopeId,
        userId,
        kind: 'domain',
        value: 'example.com',
      })
      .returning({ id: assets.id });

    const createFinding = async (confidenceScore: number) => {
      const [row] = await db
        .insert(findings)
        .values({
          organizationId: orgId,
          scopeId,
          userId,
          assetId,
          title: `Finding ${confidenceScore}`,
          severity: 'medium',
          state: 'potential',
          summary: 'Test finding',
          confidenceScore,
          dedupeKey: randomUUID(),
        })
        .returning({ id: findings.id });
      return row.id;
    };

    return {
      db,
      service,
      userId,
      orgId,
      scopeId,
      secondaryScopeId,
      goal,
      createFinding,
    };
  };

  itMaybe('triggers event automations only when finding confidence is below threshold', async () => {
    const fixture = await createFixture();
    const { service, orgId, scopeId, goal, userId, createFinding } = fixture;

    await service.createAutomation(orgId, userId, {
      name: 'Retest low-confidence findings',
      scopeId,
      goal,
      triggerType: 'event',
      triggerConfig: {
        eventType: 'finding_created',
        filter: { confidence_below: 0.6 },
      },
      isActive: true,
    });

    const lowConfidenceFindingId = await createFinding(0.45);
    const highConfidenceFindingId = await createFinding(0.91);

    const low = await service.evaluateEvent(orgId, {
      type: 'finding_created',
      payload: { findingId: lowConfidenceFindingId },
    });
    expect(low.triggered).toBe(1);

    const high = await service.evaluateEvent(orgId, {
      type: 'finding_created',
      payload: { findingId: highConfidenceFindingId },
    });
    expect(high.triggered).toBe(0);
  });

  itMaybe('matches run_completed goal filter and propagates source scope for chaining', async () => {
    const fixture = await createFixture();
    const { db, service, orgId, scopeId, secondaryScopeId, goal, userId } = fixture;

    await service.createAutomation(orgId, userId, {
      name: 'Chain after discovery',
      scopeId,
      goal,
      triggerType: 'event',
      triggerConfig: {
        eventType: 'run_completed',
        filter: { goal_contains: 'attack surface discovery' },
      },
      isActive: true,
    });

    const mismatch = await service.evaluateEvent(orgId, {
      type: 'run_completed',
      payload: {
        runId: randomUUID(),
        goal: 'Vulnerability assessment follow-up',
        scopeId: secondaryScopeId,
      },
    });
    expect(mismatch.triggered).toBe(0);

    const matched = await service.evaluateEvent(orgId, {
      type: 'run_completed',
      payload: {
        runId: randomUUID(),
        goal: 'Attack surface discovery',
        scopeId: secondaryScopeId,
      },
    });
    expect(matched.triggered).toBe(1);

    const [row] = await db
      .select({
        scopeId: automations.scopeId,
        nextRunAt: automations.nextRunAt,
      })
      .from(automations)
      .where(and(eq(automations.organizationId, orgId), eq(automations.name, 'Chain after discovery')))
      .limit(1);

    expect(row?.scopeId).toBe(secondaryScopeId);
    expect(row?.nextRunAt).toBeInstanceOf(Date);
  });
});
