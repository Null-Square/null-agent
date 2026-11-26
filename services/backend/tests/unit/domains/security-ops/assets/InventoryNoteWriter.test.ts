import { describe, expect, it, vi } from 'vitest';

import { InventoryNoteWriter } from '@/domains/security-ops/assets/InventoryNoteWriter';

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

describe('InventoryNoteWriter', () => {
  it('creates scan coverage notes with current inventory fingerprint and broad-scan side effects', async () => {
    const insert = createInsert([{ id: 'note-1' }]);
    const db = {
      select: vi.fn(() => createSelect([])),
      insert: vi.fn(() => insert),
    };
    const computeCurrentInventoryFingerprint = vi.fn(async () => 'fingerprint-current');
    const upsertAsset = vi.fn(async () => ({ assetId: 'asset-1' }));
    const incrementRunCounter = vi.fn(async () => undefined);
    const updateAssetLastScannedAt = vi.fn(async () => undefined);
    const writer = new InventoryNoteWriter(db as never, {
      inventoryProjection: { computeCurrentInventoryFingerprint } as never,
      now: () => new Date('2026-06-12T00:00:00.000Z'),
      normalizeSessionId: (value) => value,
      normalizeNtype: (value) => value.trim().toLowerCase(),
      normalizeAssetValue: (_kind, value) => value.trim().toLowerCase(),
      normalizeToolText: (value) => value.trim(),
      normalizeOptionalToolText: (value) => {
        const normalized = value?.trim();
        return normalized ? normalized : undefined;
      },
      normalizeAssetRefForHost: ({ assetRef }) => assetRef,
      extractHostnameFromUrl: () => undefined,
      pruneNullishDeep: (value) => value,
      buildReportNoteValidationError: (detail, ntype) => new Error(`${ntype}: ${detail}`),
      dedupeKeyForNtype: (ntype) => `dedupe:${ntype}`,
      mergeReportNoteData: (_ntype, _existing, incoming) => incoming,
      mergeEvidenceWithExcerptsByPath: (existing, incoming) => [...(existing ?? []), ...incoming],
      isUniqueViolation: () => false,
      resolveEvidenceWithExcerpts: vi.fn(async (_workspaceDir, evidence) => evidence),
      upsertAsset,
      updateAssetLastScannedAt,
      incrementRunCounter,
    });

    const result = await writer.reportNote({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: '11111111-1111-4111-8111-111111111111',
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      },
      input: {
        assetRef: { kind: 'domain', value: ' App.Example.Test ' },
        ntype: 'scan.coverage',
        title: 'Broad scan',
        data: {
          family: 'broad-surface',
          status: 'completed',
          toolset: ['httpx'],
        },
      },
    });

    expect(result).toEqual({ noteId: 'note-1', created: true, dedupeKey: 'dedupe:scan.coverage' });
    expect(upsertAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { kind: 'domain', value: 'app.example.test' },
      }),
    );
    expect(computeCurrentInventoryFingerprint).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      assetId: 'asset-1',
      assetValue: 'app.example.test',
    });
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        ntype: 'scan.coverage',
        data: expect.objectContaining({
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          inventoryFingerprint: 'fingerprint-current',
        }),
      }),
    );
    expect(incrementRunCounter).toHaveBeenCalledWith('run-1', 'inventoryAdded');
    expect(updateAssetLastScannedAt).toHaveBeenCalledWith(
      'asset-1',
      new Date('2026-06-12T00:00:00.000Z'),
    );
  });
});
