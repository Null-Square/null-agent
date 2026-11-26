import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';

const createAddTargetDb = (
  existingTargets: Array<{ type: string; value: string; verified?: boolean }>,
) => {
  const insertedValues: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => existingTargets),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return {
          returning: vi.fn(async () => [{
            id: 'target-new',
            ...values,
            createdAt: new Date(),
          }]),
        };
      }),
    })),
  };

  return { db, insertedValues };
};

describe('ScopeService domain target boundaries', () => {
  it('auto-verifies subdomain targets under a verified parent domain', async () => {
    const { db, insertedValues } = createAddTargetDb([
      { type: 'domain', value: 'example.com', verified: true },
    ]);
    const service = new ScopeService(db as never);

    const target = await service.addTarget('scope-1', {
      type: 'domain',
      value: 'api.example.com',
    });

    expect(target.value).toBe('api.example.com');
    expect(target.verified).toBe(true);
    expect(target.verificationMethod).toBe('none');
    expect(insertedValues[0]?.verificationToken).toBeUndefined();
    expect(insertedValues).toHaveLength(1);
  });

  it('rejects subdomain targets under an unverified parent domain', async () => {
    const { db } = createAddTargetDb([
      { type: 'domain', value: 'example.com', verified: false },
    ]);
    const service = new ScopeService(db as never);

    await expect(service.addTarget('scope-1', {
      type: 'domain',
      value: 'api.example.com',
    })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      message: 'Verify example.com before adding subdomains under it.',
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects unrelated domain roots before inserting a new target', async () => {
    const { db } = createAddTargetDb([
      { type: 'domain', value: 'example.com', verified: true },
    ]);
    const service = new ScopeService(db as never);

    await expect(service.addTarget('scope-1', {
      type: 'domain',
      value: 'other-company.com',
    })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects sibling subdomains until the root domain is added and verified', async () => {
    const { db } = createAddTargetDb([
      { type: 'domain', value: 'api.example.com', verified: true },
    ]);
    const service = new ScopeService(db as never);

    await expect(service.addTarget('scope-1', {
      type: 'domain',
      value: 'admin.example.com',
    })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('marks pending descendant domains verified when the parent domain is approved', async () => {
    const selectResults = [
      [{
        id: 'target-root',
        scopeId: 'scope-1',
        type: 'domain',
        value: 'example.com',
        verified: false,
        verificationMethod: 'manual_review',
      }],
      [
        { id: 'target-sub', value: 'api.example.com' },
        { id: 'target-other', value: 'other-company.com' },
      ],
    ];
    const updates: Record<string, unknown>[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectResults.shift() ?? [];
            return {
              limit: vi.fn(async () => rows),
              then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
            };
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updates.push(values);
            return [];
          }),
        })),
      })),
    };
    const service = new ScopeService(db as never);

    const result = await service.approveTargetVerification('scope-1', 'target-root');

    expect(result.verified).toBe(true);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ verified: true });
    expect(updates[1]).toMatchObject({
      verified: true,
      verificationMethod: 'none',
      verificationToken: null,
    });
  });
});
