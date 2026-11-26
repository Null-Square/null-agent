import { describe, expect, it, vi } from 'vitest';

import { ingestKatanaArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/katana';
import type { IngestSummary } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'katana', artifactPath: string): IngestSummary => ({
  parser,
  artifactPath,
  assetsCreated: 0,
  assetsTouched: 0,
  servicesCreated: 0,
  servicesTouched: 0,
  subdomainNotesCreated: 0,
  subdomainNotesTouched: 0,
  endpointNotesCreated: 0,
  endpointNotesTouched: 0,
  techNotesCreated: 0,
  techNotesTouched: 0,
  observationsCreated: 0,
  observationsTouched: 0,
  findingsCreated: 0,
  findingsTouched: 0,
  skipped: 0,
  suppressed: 0,
  duplicates: 0,
  noise: {},
});

describe('ingestKatanaArtifact', () => {
  it('records unique endpoint notes and skips unresolved rows', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/katana/katana.jsonl',
      absolutePath: 'workspace/.artifacts/scans/katana/katana.jsonl',
    };
    const reportNote = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestKatanaArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'katana' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactJsonLines: vi.fn().mockResolvedValue([
          { url: ' https://api.example.com/users ', method: 'post' },
          { endpoint: 'https://api.example.com/users', method: 'POST' },
          { request: '' },
        ]),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        assetRefFromScannerValue: (value) =>
          typeof value === 'string' && value.includes('example.com')
            ? { kind: 'domain', value: 'api.example.com' }
            : undefined,
        reportNote,
      },
    );

    expect(reportNote).toHaveBeenCalledTimes(1);
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          ntype: 'http.endpoint',
          data: {
            url: 'https://api.example.com/users',
            method: 'POST',
            source: 'katana',
          },
          evidence: [{ path: artifact.relativePath, label: 'katana artifact' }],
        },
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        endpointNotesCreated: 1,
        skipped: 1,
      }),
    );
  });

  // Regression: katana's real `-jsonl` output nests the URL under `request.endpoint`,
  // not a top-level `url`. Reading the top level alone skipped every row of a real
  // crawl (skipped 122/2913/98207, endpointNotesCreated 0) since ≤2.2. This asserts
  // the production shape resolves.
  it('resolves the nested request.endpoint shape katana actually emits', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/katana/katana.jsonl',
      absolutePath: 'workspace/.artifacts/scans/katana/katana.jsonl',
    };
    const reportNote = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestKatanaArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'katana' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactJsonLines: vi.fn().mockResolvedValue([
          {
            timestamp: '2026-08-12T17:24:16.865604118Z',
            request: { method: 'GET', endpoint: 'https://api.example.com/users' },
            response: { status_code: 200 },
          },
          {
            request: { method: 'post', endpoint: 'https://api.example.com/users' },
          },
        ]),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        assetRefFromScannerValue: (value) =>
          typeof value === 'string' && value.includes('example.com')
            ? { kind: 'domain', value: 'api.example.com' }
            : undefined,
        reportNote,
      },
    );

    // Both nested rows resolve; the GET/POST split keeps them distinct endpoints.
    expect(reportNote).toHaveBeenCalledTimes(2);
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ntype: 'http.endpoint',
          data: { url: 'https://api.example.com/users', method: 'GET', source: 'katana' },
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({ endpointNotesCreated: 2, skipped: 0 }),
    );
  });
});

const runKatana = async (rows: Record<string, unknown>[]) => {
  const artifact = {
    relativePath: '.artifacts/scans/katana/katana.jsonl',
    absolutePath: 'workspace/.artifacts/scans/katana/katana.jsonl',
  };
  const reportNote = vi.fn().mockResolvedValue({ created: true });

  const summary = await ingestKatanaArtifact(
    { userId: 'user-1', workspaceDir: 'workspace', sessionId: 'session-1', parsed: { parser: 'katana' } },
    {
      createIngestSummary: createSummary,
      resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
      readArtifactJsonLines: vi.fn().mockResolvedValue(rows),
      getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
      normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
      assetRefFromScannerValue: (value) =>
        typeof value === 'string' && value.includes('shop.example.com')
          ? { kind: 'domain' as const, value: 'shop.example.com' }
          : undefined,
      reportNote,
    },
  );

  const techNotes = reportNote.mock.calls
    .map((call) => call[0].input as Record<string, any>)
    .filter((input) => input.ntype === 'tech.fingerprint');

  return { summary, reportNote, techNotes };
};

/**
 * Crawled URLs are the agent's own route to seeing WordPress plugins. Without
 * this the only source that feeds the product cannot see them at all, and a
 * plugin advisory feed would have nothing to match against.
 */
describe('ingestKatanaArtifact — WordPress components', () => {
  it('records a crawled plugin as its own fingerprint, with its version', async () => {
    const { techNotes } = await runKatana([
      { url: 'https://shop.example.com/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.21.4' },
    ]);

    expect(techNotes).toEqual([
      expect.objectContaining({
        ntype: 'tech.fingerprint',
        data: expect.objectContaining({
          product: 'elementor',
          version: '3.21.4',
          category: 'wordpress-plugin',
        }),
      }),
    ]);
  });

  it('distinguishes themes from plugins', async () => {
    const { techNotes } = await runKatana([
      { url: 'https://shop.example.com/wp-content/themes/astra/style.css?ver=4.6.0' },
    ]);

    expect(techNotes[0]?.data).toEqual(
      expect.objectContaining({ product: 'astra', category: 'wordpress-theme' }),
    );
  });

  it('writes one note per plugin however many URLs reference it', async () => {
    const { techNotes } = await runKatana([
      { url: 'https://shop.example.com/wp-content/plugins/elementor/a.js' },
      { url: 'https://shop.example.com/wp-content/plugins/elementor/b.js?ver=3.21.4' },
      { url: 'https://shop.example.com/wp-content/plugins/elementor/c.css' },
    ]);

    expect(techNotes).toHaveLength(1);
    // The best-evidenced sighting wins: only one of those URLs carried a version.
    expect(techNotes[0]?.data.version).toBe('3.21.4');
  });

  it('drops a version several unrelated plugins share', async () => {
    // WordPress substitutes the core version for plugins that enqueue without
    // one, so a value repeated across slugs is core leaking through. Recording
    // it would produce confident matches against software nobody is running.
    const { techNotes } = await runKatana([
      { url: 'https://shop.example.com/wp-content/plugins/elementor/a.js?ver=6.4.2' },
      { url: 'https://shop.example.com/wp-content/plugins/woocommerce/b.js?ver=6.4.2' },
      { url: 'https://shop.example.com/wp-content/plugins/jetpack/c.js?ver=6.4.2' },
    ]);

    expect(techNotes).toHaveLength(3);
    expect(techNotes.every((note) => note.data.version === undefined)).toBe(true);
  });

  it('writes no fingerprints for a site with no WordPress assets', async () => {
    const { techNotes } = await runKatana([{ url: 'https://shop.example.com/about' }]);
    expect(techNotes).toEqual([]);
  });
});
