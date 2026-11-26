import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const selectResults: unknown[] = [];
  const updateResults: unknown[] = [];
  const deleteResults: unknown[] = [];

  const next = (queue: unknown[], label: string) => {
    if (queue.length === 0) {
      throw new Error(`No queued ${label} result`);
    }
    return queue.shift();
  };

  const createSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
        Promise.resolve(next(selectResults, 'select')).then(onfulfilled, onrejected),
    };
    return chain;
  };

  const createWriteChain = (queue: unknown[], label: string) => {
    const chain: any = {
      set: vi.fn(() => chain),
      where: vi.fn(() => chain),
      returning: vi.fn(() => Promise.resolve(next(queue, label))),
    };
    return chain;
  };

  const database = {
    execute: vi.fn(() => Promise.resolve([])),
    select: vi.fn(() => createSelectChain()),
    update: vi.fn(() => createWriteChain(updateResults, 'update')),
    delete: vi.fn(() => createWriteChain(deleteResults, 'delete')),
    transaction: vi.fn((operation: (tx: unknown) => Promise<unknown>) => operation(database)),
  };

  return {
    selectResults,
    updateResults,
    deleteResults,
    database,
    eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
    and: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
    count: vi.fn(() => ({ op: 'count' })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings: [...strings], values })),
  };
});

vi.mock('drizzle-orm', () => ({
  and: mocks.and,
  count: mocks.count,
  eq: mocks.eq,
  sql: mocks.sql,
}));

vi.mock('@/db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
    slug: 'organizations.slug',
    operationalContext: 'organizations.operational_context',
    complianceFrameworks: 'organizations.compliance_frameworks',
    updatedAt: 'organizations.updated_at',
  },
  organizationMembers: {
    organizationId: 'organization_members.organization_id',
    userId: 'organization_members.user_id',
    role: 'organization_members.role',
    createdAt: 'organization_members.created_at',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
    full_name: 'users.full_name',
  },
}));

import {
  LAST_ORGANIZATION_ADMIN_ERROR,
  OrganizationService,
} from '@/domains/security-ops/organization/OrganizationService';

const adminMember = (role = 'admin') => [{
  userId: 'user-1',
  email: 'admin@test.com',
  role,
  fullName: 'Admin User',
}];

describe('OrganizationService member admin invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.updateResults.length = 0;
    mocks.deleteResults.length = 0;
  });

  it('blocks demoting the only organization admin', async () => {
    const service = new OrganizationService(mocks.database as any);
    mocks.selectResults.push(adminMember('admin'), [{ count: 1 }]);

    await expect(service.updateMemberRole('org-1', 'user-1', 'viewer')).rejects.toThrow(
      LAST_ORGANIZATION_ADMIN_ERROR,
    );
    expect(mocks.database.update).not.toHaveBeenCalled();
    expect(mocks.database.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.database.execute).toHaveBeenCalledTimes(1);
  });

  it('blocks removing the only organization admin', async () => {
    const service = new OrganizationService(mocks.database as any);
    mocks.selectResults.push(adminMember('admin'), [{ count: 1 }]);

    await expect(service.removeMember('org-1', 'user-1')).rejects.toThrow(
      LAST_ORGANIZATION_ADMIN_ERROR,
    );
    expect(mocks.database.delete).not.toHaveBeenCalled();
    expect(mocks.database.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.database.execute).toHaveBeenCalledTimes(1);
  });

  it('allows demoting an admin when another admin remains', async () => {
    const service = new OrganizationService(mocks.database as any);
    mocks.selectResults.push(adminMember('admin'), [{ count: 2 }], adminMember('viewer'));
    mocks.updateResults.push([{ userId: 'user-1' }]);

    const updated = await service.updateMemberRole('org-1', 'user-1', 'viewer');

    expect(updated?.role).toBe('viewer');
    expect(mocks.database.update).toHaveBeenCalledTimes(1);
  });
});
