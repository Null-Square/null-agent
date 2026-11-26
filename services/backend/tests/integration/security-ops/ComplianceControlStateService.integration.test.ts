import { randomUUID } from 'crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLogs,
  organizationMembers,
  organizations,
  scopes,
  users,
} from '@/db/schema';
import { ComplianceControlStateService } from '@/domains/security-ops/compliance/ComplianceControlStateService';

import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ComplianceControlStateService integration', () => {
  let harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

  beforeAll(async () => {
    const testDb = await setupTestDb();
    if (!testDb) throw new Error('TEST_DATABASE_URL is required');
    harness = testDb;
  });

  beforeEach(async () => {
    await harness.truncateAll();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const seed = async () => {
    const db = harness.db;
    const actorUserId = randomUUID();
    const assigneeUserId = randomUUID();
    const organizationId = randomUUID();
    const scopeId = randomUUID();
    await db.insert(users).values([
      { id: actorUserId, email: `actor-${actorUserId}@example.com`, password_hash: 'hash' },
      { id: assigneeUserId, email: `assignee-${assigneeUserId}@example.com`, password_hash: 'hash' },
    ]);
    await db.insert(organizations).values({
      id: organizationId,
      name: 'Control State Org',
      slug: `state-${organizationId}`,
    });
    await db.insert(organizationMembers).values([
      { organizationId, userId: actorUserId, role: 'owner' },
      { organizationId, userId: assigneeUserId, role: 'analyst' },
    ]);
    await db.insert(scopes).values({ id: scopeId, organizationId, name: 'Production', complianceFrameworks: ['soc2'] });
    return { actorUserId, assigneeUserId, organizationId, scopeId };
  };

  it('audits exclude, reactivate, and assignment changes with before/after snapshots', async () => {
    const fixture = await seed();
    const service = new ComplianceControlStateService(harness.db);

    await service.upsertState({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      frameworkKey: 'soc2',
      controlId: 'cc6.1',
      state: 'excluded',
      exclusionReason: 'Not applicable to this scope during onboarding.',
      actorUserId: fixture.actorUserId,
    });
    await service.upsertState({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      state: 'monitored',
      assignedToUserId: fixture.assigneeUserId,
      actorUserId: fixture.actorUserId,
    });

    const events = await harness.db
      .select()
      .from(auditLogs)
      .where(and(
        eq(auditLogs.organizationId, fixture.organizationId),
        eq(auditLogs.action, 'compliance.control_state.updated'),
        eq(auditLogs.resourceType, 'compliance_control'),
        eq(auditLogs.resourceId, 'soc2:CC6.1'),
      ))

    expect(events).toHaveLength(2);
    const excludeEvent = events.find((event) => event.changes?.previous === null);
    const reactivateEvent = events.find((event) => {
      const previous = event.changes?.previous;
      return typeof previous === 'object' && previous !== null && 'state' in previous;
    });
    expect(excludeEvent?.changes).toMatchObject({
      previous: null,
      next: {
        state: 'excluded',
        exclusionReason: 'Not applicable to this scope during onboarding.',
      },
    });
    expect(reactivateEvent?.changes).toMatchObject({
      previous: {
        state: 'excluded',
      },
      next: {
        state: 'monitored',
        exclusionReason: null,
        assignedToUserId: fixture.assigneeUserId,
      },
      changed: {
        state: true,
        exclusionReason: true,
        assignedToUserId: true,
      },
    });
  });
});
