import { describe, expect, it, vi } from 'vitest';

import { assetScopeMemberships } from '@/db/schema';
import { AssetIngestionWriter } from '@/domains/security-ops/assets/AssetIngestionWriter';

const createDb = (params: {
  selectResults: unknown[];
  insertReturningResults?: unknown[];
}) => {
  const selectResults = [...params.selectResults];
  const insertReturningResults = [...(params.insertReturningResults ?? [])];
  const updateCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];

  const next = (queue: unknown[], label: string) => {
    if (queue.length === 0) throw new Error(`No queued ${label} result`);
    return queue.shift();
  };

  const createSelectChain = () => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(next(selectResults, 'select'))),
      then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
        Promise.resolve(next(selectResults, 'select')).then(onfulfilled, onrejected),
    };
    return chain;
  };

  const db = {
    select: vi.fn(() => createSelectChain()),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const call: Record<string, unknown> = { table, values };
        insertCalls.push(call);
        return {
          returning: vi.fn(() => Promise.resolve(next(insertReturningResults, 'insert returning'))),
          onConflictDoUpdate: vi.fn((payload: unknown) => {
            call.onConflictDoUpdate = payload;
            return Promise.resolve();
          }),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn((where: unknown) => {
          updateCalls.push({ table, values, where });
          return Promise.resolve();
        }),
      })),
    })),
  };

  return { db, insertCalls, updateCalls };
};

const createWriter = (db: unknown, resolveEvidenceRefs = vi.fn().mockResolvedValue([])) =>
  new AssetIngestionWriter({
    db: db as never,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    resolveEvidenceRefs,
    normalizeAssetValue: (kind, value) => (kind === 'domain' ? value.trim().toLowerCase() : value.trim()),
    mergeStringSet: (existing, incoming) =>
      Array.from(new Set([...(existing ?? []), ...(incoming ?? [])].map((value) => value.trim()).filter(Boolean))),
    mergeEvidenceByPath: (existing, incoming) => {
      const map = new Map<string, { path: string; label?: string }>();
      for (const item of existing ?? []) map.set(item.path, item);
      for (const item of incoming ?? []) map.set(item.path, item);
      return Array.from(map.values());
    },
    isSubdomainOf: (candidate, root) => candidate.length > root.length && candidate.endsWith(`.${root}`),
    isUniqueViolation: () => false,
    isMissingSessionObservationForeignKey: () => false,
  });

describe('AssetIngestionWriter', () => {
  it('inserts a new asset and increments inventory count', async () => {
    const { db, insertCalls, updateCalls } = createDb({
      selectResults: [
        [],
        [],
      ],
      insertReturningResults: [[{ id: 'asset-1' }]],
    });
    const resolveEvidenceRefs = vi.fn().mockResolvedValue([{ path: '.artifacts/proof.txt', label: 'Proof' }]);
    const writer = createWriter(db, resolveEvidenceRefs);

    await expect(
      writer.upsertAsset({
        userId: 'user-1',
        workspaceDir: 'workspace',
        context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
        input: {
          kind: 'domain',
          value: ' API.EXAMPLE.COM ',
          tags: [' api '],
          evidence: [{ path: '.artifacts/proof.txt', label: 'Proof' }],
        },
      }),
    ).resolves.toEqual({ assetId: 'asset-1', created: true });

    expect(resolveEvidenceRefs).toHaveBeenCalledWith('workspace', [{ path: '.artifacts/proof.txt', label: 'Proof' }]);
    expect(insertCalls[0]?.values).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        userId: 'user-1',
        kind: 'domain',
        value: 'api.example.com',
        tags: ['api'],
        evidence: [{ path: '.artifacts/proof.txt', label: 'Proof' }],
      }),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('updates an existing asset with merged metadata', async () => {
    const { db, updateCalls } = createDb({
      selectResults: [
        [{ type: 'domain', value: 'example.com' }],
        [{
          id: 'asset-1',
          tags: ['old'],
          evidence: [{ path: '.artifacts/old.txt', label: 'Old' }],
          parentAssetId: null,
        }],
      ],
    });
    const writer = createWriter(
      db,
      vi.fn().mockResolvedValue([{ path: '.artifacts/new.txt', label: 'New' }]),
    );

    await expect(
      writer.upsertAsset({
        userId: 'user-1',
        workspaceDir: 'workspace',
        context: { organizationId: 'org-1', scopeId: 'scope-1' },
        input: {
          kind: 'domain',
          value: 'example.com',
          tags: ['new'],
          evidence: [{ path: '.artifacts/new.txt', label: 'New' }],
        },
      }),
    ).resolves.toEqual({ assetId: 'asset-1', created: false });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toEqual(
      expect.objectContaining({
        tags: ['old', 'new'],
        evidence: [
          { path: '.artifacts/old.txt', label: 'Old' },
          { path: '.artifacts/new.txt', label: 'New' },
        ],
      }),
    );

    // Organization is identity and scope is a membership, so re-observing an
    // asset must never rewrite either. Writing them here is what let an asset
    // change tenancy, and migrate to whichever scope observed it last.
    expect(updateCalls[0]?.values).not.toHaveProperty('organizationId');
    expect(updateCalls[0]?.values).not.toHaveProperty('scopeId');
  });

  it('records scope membership instead of moving the asset to the observing scope', async () => {
    const { db, insertCalls } = createDb({
      selectResults: [
        [{ type: 'domain', value: 'example.com' }],
        [{
          id: 'asset-1',
          tags: [],
          evidence: [],
          parentAssetId: null,
        }],
      ],
    });
    const writer = createWriter(db, vi.fn().mockResolvedValue([]));

    await writer.upsertAsset({
      userId: 'user-1',
      workspaceDir: 'workspace',
      // A second scope observing an asset that another scope discovered.
      context: { organizationId: 'org-1', scopeId: 'scope-2' },
      input: { kind: 'domain', value: 'example.com' },
    });

    const membershipInsert = insertCalls.find(
      (call) => call.table === assetScopeMemberships,
    );

    expect(membershipInsert?.values).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        assetId: 'asset-1',
        scopeId: 'scope-2',
      }),
    );
    // Upsert, not select-then-insert: the executor is often a transaction, and
    // a unique violation caught in application code would already have aborted it.
    expect(membershipInsert?.onConflictDoUpdate).toBeDefined();
  });
});
