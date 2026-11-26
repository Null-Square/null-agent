import { describe, expect, it } from 'vitest';

import {
  compareAssetPriorityCandidates,
  deriveAssetFocus,
  loadAssetFocusEnrichments,
} from '@/domains/security-ops/assets/assetFocus';

const buildDbQueue = (results: unknown[]) => {
  let cursor = 0;
  const next = () => {
    if (cursor >= results.length) {
      throw new Error(`No queued DB result for query #${cursor + 1}`);
    }
    const value = results[cursor];
    cursor += 1;
    return value;
  };

  return {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
          Promise.resolve(next()).then(onfulfilled, onrejected),
      };
      return chain;
    },
  };
};

describe('asset focus scoring', () => {
  it('calculates a capped focus score with ranked reasons', () => {
    const focus = deriveAssetFocus({
      assetId: 'asset-1',
      assetKind: 'domain',
      assetValue: 'api.example.com',
      lastScannedAt: null,
      serviceCount: 2,
      needsBroadScan: true,
      exactVerifiedTargetMatch: true,
      openFindings: {
        total: 1,
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        info: 0,
      },
    });

    expect(focus.score).toBe(93);
    expect(focus.label).toBe('critical');
    expect(focus.reasons).toEqual([
      'Open high-severity finding on this asset',
      'Mapped services exist but the asset is still untested',
      'Exact verified scope target',
      'Broad-surface coverage is missing or stale',
    ]);
  });

  it('makes critical findings critical without a customer-authored profile', () => {
    const focus = deriveAssetFocus({
      assetId: 'asset-1',
      assetKind: 'domain',
      assetValue: 'api.example.com',
      lastScannedAt: '2026-08-13T00:00:00.000Z',
      serviceCount: 0,
      needsBroadScan: false,
      exactVerifiedTargetMatch: false,
      openFindings: {
        total: 2,
        critical: 2,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    });

    expect(focus).toEqual({
      score: 80,
      label: 'critical',
      reasons: ['2 open critical findings on this asset'],
    });
  });

  it('prioritizes broad-scan gaps, then raw focus score', () => {
    const ordered = ([
      {
        value: 'api.example.com',
        needsBroadScan: false,
        focus: { score: 98, label: 'critical' as const, reasons: [] },
      },
      {
        value: 'portal.example.com',
        needsBroadScan: true,
        focus: { score: 54, label: 'medium' as const, reasons: [] },
      },
      {
        value: 'admin.example.com',
        needsBroadScan: false,
        focus: { score: 54, label: 'medium' as const, reasons: [] },
      },
    ]).sort(compareAssetPriorityCandidates);

    expect(ordered.map((asset) => asset.value)).toEqual([
      'portal.example.com',
      'api.example.com',
      'admin.example.com',
    ]);
  });
});

describe('loadAssetFocusEnrichments', () => {
  it('adds the exact verified scope target boost from verified scope targets', async () => {
    const db = buildDbQueue([
      [],
      [],
      [],
      [],
      [{ type: 'domain', value: 'api.example.com' }],
    ]);

    const enrichments = await loadAssetFocusEnrichments({
      db: db as never,
      organizationId: 'org-1',
      scopeId: 'scope-1',
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          lastScannedAt: null,
        },
      ],
    });

    const enrichment = enrichments.get('asset-1');
    expect(enrichment).toBeDefined();
    expect(enrichment?.exactVerifiedTargetMatch).toBe(true);
    expect(enrichment?.needsBroadScan).toBe(true);
    expect(enrichment?.focus.score).toBe(20);
    expect(enrichment?.focus.reasons).toEqual([
      'Exact verified scope target',
      'Broad-surface coverage is missing or stale',
    ]);
  });
});
