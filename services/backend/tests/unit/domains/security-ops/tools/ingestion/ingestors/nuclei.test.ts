import { describe, expect, it, vi } from 'vitest';

import { ingestNucleiArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/nuclei';
import type { IngestSummary, ScannerSeverity } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'nuclei', artifactPath: string): IngestSummary => ({
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

describe('ingestNucleiArtifact', () => {
  it('records observations and findings for non-info nuclei rows', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/nuclei/nuclei.jsonl',
      absolutePath: 'workspace/.artifacts/scans/nuclei/nuclei.jsonl',
    };
    const recordScannerObservation = vi.fn().mockResolvedValue({ created: true });
    const reportScannerFinding = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestNucleiArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'nuclei' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactJsonLines: vi.fn().mockResolvedValue([
          {
            'matched-at': 'https://api.example.com/debug',
            'template-id': 'exposed-debug',
            info: {
              name: 'Exposed debug endpoint',
              severity: 'high',
              classification: {
                cwe: ['CWE-200'],
                cve: 'CVE-2025-0001',
              },
            },
          },
          { info: { severity: 'info' } },
        ]),
        isRecord: (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
        getString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        assetRefFromScannerValue: (value) =>
          typeof value === 'string' && value.includes('example.com')
            ? { kind: 'domain', value: 'api.example.com' }
            : undefined,
        normalizeScannerSeverity: (value): ScannerSeverity =>
          value === 'high' ? 'high' : value === 'info' ? 'info' : 'info',
        extractScannerCveIds: (value) => (typeof value === 'string' ? [value] : []),
        extractScannerCweIds: (value) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []),
        recordScannerObservation,
        reportScannerFinding,
        warn: vi.fn(),
      },
    );

    expect(recordScannerObservation).toHaveBeenCalledTimes(1);
    expect(recordScannerObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        parser: 'nuclei',
        title: 'Exposed debug endpoint',
        severity: 'high',
        confidence: 0.7,
        dedupeParts: ['nuclei', 'exposed-debug', 'https://api.example.com/debug'],
      }),
    );
    expect(reportScannerFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        parser: 'nuclei',
        title: 'Exposed debug endpoint',
        severity: 'high',
        cveIds: ['CVE-2025-0001'],
        cweIds: ['CWE-200'],
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        observationsCreated: 1,
        findingsCreated: 1,
        skipped: 1,
      }),
    );
  });
});
