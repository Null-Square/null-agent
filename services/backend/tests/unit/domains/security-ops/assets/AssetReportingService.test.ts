import { describe, expect, it, vi } from 'vitest';

import { AssetReportingService } from '@/domains/security-ops/assets/AssetReportingService';

const createSelect = (rows: unknown[]) => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return query;
};

const createInsert = (rows: unknown[]) => {
  const insert = {
    values: vi.fn(() => insert),
    returning: vi.fn(async () => rows),
  };
  return insert;
};

const createOptions = () => {
  const assetWriter = {
    upsertAsset: vi.fn(async () => ({ assetId: 'asset-1', created: true })),
    incrementRunCounter: vi.fn(async () => undefined),
  };
  return {
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    assetWriter,
    normalizeSessionId: (value: string | undefined) => value,
    normalizeAssetValue: (_kind: 'domain' | 'ip', value: string) => value.trim().toLowerCase(),
    normalizeAssetRefForHost: ({ assetRef }: { assetRef: { kind: 'domain' | 'ip'; value: string } }) => assetRef,
    resolveEvidenceRefs: vi.fn(async (_workspaceDir: string, evidence: Array<{ path: string; label?: string }> = []) =>
      evidence,
    ),
    mergeEvidenceByPath: vi.fn(
      (
        existing: Array<{ path: string; label?: string }> | null | undefined = [],
        incoming: Array<{ path: string; label?: string }> | null | undefined = [],
      ) => [...(existing ?? []), ...(incoming ?? [])],
    ),
    isUniqueViolation: () => false,
    emitSecurityOpsEvent: vi.fn(async () => undefined),
  };
};

describe('AssetReportingService', () => {
  it('reports assets through the writer and emits discovery events for new rows', async () => {
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const options = createOptions();
    const service = new AssetReportingService(db as never, options);

    const result = await service.reportAsset({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: 'session-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
      input: {
        kind: 'domain',
        value: ' App.Example.Test ',
        tags: ['api'],
      },
    });

    expect(result).toEqual({ assetId: 'asset-1', created: true });
    expect(options.assetWriter.upsertAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        workspaceDir: 'C:/workspace',
        sessionId: 'session-1',
        context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
        input: {
          kind: 'domain',
          value: ' App.Example.Test ',
          tags: ['api'],
        },
        executor: tx,
      }),
    );
    expect(options.emitSecurityOpsEvent).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        type: 'asset_discovered',
        payload: {
          assetId: 'asset-1',
          kind: 'domain',
          value: 'app.example.test',
        },
      }),
    );
  });

  it('creates inventory services and increments run inventory counts', async () => {
    const insert = createInsert([{ id: 'svc-1' }]);
    const db = {
      select: vi.fn(() => createSelect([])),
      insert: vi.fn(() => insert),
    };
    const recordComponentObservation = vi.fn(async () => ({ status: 'recorded' }));
    const options = { ...createOptions(), recordComponentObservation };
    const service = new AssetReportingService(db as never, options);

    const result = await service.reportService({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: 'session-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
      input: {
        assetRef: { kind: 'domain', value: 'app.example.test' },
        protocol: 'https',
        port: 443,
        serviceName: 'https',
        product: 'nginx',
        versionReadMethod: 'service_probe',
        evidence: [{ path: '.artifacts/nmap.txt', label: 'nmap' }],
      },
    });

    expect(result).toEqual({ serviceId: 'svc-1', created: true });
    expect(options.assetWriter.upsertAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          kind: 'domain',
          value: 'app.example.test',
        },
      }),
    );
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        assetId: 'asset-1',
        protocol: 'https',
        port: 443,
        serviceName: 'https',
        product: 'nginx',
        evidence: [{ path: '.artifacts/nmap.txt', label: 'nmap' }],
      }),
    );
    expect(options.assetWriter.incrementRunCounter).toHaveBeenCalledWith('run-1', 'inventoryAdded');
    expect(recordComponentObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'nginx',
        version: null,
        versionReadMethod: 'service_probe',
      }),
    );
  });
});
