import { describe, expect, it } from 'vitest';
import {
  buildFindingEvidenceArtifactLookup,
  resolveFindingEvidenceArtifact,
} from '@/domains/security-ops/evidence/findingEvidenceArtifacts';

describe('findingEvidenceArtifacts', () => {
  it('resolves artifact download by matching originalName path', () => {
    const lookup = buildFindingEvidenceArtifactLookup([
      {
        id: 'artifact-1',
        sessionId: 'session-1',
        originalName: '.artifacts/mail_headers.txt',
        filePath: 's3://bucket/session-1/.artifacts/mail_headers.txt',
      },
    ]);

    const resolved = resolveFindingEvidenceArtifact(
      {
        sessionId: 'session-1',
        path: '/workspace/.artifacts/mail_headers.txt',
        fileMissing: true,
      },
      lookup,
    );

    expect(resolved).toEqual({
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      downloadPath: '/api/ai-agent/sessions/session-1/artifacts/artifact-1/download',
      fileMissing: false,
    });
  });

  it('resolves artifact download by matching filePath suffix when originalName differs', () => {
    const lookup = buildFindingEvidenceArtifactLookup([
      {
        id: 'artifact-2',
        sessionId: 'session-2',
        originalName: 'mail_headers.txt',
        filePath: 's3://bucket/session-2/.artifacts/mail_headers.txt',
      },
    ]);

    const resolved = resolveFindingEvidenceArtifact(
      {
        sessionId: 'session-2',
        path: '.artifacts/mail_headers.txt',
        fileMissing: false,
      },
      lookup,
    );

    expect(resolved.artifactId).toBe('artifact-2');
    expect(resolved.fileMissing).toBe(false);
  });

  it('keeps excerpt-only state when no artifact is linked', () => {
    const lookup = buildFindingEvidenceArtifactLookup([]);
    const resolved = resolveFindingEvidenceArtifact(
      {
        sessionId: 'session-3',
        path: '.artifacts/missing.txt',
        fileMissing: true,
      },
      lookup,
    );

    expect(resolved).toEqual({
      sessionId: 'session-3',
      fileMissing: true,
    });
  });
});

