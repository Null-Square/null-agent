import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  proofEvidenceIdIsResolvable,
  resolveProofEvidenceReference,
} from '@/domains/security-ops/findings/ProofEvidenceReferenceResolver';

describe('resolveProofEvidenceReference', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proof-resolver-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('returns bounded workspace evidence bytes and MIME metadata', async () => {
    await fs.mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, '.artifacts', 'proof.json'), '{"ok":true}');

    const result = await resolveProofEvidenceReference({
      workspaceDir,
      evidenceId: '.artifacts/proof.json',
    });

    expect(result).toMatchObject({
      resolutionStatus: 'resolved',
      sourceType: 'workspace_file',
      redacted: false,
    });
    expect(result.files[0]?.mimeType).toBe('application/json');
    expect(result.files[0]?.content.toString('utf8')).toBe('{"ok":true}');
  });

  it('redacts sensitive headers from structured HTTP history', async () => {
    await fs.writeFile(
      path.join(workspaceDir, '.http-history.ndjson'),
      JSON.stringify({
        id: 'request_123',
        ts: '2026-06-22T10:00:00.000Z',
        request: {
          method: 'GET',
          url: 'https://example.test/admin',
          headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
        },
        status_code: 403,
        body_size: 0,
        body_truncated: false,
        body_preview: '',
        response_body: '',
        response_headers: '',
      }) + '\n',
    );

    const result = await resolveProofEvidenceReference({
      workspaceDir,
      evidenceId: 'http:request_123',
    });
    const text = result.files[0]?.content.toString('utf8') ?? '';

    expect(result).toMatchObject({
      resolutionStatus: 'resolved',
      sourceType: 'http_history',
      redacted: true,
    });
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('Bearer secret');
  });

  it('collects exact raw HTTP artifact files and reports unresolved references', async () => {
    const artifactDir = path.join(workspaceDir, '.artifacts', 'raw-http', 'exchange_1');
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'manifest.json'), '{"id":"exchange_1"}');
    await fs.writeFile(path.join(artifactDir, 'request-1.bin'), Buffer.from([0, 1, 2, 3]));

    const raw = await resolveProofEvidenceReference({
      workspaceDir,
      evidenceId: 'raw-http:exchange_1',
    });
    expect(raw).toMatchObject({
      resolutionStatus: 'resolved',
      sourceType: 'raw_http',
      redacted: false,
    });
    expect(raw.files.map((file) => file.relativePath)).toEqual([
      'manifest.json',
      'request-1.bin',
    ]);

    const missing = await resolveProofEvidenceReference({
      workspaceDir,
      evidenceId: '.artifacts/missing.json',
    });
    expect(missing).toMatchObject({
      resolutionStatus: 'unresolved',
      sourceType: 'unresolved',
    });
  });

  it('keeps oversized files valid for proof while excluding their bytes from portable resolution', async () => {
    await fs.mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });
    const filePath = path.join(workspaceDir, '.artifacts', 'large-proof.bin');
    await fs.writeFile(filePath, Buffer.alloc(0));
    await fs.truncate(filePath, 9 * 1024 * 1024);

    await expect(proofEvidenceIdIsResolvable({
      workspaceDir,
      evidenceId: '.artifacts/large-proof.bin',
    })).resolves.toBe(true);
    const resolution = await resolveProofEvidenceReference({
      workspaceDir,
      evidenceId: '.artifacts/large-proof.bin',
    });
    expect(resolution).toMatchObject({
      resolutionStatus: 'oversized',
      sourceType: 'workspace_file',
      files: [],
    });
  });
});
