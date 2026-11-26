import { describe, expect, it, vi } from 'vitest';

import {
  expandGenericScannerRows,
  extractCodeLocationsFromScannerRow,
  ingestGenericScannerFindings,
} from '@/domains/security-ops/tools/ingestion/ingestors/genericScanner';
import type { IngestSummary, ScannerSeverity } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: string, artifactPath: string): IngestSummary => ({
  parser: parser as IngestSummary['parser'],
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

describe('generic scanner ingestors', () => {
  it('expands semgrep SARIF rows and code locations', async () => {
    const artifact = { relativePath: 'semgrep.sarif', absolutePath: 'semgrep.sarif' };

    const rows = await expandGenericScannerRows('semgrep', artifact, {
      readArtifactJson: vi.fn().mockResolvedValue({
        runs: [
          {
            results: [
              {
                ruleId: 'typescript.lang.security.audit',
                message: 'Unsafe pattern',
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/app.ts' },
                      region: { startLine: 12 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      readArtifactJsonLines: vi.fn(),
      readArtifactText: vi.fn(),
      isRecord,
      getString,
      toNonNegativeInt: (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        title: 'Unsafe pattern',
        severity: 'medium',
        ruleId: 'typescript.lang.security.audit',
        file: 'src/app.ts',
        startLine: 12,
        endLine: 12,
      }),
    ]);
    expect(extractCodeLocationsFromScannerRow('semgrep', rows[0]!, {
      getString,
      toNonNegativeInt: (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
      },
    })).toEqual([
      expect.objectContaining({
        pathKind: 'workspace',
        filePath: 'src/app.ts',
        startLine: 12,
        endLine: 12,
        label: 'typescript.lang.security.audit',
      }),
    ]);
  });

  it('creates findings for secret scanners even when severity normalizes to info', async () => {
    const artifact = { relativePath: 'gitleaks.json', absolutePath: 'gitleaks.json' };
    const recordScannerObservation = vi.fn().mockResolvedValue({ created: true });
    const reportScannerFinding = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestGenericScannerFindings(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: {
          parser: 'gitleaks',
          rootAssetRef: { kind: 'domain', value: 'example.com' },
        },
        parser: 'gitleaks',
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactJson: vi.fn().mockResolvedValue([
          { title: 'Leaked token', file: 'config.env', severity: 'info', ruleId: 'secret' },
        ]),
        readArtifactJsonLines: vi.fn(),
        readArtifactText: vi.fn(),
        isRecord,
        getString,
        normalizeOptionalToolText: (value) => (value && value.trim() ? value.trim() : undefined),
        toNonNegativeInt: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
        },
        stableStringify: JSON.stringify,
        assetRefFromScannerValue: vi.fn(),
        normalizeScannerSeverity: (): ScannerSeverity => 'info',
        extractScannerCveIds: vi.fn(() => []),
        extractScannerCweIds: vi.fn(() => []),
        recordScannerObservation,
        reportScannerFinding,
        warn: vi.fn(),
      },
    );

    expect(recordScannerObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        parser: 'gitleaks',
        title: 'Leaked token',
        severity: 'info',
      }),
    );
    expect(reportScannerFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        parser: 'gitleaks',
        title: 'Leaked token',
        severity: 'low',
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        observationsCreated: 1,
        findingsCreated: 1,
      }),
    );
  });
});
