import { describe, expect, it, vi } from 'vitest';

import { ingestSubfinderArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/subfinder';
import type { IngestSummary } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'subfinder', artifactPath: string): IngestSummary<'subfinder'> => ({
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

describe('ingestSubfinderArtifact', () => {
  it('records unique subdomain notes under the resolved parent asset', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/subfinder/subfinder.jsonl',
      absolutePath: 'workspace/.artifacts/scans/subfinder/subfinder.jsonl',
    };
    const lines = [
      '{"host":"api.example.com"}',
      'api.example.com',
      '{not-json',
    ];
    const reportNote = vi.fn().mockResolvedValue({ created: true });
    const resolveCandidateParentAsset = vi.fn().mockResolvedValue({
      assetRef: { kind: 'domain', value: 'example.com' },
      created: true,
    });

    const summary = await ingestSubfinderArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'subfinder' },
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
        resolveCandidateParentAsset,
        reportNote,
      },
    );

    expect(resolveCandidateParentAsset).toHaveBeenCalledTimes(1);
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.subdomain',
          data: { hostname: 'api.example.com' },
          evidence: [{ path: artifact.relativePath, label: 'subfinder artifact' }],
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        assetsCreated: 1,
        subdomainNotesCreated: 1,
        skipped: 1,
      }),
    );
  });
});
