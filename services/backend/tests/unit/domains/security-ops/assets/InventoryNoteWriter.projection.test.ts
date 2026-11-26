import { describe, expect, it, vi } from 'vitest';

import { InventoryNoteWriter } from '@/domains/security-ops/assets/InventoryNoteWriter';

/**
 * The projection from `tech.fingerprint` notes into the typed component
 * inventory. The note remains the agent's narrative record; this is the
 * matchable fact derived from it, and it is the only reason Threat Watch can
 * ask "who runs WordPress 6.4.2" at all.
 */
const createWriter = (recordComponentObservation?: ReturnType<typeof vi.fn>) => {
  const insertCalls: Array<Record<string, unknown>> = [];

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn(() => Promise.resolve([])),
  };

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        insertCalls.push({ table, values });
        return {
          returning: vi.fn(() => Promise.resolve([{ id: 'note-1' }])),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),
  };

  const writer = new InventoryNoteWriter(db as never, {
    inventoryProjection: {} as never,
    now: () => new Date('2026-03-01T00:00:00.000Z'),
    normalizeSessionId: (raw) => raw,
    normalizeNtype: (raw) => raw.trim().toLowerCase(),
    normalizeAssetValue: (_kind, value) => value.trim().toLowerCase(),
    normalizeToolText: (value) => value.trim(),
    normalizeOptionalToolText: (value) => value?.trim(),
    normalizeAssetRefForHost: ({ assetRef }) => assetRef,
    extractHostnameFromUrl: () => undefined,
    pruneNullishDeep: (value) => value,
    buildReportNoteValidationError: (detail) => new Error(detail),
    dedupeKeyForNtype: (_ntype, data) => JSON.stringify(data),
    mergeReportNoteData: (_ntype, _existing, incoming) => incoming,
    mergeEvidenceWithExcerptsByPath: (_existing, incoming) => incoming,
    isUniqueViolation: () => false,
    resolveEvidenceWithExcerpts: async () => [],
    upsertAsset: async () => ({ assetId: 'asset-1' }),
    updateAssetLastScannedAt: async () => {},
    incrementRunCounter: async () => {},
    ...(recordComponentObservation ? { recordComponentObservation } : {}),
  });

  return { writer, db, insertCalls };
};

const reportTechFingerprint = (
  writer: InventoryNoteWriter,
  data: Record<string, unknown>,
) =>
  writer.reportNote({
    userId: 'user-1',
    workspaceDir: 'workspace',
    sessionId: 'session-1',
    context: { organizationId: 'org-1', scopeId: 'scope-1' },
    input: {
      assetRef: { kind: 'domain', value: 'example.com' },
      ntype: 'tech.fingerprint',
      data,
      confidence: 0.9,
    },
  });

describe('InventoryNoteWriter component projection', () => {
  it('projects a tech fingerprint into the component inventory', async () => {
    const record = vi.fn().mockResolvedValue({ status: 'recorded' });
    const { writer } = createWriter(record);

    await reportTechFingerprint(writer, {
      product: 'WordPress',
      version: '6.4.2',
      versionReadMethod: 'application_fingerprint',
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        assetId: 'asset-1',
        scopeId: 'scope-1',
        observedByUserId: 'user-1',
        sessionId: 'session-1',
        // Lowercased upstream by the note writer so notes dedupe across
        // scanners that disagree on casing; alias lookup normalizes anyway.
        product: 'wordpress',
        version: '6.4.2',
        versionReadMethod: 'application_fingerprint',
        confidence: 0.9,
      }),
    );
  });

  it('projects a fingerprint that carries no version', async () => {
    // Still worth recording: it advances the bounded version-acquisition
    // ladder without creating any exposure match.
    const record = vi.fn().mockResolvedValue({ status: 'recorded' });
    const { writer } = createWriter(record);

    await reportTechFingerprint(writer, { product: 'Cloudflare' });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'cloudflare', version: null }),
    );
  });

  it('does not project other note types', async () => {
    const record = vi.fn();
    const { writer } = createWriter(record);

    await writer.reportNote({
      userId: 'user-1',
      workspaceDir: 'workspace',
      context: { organizationId: 'org-1', scopeId: 'scope-1' },
      input: {
        assetRef: { kind: 'domain', value: 'example.com' },
        ntype: 'dns.subdomain',
        data: { hostname: 'api.example.com' },
      },
    });

    expect(record).not.toHaveBeenCalled();
  });

  it('still writes the note when the projection throws', async () => {
    // The note is the agent's record of what it saw and must land regardless.
    // A missing projection costs a match; a thrown error would cost the
    // observation itself.
    const record = vi.fn().mockRejectedValue(new Error('component write failed'));
    const { writer } = createWriter(record);

    await expect(
      reportTechFingerprint(writer, { product: 'nginx', version: '1.18.0' }),
    ).resolves.toMatchObject({ noteId: 'note-1', created: true });
  });

  it('works when no projection is configured at all', async () => {
    const { writer } = createWriter();

    await expect(
      reportTechFingerprint(writer, { product: 'nginx', version: '1.18.0' }),
    ).resolves.toMatchObject({ noteId: 'note-1' });
  });
});
