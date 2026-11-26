import { describe, expect, it, vi } from 'vitest';

import { ScannerArtifactIngestionService } from '@/domains/security-ops/tools/ingestion/ScannerArtifactIngestionService';

const createOptions = () => ({
  resolveScannerArtifactPath: vi.fn(async () => ({
    relativePath: '.artifacts/subfinder.jsonl',
    absolutePath: 'C:/workspace/.artifacts/subfinder.jsonl',
  })),
  forEachArtifactLine: vi.fn(async (_artifact, onLine: (line: string, lineNumber: number) => Promise<void>) => {
    await onLine('api.example.test', 1);
  }),
  readArtifactJson: vi.fn(async () => ({})),
  readArtifactJsonLines: vi.fn(async () => []),
  readOpenApiDocument: vi.fn(async () => ({})),
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  getString: (value: unknown) => (typeof value === 'string' ? value : undefined),
  normalizeOptionalToolText: (value: string | undefined) => {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  },
  toNonNegativeInt: () => undefined,
  stableStringify: (value: unknown) => JSON.stringify(value),
  normalizeArtifactHost: (value: string | undefined) => value?.trim().toLowerCase(),
  normalizePort: () => undefined,
  parseHostPortLine: () => undefined,
  detectAssetKind: () => 'domain' as const,
  splitProductVersion: (rawValue: string) => ({ product: rawValue }),
  extractHttpxTechFingerprints: () => [],
  normalizeFfufEndpointUrl: () => undefined,
  ffufResponseSignature: () => '',
  isHighSignalFfufPath: () => false,
  assetRefFromScannerValue: () => undefined,
  normalizeScannerSeverity: () => 'info' as const,
  extractScannerCveIds: () => [],
  extractScannerCweIds: () => [],
  resolveCandidateParentAsset: vi.fn(async () => ({
    assetRef: { kind: 'domain' as const, value: 'example.test' },
    created: true,
  })),
  ensureIngestedAsset: vi.fn(async () => undefined),
  reportService: vi.fn(async () => ({ created: true })),
  reportNote: vi.fn(async () => ({ created: true })),
  recordScannerObservation: vi.fn(async () => ({ created: true })),
  reportScannerFinding: vi.fn(async () => ({ created: true })),
  resolveOpenApiBaseUrl: () => undefined,
  extractOpenApiParameters: () => [],
  extractOpenApiBodyParams: () => [],
  buildOpenApiEndpointUrl: (_baseUrl: string | undefined, routePath: string) => routePath,
  extractOpenApiStringArray: () => [],
  describeOpenApiAuthHint: () => '',
  deriveOpenApiValidationLeads: () => [],
  warn: vi.fn(),
});

describe('ScannerArtifactIngestionService', () => {
  it('routes scanner artifacts through the registry and preserves partial summaries', async () => {
    const options = createOptions();
    const service = new ScannerArtifactIngestionService(options);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: 'session-1',
      context: { organizationId: 'org-1', scopeId: 'scope-1', runId: 'run-1' },
      input: {
        parser: 'subfinder',
        artifactPath: '.artifacts/subfinder.jsonl',
        partial: true,
      },
    });

    expect(result).toMatchObject({
      parser: 'subfinder',
      artifactPath: '.artifacts/subfinder.jsonl',
      partial: true,
      assetsCreated: 1,
      subdomainNotesCreated: 1,
    });
    expect(options.resolveScannerArtifactPath).toHaveBeenCalledWith(
      'C:/workspace',
      expect.objectContaining({
        parser: 'subfinder',
        artifactPath: '.artifacts/subfinder.jsonl',
      }),
    );
    expect(options.reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ntype: 'dns.subdomain',
          data: { hostname: 'api.example.test' },
        }),
      }),
    );
  });
});
