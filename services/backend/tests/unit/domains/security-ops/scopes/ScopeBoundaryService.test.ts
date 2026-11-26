import { describe, expect, it, vi } from 'vitest';

import { ScopeBoundaryService } from '@/domains/security-ops/scopes/ScopeBoundaryService';

const createHarness = (input?: {
  scopeRows?: Array<{ id: string }>;
  targetRows?: Array<{ type: 'domain' | 'cidr'; value: string }>;
  exclusionRows?: Array<{ type: 'domain' | 'cidr'; value: string }>;
}) => {
  const rowSets = [
    input?.scopeRows ?? [{ id: 'scope-1' }],
    input?.targetRows ?? [
      { type: 'domain' as const, value: 'Example.COM.' },
      { type: 'cidr' as const, value: '192.0.2.0/24' },
    ],
    input?.exclusionRows ?? [
      { type: 'domain' as const, value: 'billing.example.com' },
    ],
  ];
  let selectIndex = 0;
  const select = vi.fn(() => {
    const rows = rowSets[selectIndex++] ?? [];
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => rows),
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onfulfilled, onrejected),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    return query;
  });
  const db = { select };
  return { service: new ScopeBoundaryService(db as never), select };
};

describe('ScopeBoundaryService', () => {
  it('derives one canonical boundary directly from verified roots and exclusions', async () => {
    const harness = createHarness();

    const boundary = await harness.service.getBoundaryByScopeId('scope-1');

    expect(boundary).toMatchObject({
      roots: [
        { type: 'cidr', value: '192.0.2.0/24' },
        { type: 'domain', value: 'example.com' },
      ],
      exclusions: [{ type: 'domain', value: 'billing.example.com' }],
      rulesDigest: expect.any(String),
    });
    expect(harness.select).toHaveBeenCalledTimes(3);
  });

  it('allows descendants, applies exclusions, and never treats a domain as IP authority', async () => {
    await expect(
      createHarness().service.assertTarget('scope-1', 'https://api.example.com/v1'),
    ).resolves.toMatchObject({ allowed: true, reason: 'in_scope' });

    await expect(
      createHarness().service.assertTarget('scope-1', 'https://billing.example.com'),
    ).rejects.toThrow('explicitly excluded');

    await expect(
      createHarness().service.assertTarget('scope-1', 'https://198.51.100.10'),
    ).rejects.toThrow('outside the verified pentest scope');
  });

  it('fails closed when the scope has no verified target roots', async () => {
    await expect(
      createHarness({ targetRows: [] }).service.assertTarget('scope-1', 'https://example.com'),
    ).rejects.toThrow('outside the verified pentest scope');
  });
});
