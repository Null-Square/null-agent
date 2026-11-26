import { describe, expect, it, vi } from 'vitest';

import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';

const createHarness = () => {
  let inserted: Record<string, unknown> | null = null;
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted = values;
        return {
          returning: vi.fn(async () => [{
            id: 'scope-1',
            ...values,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        };
      }),
    })),
  };

  return {
    service: new ScopeService(db as never),
    inserted: () => inserted,
  };
};

describe('ScopeService creation defaults', () => {
  it('creates normal pentest scopes with bounded PoC impact by default', async () => {
    const harness = createHarness();

    await harness.service.create('org-1', { name: 'Production' });

    expect(harness.inserted()).toEqual(expect.objectContaining({ impactTolerance: 'poc' }));
  });

  it('does not persist legacy fields that looked enforceable but were not', async () => {
    const harness = createHarness();

    await harness.service.create('org-1', {
      name: 'Production',
      safeMode: true,
      stealthPosture: 'covert',
      rateLimitRps: 1,
      blastWindow: 'weekends',
      roeDocument: 'legacy notes',
    } as never);

    expect(harness.inserted()).not.toHaveProperty('safeMode');
    expect(harness.inserted()).not.toHaveProperty('stealthPosture');
    expect(harness.inserted()).not.toHaveProperty('rateLimitRps');
    expect(harness.inserted()).not.toHaveProperty('blastWindow');
    expect(harness.inserted()).not.toHaveProperty('roeDocument');
  });
});
