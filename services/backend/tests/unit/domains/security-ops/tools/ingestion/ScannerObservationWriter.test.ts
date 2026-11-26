import { describe, expect, it, vi } from 'vitest';

import { ScannerObservationWriter } from '@/domains/security-ops/tools/ingestion/ScannerObservationWriter';

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

describe('ScannerObservationWriter', () => {
  it('creates scanner observations with asset upsert and resolved evidence', async () => {
    const insert = createInsert([{ id: 'observation-1' }]);
    const db = {
      select: vi.fn(() => createSelect([])),
      insert: vi.fn(() => insert),
    };
    const upsertAsset = vi.fn(async () => ({ assetId: 'asset-1' }));
    const writer = new ScannerObservationWriter(db as never, {
      now: () => new Date('2026-06-12T00:00:00.000Z'),
      normalizeSessionId: (value) => value,
      normalizeToolText: (value) => value.trim(),
      pruneNullishDeep: (value) => value,
      mergeEvidenceWithExcerptsByPath: (existing, incoming) => [...(existing ?? []), ...incoming],
      resolveEvidenceWithExcerpts: vi.fn(async (
        _workspaceDir: string,
        evidence: Array<{ path: string; label?: string; excerpt?: string }>,
      ) =>
        evidence.map((entry) => ({ ...entry, excerpt: entry.excerpt ?? 'excerpt' })),
      ),
      upsertAsset,
    });

    const result = await writer.recordObservation({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: '11111111-1111-4111-8111-111111111111',
      context: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      },
      parser: 'nuclei',
      artifactPath: '.artifacts/nuclei.jsonl',
      assetRef: { kind: 'domain', value: 'app.example.test' },
      observationType: 'template_match',
      title: ' Nuclei match ',
      severity: 'medium',
      confidence: 0.7,
      dedupeParts: ['template-id', { url: 'https://app.example.test' }],
      data: { template: 'template-id' },
      evidence: [{ path: '.artifacts/nuclei.jsonl', label: 'nuclei artifact' }],
    });

    expect(result).toEqual({ observationId: 'observation-1', created: true });
    expect(upsertAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          kind: 'domain',
          value: 'app.example.test',
          evidence: [{ path: '.artifacts/nuclei.jsonl', label: 'nuclei artifact' }],
        },
      }),
    );
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        assetId: 'asset-1',
        parser: 'nuclei',
        title: 'Nuclei match',
        severity: 'medium',
        evidence: [{ path: '.artifacts/nuclei.jsonl', label: 'nuclei artifact', excerpt: 'excerpt' }],
        dedupeKey: expect.any(String),
      }),
    );
  });
});
