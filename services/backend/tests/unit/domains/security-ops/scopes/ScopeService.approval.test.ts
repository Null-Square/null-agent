import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';

const createDb = (target: Record<string, unknown> | null) => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (target ? [target] : [])),
        })),
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

  return { db: db as never, updates };
};

describe('ScopeService target approval', () => {
  it('keeps non-manual target approval blocked unless force is explicit', async () => {
    const { db } = createDb({
      id: 'target-1',
      scopeId: 'scope-1',
      verified: false,
      verificationMethod: 'dns_txt',
    });
    const service = new ScopeService(db);

    await expect(service.approveTargetVerification('scope-1', 'target-1')).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
    });
  });

  it('allows audited admin force approval for any pending target method', async () => {
    const { db, updates } = createDb({
      id: 'target-1',
      scopeId: 'scope-1',
      verified: false,
      verificationMethod: 'dns_txt',
    });
    const service = new ScopeService(db);

    const result = await service.approveTargetVerification('scope-1', 'target-1', { force: true });

    expect(result).toEqual({
      verified: true,
      message: 'Target force-approved through admin review.',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ verified: true });
    expect(updates[0]?.verifiedAt).toBeInstanceOf(Date);
  });
});
