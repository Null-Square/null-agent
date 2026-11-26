import { describe, expect, it, vi } from 'vitest';

import { InventoryQueryService } from '@/domains/security-ops/assets/InventoryQueryService';
import {
  buildAssetInventoryFingerprint,
  type InventoryServiceSummary,
  type InventoryTechSummary,
} from '@/domains/security-ops/assets/InventoryProjection';

const createDb = (rows: Array<Record<string, unknown>>) => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return {
    db: {
      select: vi.fn(() => query),
    },
    query,
  };
};

describe('InventoryQueryService', () => {
  it('projects digest inventory with focus ranking and coverage state', async () => {
    const now = new Date('2026-06-12T00:00:00.000Z');
    const services: InventoryServiceSummary[] = [
      {
        id: 'svc-1',
        assetId: 'asset-managed',
        protocol: 'tcp',
        port: 443,
        serviceName: 'https',
        product: 'nginx',
        lastSeenAt: '2026-06-10T00:00:00.000Z',
      },
    ];
    const techs: InventoryTechSummary[] = [
      {
        id: 'tech-1',
        assetId: 'asset-managed',
        product: 'nginx',
        category: 'web-server',
        lastSeenAt: '2026-06-10T00:00:00.000Z',
      },
    ];
    const matchingFingerprint = buildAssetInventoryFingerprint({
      assetValue: 'app.example.test',
      services,
      techs,
    });
    const { db, query } = createDb([
      {
        id: 'asset-validated',
        scopeId: 'scope-1',
        kind: 'domain',
        value: 'api.example.test',
        isLead: true,
        tags: [],
        lastScannedAt: null,
        lastSeenAt: new Date('2026-06-11T00:00:00.000Z'),
      },
      {
        id: 'asset-managed',
        scopeId: 'scope-1',
        kind: 'domain',
        value: 'app.example.test',
        isLead: false,
        tags: ['priority'],
        lastScannedAt: null,
        lastSeenAt: new Date('2026-06-10T00:00:00.000Z'),
      },
    ]);
    const inventoryProjection = {
      loadInventoryServicesByAssetIds: vi.fn(async () => new Map([['asset-managed', services]])),
      loadInventoryEndpointsByAssetIds: vi.fn(async () => new Map()),
      loadInventoryTechsByAssetIds: vi.fn(async () => new Map([['asset-managed', techs]])),
      loadBroadScanCoverageByAssetIds: vi.fn(async () =>
        new Map([
          [
            'asset-managed',
            {
              assetId: 'asset-managed',
              lastSeenAt: '2026-06-11T00:00:00.000Z',
              data: {
                family: 'broad-surface',
                status: 'completed' as const,
                profileVersion: 'broad-surface-scan/v1',
                inventoryFingerprint: matchingFingerprint,
              },
            },
          ],
        ]),
      ),
    };
    const loadAssetFocusEnrichments = vi.fn(async () =>
      new Map([
        [
          'asset-managed',
          {
            focus: { score: 80, label: 'high', reasons: ['priority'] },
            needsBroadScan: false,
            serviceCount: 1,
            openFindings: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            exactVerifiedTargetMatch: true,
          },
        ],
        [
          'asset-validated',
          {
            focus: { score: 90, label: 'critical', reasons: ['api'] },
            needsBroadScan: true,
            serviceCount: 0,
            openFindings: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            exactVerifiedTargetMatch: false,
          },
        ],
      ]),
    );
    const loadVersionAcquisitionByAssetIds = vi.fn(async () =>
      new Map([
        [
          'asset-validated',
          [
            {
              componentId: 'component-1',
              componentKey: 'cpe:nginx:nginx',
              product: 'nginx',
              ecosystem: 'cpe',
              status: 'needs_version' as const,
              recommendedMethod: 'service_probe' as const,
              attemptedMethods: ['http_banner' as const],
              remainingMethods: [
                'service_probe' as const,
                'application_fingerprint' as const,
                'error_behavior' as const,
                'tls_fingerprint' as const,
              ],
            },
          ],
        ],
        [
          'asset-managed',
          [
            {
              componentId: 'component-2',
              componentKey: 'cpe:apache:http_server',
              product: 'Apache HTTP Server',
              ecosystem: 'cpe',
              status: 'exhausted' as const,
              recommendedMethod: null,
              attemptedMethods: [
                'http_banner' as const,
                'service_probe' as const,
                'application_fingerprint' as const,
                'error_behavior' as const,
                'tls_fingerprint' as const,
              ],
              remainingMethods: [],
            },
          ],
        ],
      ]),
    );
    const service = new InventoryQueryService(db as never, {
      inventoryProjection,
      loadAssetFocusEnrichments: loadAssetFocusEnrichments as never,
      loadVersionAcquisitionByAssetIds,
      now: () => now,
    });

    const result = await service.queryInventory({
      userId: 'user-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        mode: 'digest',
        assetKind: 'domain',
        includeLeads: true,
        includeServices: true,
        limit: 50,
      },
    });

    expect(query.limit).toHaveBeenCalledWith(50);
    expect(inventoryProjection.loadInventoryServicesByAssetIds).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ['asset-validated', 'asset-managed'] }),
    );
    expect(loadVersionAcquisitionByAssetIds).toHaveBeenCalledWith({
      organizationId: 'org-1',
      assetIds: ['asset-validated', 'asset-managed'],
    });
    expect(result.mode).toBe('digest');
    expect(result.assets.map((asset) => asset.id)).toEqual(['asset-validated', 'asset-managed']);
    expect(result.assets[0]).toMatchObject({
      id: 'asset-validated',
      isLead: true,
      needsBroadScan: true,
      needsVersionAcquisition: true,
      versionAcquisition: [
        expect.objectContaining({
          componentId: 'component-1',
          status: 'needs_version',
          recommendedMethod: 'service_probe',
          attemptedMethods: ['http_banner'],
        }),
      ],
    });
    expect(result.assets[1]).toMatchObject({
      id: 'asset-managed',
      isLead: false,
      needsBroadScan: false,
      needsVersionAcquisition: false,
      versionAcquisition: [
        expect.objectContaining({
          componentId: 'component-2',
          status: 'exhausted',
          recommendedMethod: null,
        }),
      ],
      serviceSummary: {
        serviceCount: 1,
      },
    });
    expect(result.assets[0]).not.toHaveProperty('recommendedAction');
    expect(result.assets[0]).not.toHaveProperty('promotionSuggested');
    expect(result.assets[1]).not.toHaveProperty('recommendedAction');
    expect(result.assets[1]).not.toHaveProperty('promotionSuggested');
    expect(result.digest).toEqual({
      returnedAssets: 2,
      confirmedAssets: 1,
      leadAssets: 1,
      needsBroadScan: 1,
      needsVersionAcquisition: 1,
      versionAcquisitionExhausted: 1,
      limitReached: false,
    });
  });
});
