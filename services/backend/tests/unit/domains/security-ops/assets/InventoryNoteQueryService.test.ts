import { describe, expect, it, vi } from 'vitest';

import { InventoryNoteQueryService } from '@/domains/security-ops/assets/InventoryNoteQueryService';

const createQueuedDb = (results: unknown[][]) => {
  const chains: Array<{
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];
  const db = {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
      };
      chains.push(chain);
      return chain;
    }),
  };
  return { db, chains };
};

describe('InventoryNoteQueryService', () => {
  it('queries notes with asset lookup, ntype normalization, and timestamp mapping', async () => {
    const { db, chains } = createQueuedDb([
      [{ id: 'asset-1' }],
      [
        {
          id: 'note-1',
          assetId: 'asset-1',
          ntype: 'http.endpoint',
          title: null,
          data: { url: 'https://app.example.test' },
          confidence: null,
          firstSeenAt: new Date('2026-06-11T00:00:00.000Z'),
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
      ],
    ]);
    const normalizeAssetValue = vi.fn((_kind: 'domain' | 'ip', value: string) => value.trim().toLowerCase());
    const normalizeNtype = vi.fn((value: string) => value.trim().toLowerCase());
    const validateIpAssetRefOrThrow = vi.fn();
    const service = new InventoryNoteQueryService(db as never, {
      normalizeAssetValue,
      validateIpAssetRefOrThrow,
      normalizeNtype,
    });

    const result = await service.queryNotes({
      userId: 'user-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        assetRef: { kind: 'domain', value: ' App.Example.Test ' },
        ntype: 'HTTP.',
        since: '2026-06-01T00:00:00.000Z',
        limit: 25,
      },
    });

    expect(normalizeAssetValue).toHaveBeenCalledWith('domain', ' App.Example.Test ');
    expect(normalizeNtype).toHaveBeenCalledWith('HTTP.');
    expect(validateIpAssetRefOrThrow).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(chains[0]?.limit).toHaveBeenCalledWith(1);
    expect(chains[1]?.limit).toHaveBeenCalledWith(25);
    expect(result).toEqual({
      notes: [
        {
          id: 'note-1',
          assetId: 'asset-1',
          ntype: 'http.endpoint',
          title: null,
          data: { url: 'https://app.example.test' },
          confidence: null,
          firstSeenAt: '2026-06-11T00:00:00.000Z',
          lastSeenAt: '2026-06-12T00:00:00.000Z',
        },
      ],
      totalCount: 1,
    });
  });

  it('returns no notes when an assetRef does not resolve', async () => {
    const { db } = createQueuedDb([[]]);
    const validateIpAssetRefOrThrow = vi.fn();
    const service = new InventoryNoteQueryService(db as never, {
      normalizeAssetValue: (_kind, value) => value,
      validateIpAssetRefOrThrow,
      normalizeNtype: (value) => value,
    });

    const result = await service.queryNotes({
      userId: 'user-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        assetRef: { kind: 'ip', value: '192.0.2.10' },
      },
    });

    expect(validateIpAssetRefOrThrow).toHaveBeenCalledWith('192.0.2.10', 'query_notes');
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ notes: [], totalCount: 0 });
  });

  it('filters strategic compliance notes to the active framework', async () => {
    const { db } = createQueuedDb([
      [
        {
          id: 'note-hipaa',
          assetId: null,
          ntype: 'run.digest',
          title: null,
          data: {
            workflowDiscipline: 'compliance',
            frameworkKey: 'hipaa',
            goal: 'HIPAA readiness',
          },
          confidence: null,
          firstSeenAt: new Date('2026-06-11T00:00:00.000Z'),
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
        {
          id: 'note-pci',
          assetId: null,
          ntype: 'run.digest',
          title: null,
          data: {
            workflowDiscipline: 'compliance',
            frameworkKey: 'pci_dss',
            goal: 'PCI readiness',
          },
          confidence: null,
          firstSeenAt: new Date('2026-06-11T00:00:00.000Z'),
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
        {
          id: 'note-scan',
          assetId: null,
          ntype: 'scan.coverage',
          title: null,
          data: { family: 'broad-surface', status: 'completed' },
          confidence: null,
          firstSeenAt: new Date('2026-06-11T00:00:00.000Z'),
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
      ],
    ]);
    const service = new InventoryNoteQueryService(db as never, {
      normalizeAssetValue: (_kind, value) => value,
      validateIpAssetRefOrThrow: vi.fn(),
      normalizeNtype: (value) => value.trim().toLowerCase(),
    });

    const result = await service.queryNotes({
      userId: 'user-1',
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        workflowDiscipline: 'compliance',
        activeComplianceFrameworkKey: 'pci_dss',
      },
      input: { limit: 25 },
    });

    expect(result.notes.map((note) => note.id)).toEqual(['note-pci', 'note-scan']);
    expect(JSON.stringify(result)).not.toContain('HIPAA readiness');
  });
});
