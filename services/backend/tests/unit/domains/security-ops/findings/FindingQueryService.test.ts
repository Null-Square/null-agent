import { describe, expect, it, vi } from 'vitest';

import { FindingQueryService } from '@/domains/security-ops/findings/FindingQueryService';

const createQueuedDb = (results: unknown[][]) => {
  const chains: Array<{
    from: ReturnType<typeof vi.fn>;
    innerJoin: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];
  const db = {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      chains.push(chain);
      return chain;
    }),
  };
  return { db, chains };
};

describe('FindingQueryService', () => {
  it('projects findings with asset filtering, CWE merging, completeness, and revalidation hints', async () => {
    const { db, chains } = createQueuedDb([
      [{ id: 'asset-1' }],
      [
        {
          id: 'finding-1',
          title: 'SQL injection',
          severity: 'high',
          state: 'confirmed',
          assetValue: 'app.example.test',
          summary: 'SQL injection summary',
          businessImpact: 'Data exposure could affect customers.',
          technicalAnalysis: 'A parameter is concatenated into SQL.',
          pocDescription: 'Send a quote payload and observe SQL error.',
          assumptions: 'Authenticated user access is available.',
          remediation: 'Use parameterized queries.',
          fixEffort: 'medium',
          cweIds: ['CWE-89'],
          cweId: 'CWE-20',
          owaspCategory: 'A03:2021-Injection',
          cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N',
          cvssScore: 8.1,
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
      ],
      [],
    ]);
    const normalizeAssetValue = vi.fn((kind: 'domain' | 'ip', value: string) =>
      kind === 'domain' ? value.trim().toLowerCase() : value.trim(),
    );
    const validateIpAssetRefOrThrow = vi.fn();
    const mergeStringSet = vi.fn((existing?: string[] | null, incoming?: string[] | null) =>
      Array.from(new Set([...(existing ?? []), ...(incoming ?? [])])),
    );
    const service = new FindingQueryService(db as never, {
      normalizeAssetValue,
      validateIpAssetRefOrThrow,
      mergeStringSet,
    });

    const result = await service.queryFindings({
      userId: 'user-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        assetRef: { kind: 'domain', value: ' App.Example.Test ' },
        status: 'open',
        severity: 'high',
      },
    });

    expect(normalizeAssetValue).toHaveBeenCalledWith('domain', ' App.Example.Test ');
    expect(validateIpAssetRefOrThrow).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(chains[0]?.limit).toHaveBeenCalledWith(1);
    expect(chains[1]?.innerJoin).toHaveBeenCalled();
    expect(chains[1]?.limit).toHaveBeenCalledWith(500);
    expect(mergeStringSet).toHaveBeenCalledWith(['CWE-89'], ['CWE-20']);
    expect(result.totalCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      id: 'finding-1',
      cweIds: ['CWE-89', 'CWE-20'],
      missingReportFields: [],
      validationProof: null,
      lastSeenAt: '2026-06-12T00:00:00.000Z',
    });
    expect(result.findings[0]?.revalidationHint).toContain('validatesFindingId="finding-1"');
  });

  it('returns no findings when an assetRef does not resolve', async () => {
    const { db } = createQueuedDb([[]]);
    const service = new FindingQueryService(db as never, {
      normalizeAssetValue: (_kind, value) => value,
      validateIpAssetRefOrThrow: vi.fn(),
      mergeStringSet: vi.fn(),
    });

    const result = await service.queryFindings({
      userId: 'user-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        assetRef: { kind: 'ip', value: '192.0.2.10' },
      },
    });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ findings: [], totalCount: 0 });
  });
});
