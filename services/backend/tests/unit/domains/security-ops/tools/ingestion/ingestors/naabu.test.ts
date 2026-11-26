import { describe, expect, it, vi } from 'vitest';

import { ingestNaabuArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/naabu';
import type { IngestSummary, ScannerAssetRef } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'naabu', artifactPath: string): IngestSummary => ({
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

describe('ingestNaabuArtifact', () => {
  it('records unique services and skips malformed rows', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/naabu/naabu.txt',
      absolutePath: 'workspace/.artifacts/scans/naabu/naabu.txt',
    };
    const lines = [
      '{"host":"api.example.com","port":443,"protocol":"udp"}',
      '{"host":"api.example.com","port":443,"protocol":"udp"}',
      'not-a-host-port',
    ];
    const reportService = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestNaabuArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'naabu' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        forEachArtifactLine: async (_artifact, onLine) => {
          for (const [index, line] of lines.entries()) {
            await onLine(line, index + 1);
          }
        },
        isRecord: (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        normalizeArtifactHost: (value) => value?.trim().toLowerCase(),
        normalizePort: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
        },
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        parseHostPortLine: (line) => {
          const [host, port] = line.split(':');
          const parsedPort = Number(port);
          return host && Number.isInteger(parsedPort) ? { host, port: parsedPort } : undefined;
        },
        detectAssetKind: () => 'domain',
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
      },
    );

    expect(reportService).toHaveBeenCalledTimes(1);
    expect(reportService).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          assetRef: { kind: 'domain', value: 'api.example.com' },
          protocol: 'udp',
          port: 443,
          evidence: [{ path: artifact.relativePath, label: 'naabu artifact' }],
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        assetsCreated: 1,
        servicesCreated: 1,
        skipped: 1,
      }),
    );
  });
});
