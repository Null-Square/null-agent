import { describe, expect, it, vi } from 'vitest';

import { ingestOpenApiArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/openapi';
import type { IngestSummary, ScannerAssetRef } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'openapi', artifactPath: string): IngestSummary => ({
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const extractParameters = (value: unknown): Array<{ name: string; in?: string }> =>
  Array.isArray(value)
    ? value
        .filter(isRecord)
        .map((parameter) => {
          const name = getString(parameter['name']);
          if (!name) {
            return undefined;
          }
          const location = getString(parameter['in']);
          return { name, ...(location ? { in: location } : {}) };
        })
        .filter((parameter): parameter is { name: string; in?: string } => parameter !== undefined)
    : [];

describe('ingestOpenApiArtifact', () => {
  it('records endpoints, emits validation leads, and caps excess unique leads', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/openapi/openapi.json',
      absolutePath: 'workspace/.artifacts/scans/openapi/openapi.json',
    };
    const reportNote = vi.fn().mockResolvedValue({ created: true });
    const rootAssetRef: ScannerAssetRef = { kind: 'domain', value: 'api.example.com' };

    const summary = await ingestOpenApiArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'openapi', rootAssetRef },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readOpenApiDocument: vi.fn().mockResolvedValue({
          openapi: '3.0.0',
          paths: {
            '/users/{userId}': {
              parameters: [{ name: 'userId', in: 'path' }],
              get: {
                summary: 'Get user',
                tags: ['users'],
                parameters: [{ name: 'verbose', in: 'query' }],
              },
            },
          },
        }),
        isRecord,
        getString,
        resolveOpenApiBaseUrl: () => 'https://api.example.com',
        extractOpenApiParameters: extractParameters,
        extractOpenApiBodyParams: () => [],
        buildOpenApiEndpointUrl: (baseUrl, routePath) => `${baseUrl}${routePath}`,
        assetRefFromScannerValue: () => rootAssetRef,
        extractOpenApiStringArray: (value) =>
          Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [],
        describeOpenApiAuthHint: () => 'unspecified',
        deriveOpenApiValidationLeads: () => [
          {
            riskFamily: 'idor',
            target: 'https://api.example.com/users/{userId}',
            method: 'GET',
            path: '/users/{userId}',
            parameter: 'userId',
          },
          {
            riskFamily: 'information-disclosure',
            target: 'https://api.example.com/users/{userId}',
            method: 'GET',
            path: '/users/{userId}',
          },
        ],
        validationLeadCap: 1,
        reportNote,
      },
    );

    expect(reportNote).toHaveBeenCalledTimes(2);
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          assetRef: rootAssetRef,
          ntype: 'http.endpoint',
          title: 'Get user',
          data: expect.objectContaining({
            url: 'https://api.example.com/users/{userId}',
            method: 'GET',
            source: 'openapi',
            sourceArtifact: artifact.relativePath,
            pathParams: ['userId'],
            queryParams: ['verbose'],
            tags: ['users'],
          }),
        }),
      }),
    );
    expect(reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ntype: 'validation.lead',
          title: 'idor lead for GET /users/{userId}',
          data: expect.objectContaining({
            riskFamily: 'idor',
            parameter: 'userId',
          }),
        }),
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        endpointNotesCreated: 1,
        observationsCreated: 1,
        skipped: 1,
      }),
    );
  });
});
