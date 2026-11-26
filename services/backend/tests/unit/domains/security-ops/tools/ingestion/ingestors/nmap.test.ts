import { describe, expect, it, vi } from 'vitest';

import { ingestNmapArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/nmap';
import type { IngestSummary, ScannerAssetRef } from '@/domains/security-ops/tools/ingestion/types';

const createSummary = (parser: 'nmap', artifactPath: string): IngestSummary => ({
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

describe('ingestNmapArtifact', () => {
  it('records assets and services for open nmap ports', async () => {
    const artifact = {
      relativePath: '.artifacts/scans/nmap/nmap.xml',
      absolutePath: 'workspace/.artifacts/scans/nmap/nmap.xml',
    };
    const reportService = vi.fn().mockResolvedValue({ created: true });

    const summary = await ingestNmapArtifact(
      {
        userId: 'user-1',
        workspaceDir: 'workspace',
        sessionId: 'session-1',
        parsed: { parser: 'nmap' },
      },
      {
        createIngestSummary: createSummary,
        resolveScannerArtifactPath: vi.fn().mockResolvedValue(artifact),
        readArtifactText: vi.fn().mockResolvedValue(`
          <nmaprun>
            <host>
              <address addr="192.0.2.10"/>
              <hostnames><hostname name="api.example.com"/></hostnames>
              <ports>
                <port protocol="tcp" portid="443">
                  <state state="open"/>
                  <service name="https" product="nginx" version="1.25"/>
                </port>
                <port protocol="tcp" portid="22">
                  <state state="closed"/>
                </port>
              </ports>
            </host>
            <host><ports></ports></host>
          </nmaprun>
        `),
        normalizeArtifactHost: (value) => value?.trim().toLowerCase(),
        normalizePort: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          protocol: 'tcp',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25',
          versionReadMethod: 'service_probe',
          evidence: [{ path: artifact.relativePath, label: 'nmap artifact' }],
        },
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
