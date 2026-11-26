import { describe, expect, it, vi } from 'vitest';

import { ingestHttpxArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/httpx';
import type { IngestSummary, ScannerAssetRef } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'httpx', artifactPath: string): IngestSummary => ({
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

describe('ingestHttpxArtifact', () => {
  it('records assets, services, endpoints, and tech fingerprints', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/httpx/httpx.jsonl',
      absolutePath: 'workspace/.artifacts/scans/httpx/httpx.jsonl',
    };
    const reportService = vi.fn().mockResolvedValue({ created: true });
    const reportNote = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestHttpxArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'httpx' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        forEachArtifactLine: async (_artifact, onLine) => {
          await onLine(JSON.stringify({
            url: 'https://api.example.com/users',
            method: 'get',
            status_code: 200,
            title: 'Users',
            webserver: 'nginx/1.25',
            tech: ['React'],
          }), 1);
          await onLine(JSON.stringify({
            url: 'https://api.example.com/users',
            method: 'GET',
            status_code: 200,
            tech: ['React'],
          }), 2);
        },
        isRecord: (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        normalizeArtifactHost: (value) => value?.trim().toLowerCase(),
        normalizePort: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
        },
        toNonNegativeInt: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
        },
        detectAssetKind: () => 'domain',
        splitProductVersion: (value) => {
          const [product, version] = value.split('/');
          return { product: product ?? '', ...(version ? { version } : {}) };
        },
        extractHttpxTechFingerprints: () => [{ product: 'React' }],
        ensureIngestedAsset: async (params) => {
          const assetRef = params.assetRef as ScannerAssetRef;
          const key = `${assetRef.kind}:${assetRef.value}`;
          if (params.seenAssets.has(key)) {
            return;
          }
          params.seenAssets.add(key);
          params.summary.assetsCreated += 1;
        },
        reportService,
        reportNote,
      },
    );

    expect(reportService).toHaveBeenCalledTimes(1);
    expect(reportService).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          assetRef: { kind: 'domain', value: 'api.example.com' },
          protocol: 'https',
          port: 443,
          product: 'nginx',
          version: '1.25',
          versionReadMethod: 'http_banner',
        }),
      }),
    );
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ntype: 'http.endpoint',
          data: expect.objectContaining({
            url: 'https://api.example.com/users',
            method: 'GET',
            statusCode: 200,
          }),
        }),
      }),
    );
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        componentObservationSource: 'httpx',
        input: expect.objectContaining({
          ntype: 'tech.fingerprint',
          data: { product: 'React' },
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        assetsCreated: 1,
        servicesCreated: 1,
        endpointNotesCreated: 1,
        techNotesCreated: 1,
      }),
    );
  });
});
