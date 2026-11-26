import { describe, expect, it } from 'vitest';

import {
  buildFindingReviewMeta,
  buildHttpBodyPreview,
  buildStructuredHttpEvidencePath,
  extractFindingValidationProofBundle,
  redactFindingHttpHeaders,
} from '@/domains/security-ops/findings/findingContracts';

describe('findingContracts helpers', () => {
  it('redacts sensitive headers and truncates large bodies', () => {
    const headers = redactFindingHttpHeaders([
      { name: 'Authorization', value: 'Bearer secret' },
      { name: 'Accept', value: 'application/json' },
      { name: 'Set-Cookie', value: 'session=secret' },
    ]);

    expect(headers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Authorization', value: '[REDACTED]', redacted: true }),
        expect.objectContaining({ name: 'Accept', value: 'application/json' }),
        expect.objectContaining({ name: 'Set-Cookie', value: '[REDACTED]', redacted: true }),
      ]),
    );

    const preview = buildHttpBodyPreview('A'.repeat(17_500));
    expect(preview?.truncated).toBe(true);
    expect(Buffer.byteLength(preview?.text ?? '', 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('builds stable structured HTTP hashes after redaction', () => {
    const left = {
      source: 'browser' as const,
      request: {
        method: 'POST',
        url: 'https://example.com/login',
        headers: redactFindingHttpHeaders([
          { name: 'Authorization', value: 'Bearer first' },
          { name: 'Accept', value: 'application/json' },
        ]),
      },
      response: {
        statusCode: 302,
        headers: redactFindingHttpHeaders([{ name: 'Set-Cookie', value: 'session=one' }]),
      },
    };

    const right = {
      source: 'browser' as const,
      request: {
        method: 'POST',
        url: 'https://example.com/login',
        headers: redactFindingHttpHeaders([
          { name: 'Accept', value: 'application/json' },
          { name: 'Authorization', value: 'Bearer second' },
        ]),
      },
      response: {
        statusCode: 302,
        headers: redactFindingHttpHeaders([{ name: 'Set-Cookie', value: 'session=two' }]),
      },
    };

    expect(buildStructuredHttpEvidencePath(left)).toBe(buildStructuredHttpEvidencePath(right));
  });

  it('builds review meta from mixed evidence states', () => {
    const reviewMeta = buildFindingReviewMeta({
      codeLocations: [
        {
          pathKind: 'repository',
          repository: 'acme/api',
          ref: 'main',
          filePath: 'src/auth/login.ts',
          startLine: 10,
          endLine: 18,
          label: 'Auth handler',
          fixBefore: 'return input;',
          fixAfter: 'return sanitize(input);',
        },
      ],
      evidence: [
        { kind: 'artifact', excerpt: 'proof', fileMissing: false, hasDownloadableArtifact: true },
        { kind: 'http_exchange', excerpt: null, fileMissing: false, hasDownloadableArtifact: false },
      ],
    });

    expect(reviewMeta).toEqual({
      codeLocationCount: 1,
      copyFixPromptReady: true,
      evidenceSummary: {
        total: 2,
        artifactCount: 1,
        downloadableArtifactCount: 1,
        structuredHttpCount: 1,
        excerptCount: 1,
        fileMissingCount: 0,
      },
    });
  });

  it('extracts validation proof bundles from audit evidence refs', () => {
    const proof = extractFindingValidationProofBundle([
      { path: '.artifacts/repro.txt', label: 'proof' },
      {
        kind: 'validation_proof',
        path: 'validation-proof:finding-1:2026-06-12T00:00:00.000Z',
        label: 'Validation proof trail',
        schemaVersion: 1,
        proof: {
          claim: 'The endpoint serves another tenant invoice.',
          evidenceIds: ['http:invoice-proof'],
          replayAttempted: true,
          replayArtifact: '.artifacts/python-session/run/results/replay.json',
          replayReproduced: true,
        },
        obligations: [
          {
            observable: 'Response includes another tenant invoice.',
            status: 'proven',
            evidenceIds: ['http:invoice-proof'],
          },
        ],
        advisoryTriage: {
          verdict: 'agree',
          reason: 'Bound evidence proves the claim.',
          triagedBy: 'inline_validation_advisory',
          evidenceIds: ['http:invoice-proof'],
          flags: [],
        },
      },
    ]);

    expect(proof).toMatchObject({
      proof: {
        claim: 'The endpoint serves another tenant invoice.',
        evidenceIds: ['http:invoice-proof'],
        replayReproduced: true,
      },
      obligations: [
        {
          id: 'obligation-1',
          observable: 'Response includes another tenant invoice.',
          status: 'proven',
        },
      ],
      advisoryTriage: {
        verdict: 'agree',
        triagedBy: 'inline_validation_advisory',
      },
    });
  });
});
