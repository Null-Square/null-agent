import { describe, expect, it, vi } from 'vitest';

import { ingestFfufArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/ffuf';
import type { IngestSummary } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'ffuf', artifactPath: string): IngestSummary => ({
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

describe('ingestFfufArtifact', () => {
  it('records high-signal endpoints and suppresses duplicates', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/ffuf/ffuf.json',
      absolutePath: 'workspace/.artifacts/scans/ffuf/ffuf.json',
    };
    const reportNote = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestFfufArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'ffuf' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactJson: vi.fn().mockResolvedValue({
          results: [
            { url: 'https://api.example.com/api/users', status: 200, length: 123 },
            { url: 'https://api.example.com/api/users', status: 200, length: 123 },
            { url: '' },
          ],
        }),
        isRecord: (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        toNonNegativeInt: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
        },
        normalizeFfufEndpointUrl: (rawUrl) => rawUrl
          ? { url: rawUrl, dedupeKey: rawUrl.toLowerCase(), pathname: new URL(rawUrl).pathname }
          : undefined,
        ffufResponseSignature: (entry) => `status=${String(entry.status)} length=${String(entry.length)}`,
        isHighSignalFfufPath: (pathname) => pathname.startsWith('/api/'),
        incrementIngestNoise: (ingestSummary, reason) => {
          ingestSummary.suppressed += 1;
          ingestSummary.noise[reason] = (ingestSummary.noise[reason] ?? 0) + 1;
        },
        noisyClusterMinSize: 8,
        noisyClusterRatio: 0.6,
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
        input: expect.objectContaining({
          ntype: 'http.endpoint',
          data: expect.objectContaining({
            url: 'https://api.example.com/api/users',
            method: 'GET',
            statusCode: 200,
            signal: 'high',
          }),
          confidence: 0.7,
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        endpointNotesCreated: 1,
        duplicates: 1,
        suppressed: 1,
        noise: { duplicate_normalized_endpoint: 1 },
        skipped: 1,
      }),
    );
  });
});
