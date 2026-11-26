import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScannerArtifactIO } from '@/domains/security-ops/tools/ingestion/ScannerArtifactIO';

describe('ScannerArtifactIO', () => {
  let workspaceDir: string;
  let io: ScannerArtifactIO<'httpx' | 'openapi'>;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'scanner-artifact-'));
    io = new ScannerArtifactIO();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('discovers the parser-specific artifact under .artifacts/scans', async () => {
    const scanDir = join(workspaceDir, '.artifacts', 'scans', 'httpx');
    await mkdir(scanDir, { recursive: true });
    await writeFile(join(scanDir, 'result.jsonl'), '{"url":"https://example.com"}\n');

    await expect(io.resolveScannerArtifactPath(workspaceDir, { parser: 'httpx' })).resolves.toEqual({
      relativePath: '.artifacts/scans/httpx/result.jsonl',
      absolutePath: join(scanDir, 'result.jsonl'),
    });
  });

  it('iterates trimmed non-empty artifact lines with original line numbers', async () => {
    const artifactPath = join(workspaceDir, 'httpx.jsonl');
    await writeFile(artifactPath, ' first \n\n second \n');
    const seen: Array<{ line: string; lineNumber: number }> = [];

    await io.forEachArtifactLine(
      { relativePath: 'httpx.jsonl', absolutePath: artifactPath },
      async (line, lineNumber) => {
        seen.push({ line, lineNumber });
      },
    );

    expect(seen).toEqual([
      { line: 'first', lineNumber: 1 },
      { line: 'second', lineNumber: 3 },
    ]);
  });

  it('reads OpenAPI YAML documents', async () => {
    const artifactPath = join(workspaceDir, 'openapi.yaml');
    await writeFile(
      artifactPath,
      [
        'openapi: 3.0.0',
        'paths:',
        '  /health:',
        '    get:',
        '      summary: Health',
      ].join('\n'),
    );

    await expect(
      io.readOpenApiDocument({ relativePath: 'openapi.yaml', absolutePath: artifactPath }),
    ).resolves.toEqual(
      expect.objectContaining({
        openapi: '3.0.0',
        paths: expect.objectContaining({
          '/health': expect.any(Object),
        }),
      }),
    );
  });

  it('reads valid JSONL rows and ignores malformed scanner lines', async () => {
    const artifactPath = join(workspaceDir, 'scanner.jsonl');
    await writeFile(
      artifactPath,
      [
        '{"url":"https://one.example"}',
        'scanner warning',
        '{"url":',
        '{"url":"https://two.example"}',
      ].join('\n'),
    );

    await expect(
      io.readArtifactJsonLines({ relativePath: 'scanner.jsonl', absolutePath: artifactPath }),
    ).resolves.toEqual([
      { url: 'https://one.example' },
      { url: 'https://two.example' },
    ]);
  });
});
