import { describe, expect, it, vi } from 'vitest';

import {
  buildAssetInventoryFingerprint,
  InventoryProjection,
  normalizeScanCoverageData,
} from '@/domains/security-ops/assets/InventoryProjection';

const createSelectDb = (rows: unknown[]) => {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select },
    select,
    from,
    where,
    orderBy,
  };
};

describe('InventoryProjection', () => {
  it('builds stable inventory fingerprints independent of row order', () => {
    const left = buildAssetInventoryFingerprint({
      assetValue: 'api.example.com',
      services: [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          product: 'nginx',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'svc-2',
          assetId: 'asset-1',
          protocol: 'http',
          port: 80,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      techs: [
        {
          id: 'tech-1',
          assetId: 'asset-1',
          product: 'React',
          category: 'frontend',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const right = buildAssetInventoryFingerprint({
      assetValue: 'api.example.com',
      services: [
        {
          id: 'svc-2',
          assetId: 'asset-1',
          protocol: 'http',
          port: 80,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          product: 'nginx',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      techs: [
        {
          id: 'tech-1',
          assetId: 'asset-1',
          product: 'React',
          category: 'frontend',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(left).toMatch(/^[a-f0-9]{64}$/u);
    expect(left).toBe(right);
  });

  it('normalizes broad scan coverage material fields', () => {
    expect(
      normalizeScanCoverageData({
        family: ' broad-surface ',
        status: 'completed',
        profileVersion: ' broad-surface-scan/v1 ',
        inventoryFingerprint: ' abc123 ',
        reason: '',
        toolset: [' httpx ', '', 12],
        stats: {
          endpointsDiscovered: '2',
          findingsCreated: 1,
          techsDetected: -1,
        },
      }),
    ).toEqual({
      family: 'broad-surface',
      status: 'completed',
      profileVersion: 'broad-surface-scan/v1',
      inventoryFingerprint: 'abc123',
      toolset: ['httpx'],
      stats: {
        endpointsDiscovered: 2,
        findingsCreated: 1,
      },
    });

    expect(normalizeScanCoverageData({ status: 'running' })).toEqual({});
  });

  it('projects endpoint notes by asset id', async () => {
    const { db } = createSelectDb([
      {
        id: 'note-1',
        assetId: 'asset-1',
        title: 'Fallback title',
        data: {
          url: 'https://api.example.com/users',
          method: ' post ',
          statusCode: '201',
          title: 'Users endpoint',
        },
        lastSeenAt: new Date('2026-01-02T03:04:05.000Z'),
      },
      {
        id: 'note-ignored',
        assetId: null,
        title: 'Ignored',
        data: {},
        lastSeenAt: new Date('2026-01-02T03:04:05.000Z'),
      },
    ]);
    const projection = new InventoryProjection(db as never);

    await expect(
      projection.loadInventoryEndpointsByAssetIds({
        userId: 'user-1',
        organizationId: 'org-1',
        assetIds: ['asset-1'],
      }),
    ).resolves.toEqual(
      new Map([
        [
          'asset-1',
          [
            {
              id: 'note-1',
              assetId: 'asset-1',
              url: 'https://api.example.com/users',
              method: 'post',
              statusCode: 201,
              title: 'Users endpoint',
              lastSeenAt: '2026-01-02T03:04:05.000Z',
            },
          ],
        ],
      ]),
    );
  });
});
